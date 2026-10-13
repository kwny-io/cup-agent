/**
 * 杯盖固件入口 + 主循环(M5 最小 bring-up)。
 *
 * 这一刀要证明的只有一件事:**真杯盖的数据,后端一行不改就能收**。
 * 于是流程刻意走最短闭环:
 *   联网(Wi-Fi)→ 连 broker(先订 down + hello 握手)→ 采一帧 → 端侧判定 →
 *   按契约序列化 → 发 `dev/<id>/up` → 若后端捎回指令,收下并打日志。
 *
 * 采样与上报**同一个任务**:esp_mqtt_client_publish 是入队即返回(不阻塞),
 * 故无需第二任务/队列 —— bring-up 阶段少一层并发就少一类竞态。将来采样率提上去
 * (实时档 40Hz)再拆任务不迟。
 *
 * 时间戳:联网后用 SNTP 对时拿 Unix 毫秒;对时失败则退回"自启动起算的毫秒"
 * (契约只要求 ts 非负、单调,不要求一定是墙钟;但墙钟才能和软件线数据对齐)。
 */
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "esp_log.h"
#include "esp_sntp.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include "celebr.h"
#include "claim_store.h"
#include "cmd_exec.h"
#include "cmd_payload.h"
#include "cmd_store.h"
#include "command_parse.h"
#include "contract_dev.h"
#include "eye_state.h"
#include "face_display.h"
#include "led_driver.h"
#include "led_pattern.h"
#include "ota_manifest.h"
#include "level_filter.h"
#include "lid_logic.h"
#include "mqtt_uplink.h"
#include "realtime.h"
#include "sensor_source.h"
#include "wifi_sta.h"

static const char *TAG = "lid";

// ── 上报/样本缓冲 ─────────────────────────────────────────────────
static char s_frame[512];

static uint32_t s_seq = 0;

/** 运行时上报间隔(ms)。启动时由 NVS 续存值或 Kconfig 默认值初始化;config 指令可改。 */
static int32_t s_report_ms = 0;

/** 当前 Unix 毫秒;SNTP 未对时则退回"自启动毫秒"(契约只要求 ts 非负、单调)。 */
static uint64_t now_unix_ms(void) {
    time_t sec = time(NULL);
    if (sec > 1600000000) {  // 已对时(>2020 年)
        return (uint64_t)sec * 1000ull;
    }
    return (uint64_t)xTaskGetTickCount() * portTICK_PERIOD_MS;
}

static void sntp_start(void) {
    esp_sntp_setoperatingmode(ESP_SNTP_OPMODE_POLL);
    esp_sntp_setservername(0, "pool.ntp.org");
    esp_sntp_init();
}

/** SNTP 对时(最多等 ~5s);返回是否成功。 */
static bool sntp_wait(void) {
    for (int i = 0; i < 50; i++) {
        time_t sec = time(NULL);
        if (sec > 1600000000) {
            ESP_LOGI(TAG, "SNTP 对时成功");
            return true;
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    ESP_LOGW(TAG, "SNTP 未对时,ts 退回启动毫秒");
    return false;
}

// ── 事件上报 ──────────────────────────────────────────────────────
static void publish_event(event_type_t type, bool has_amount, float amount_ml,
                          bool has_temp, float temp_c, bool has_duration, int duration_ms) {
    cup_event_t e = {0};
    e.ts = now_unix_ms();
    e.type = type;
    e.has_amount = has_amount;
    e.amount_ml = amount_ml;
    e.has_temp = has_temp;
    e.temp_c = temp_c;
    e.has_duration = has_duration;
    e.duration_ms = duration_ms;
    e.confidence = 0.9f;
    e.derived_by = DERIVED_BY_LID;

    int n = cup_event_to_envelope(&e, CONFIG_CUP_CUP_ID, CONFIG_CUP_DEVICE_ID,
                                  s_frame, sizeof(s_frame));
    if (n < 0) {
        ESP_LOGE(TAG, "事件序列化失败(缓冲不足)");
        return;
    }
    ESP_LOGI(TAG, "↑ event %s", event_type_str(type));
    if (!mqtt_uplink_publish(s_frame)) {
        ESP_LOGW(TAG, "事件发送失败(broker 未连?)");
    }
}

// 主循环侧:投递一次强制表情(成长庆祝用,实现见下方硬件脸段)。下行 remind 命中
// 里程碑时经它把"摆什么脸"交给脸任务 —— 先声明,避免在此处触碰 s_eyes。
static void face_post_expression(eye_state_t state, float seconds);

// ── 下行指令处理:真执行(sync_time 对时 / config 改上报间隔 / remind 记日志)──
static void on_command(const char *raw_json, const char *cmd_id, int type,
                       uint64_t expires_at) {
    ESP_LOGI(TAG, "↓ cmd %s type=%s expires_at=%" PRIu64, cmd_id,
             cmd_type_str((cmd_type_t)type), expires_at);

    switch ((cmd_type_t)type) {
        case CMD_TYPE_SYNC_TIME: {
            int64_t server_ms = 0;
            if (!cmd_payload_i64(raw_json, cmd_id, "server_ts", &server_ms) ||
                server_ms <= 1600000000LL * 1000LL) {
                ESP_LOGW(TAG, "sync_time:server_ts 缺失或不 sane(%" PRId64 "),忽略", server_ms);
                break;
            }
            struct timeval tv = {.tv_sec = (time_t)(server_ms / 1000),
                                 .tv_usec = (suseconds_t)((server_ms % 1000) * 1000)};
            if (settimeofday(&tv, NULL) == 0) {
                ESP_LOGI(TAG, "sync_time:已对时 → %" PRId64 " ms", server_ms);
            } else {
                ESP_LOGW(TAG, "sync_time:settimeofday 失败");
            }
            break;
        }
        case CMD_TYPE_CONFIG: {
            int64_t raw_ms = 0;
            if (!cmd_payload_i64(raw_json, cmd_id, "report_ms", &raw_ms)) {
                ESP_LOGD(TAG, "config:本刀只认 report_ms,其余键忽略");
                break;
            }
            int v = cmd_exec_clamp_report_ms(raw_ms);
            if (v <= 0) {
                ESP_LOGW(TAG, "config:report_ms=%" PRId64 " 非法,保持 %" PRId32, raw_ms,
                         s_report_ms);
                break;
            }
            s_report_ms = v;
            bool saved = cmd_store_save_report_ms(v);
            ESP_LOGI(TAG, "config:report_ms=%d 生效(%s)", v, saved ? "已存 NVS" : "NVS 写失败");
            break;
        }
        case CMD_TYPE_REMIND: {
            // 先认"成长庆祝":后端在用户今天新跨里程碑时旁挂一条 remind(reason=milestone)。
            // 判定在**后端**,端侧只负责"把这条提醒摆成庆祝脸 + 庆祝灯"(celebr 纯 C 决定)。
            // 命中 → 走庆祝路径;否则落回下面的普通 text/led remind。
            celebr_plan_t cp;
            if (celebr_plan(raw_json, cmd_id, &cp)) {
                face_post_expression(cp.eye, cp.eye_seconds);
                led_driver_play(&cp.led);
                ESP_LOGI(TAG, "remind:庆祝! id=%s label=%s → eye=%d %.1fs led=%s",
                         cp.id[0] ? cp.id : "(无)", cp.label[0] ? cp.label : "(无)",
                         (int)cp.eye, (double)cp.eye_seconds, led_effect_str(cp.led.effect));
                break;
            }
            // 契约 §5:remind.payload = { "text": "...", "led": "breath_blue" }。
            // 注意 led 是**字符串**(效果名),不是整数 —— 早先这里用 cmd_payload_i64 读,
            // 永远读不到(类型不符),等于把 led 丢了。改用 cmd_payload_str。
            char text[64] = {0};
            char led[24] = {0};
            bool has_text = cmd_payload_str(raw_json, cmd_id, "text", text, sizeof(text));
            bool has_led = cmd_payload_str(raw_json, cmd_id, "led", led, sizeof(led));
            led_pattern_t p = led_pattern_from_remind(has_led ? led : NULL, has_text);
            led_driver_play(&p);
            ESP_LOGI(TAG, "remind:%s led=%s → %s(color=%s)", has_text ? text : "(无文本)",
                     has_led ? led : "(无)", led_effect_str(p.effect), led_color_str(p.color));
            break;
        }
        case CMD_TYPE_OTA: {
            // 半截就绪:manifest 的解析/校验是纯 C 已钉死;下载 + esp_https_ota + 分区待真板。
            // 校验不过就整齐回落(不下载),立场同 remind 未知名不点亮。
            ota_manifest_t m;
            if (!ota_manifest_parse(raw_json, cmd_id, &m)) {
                ESP_LOGW(TAG, "ota:manifest 非法,忽略");
                break;
            }
            ESP_LOGI(TAG, "ota:manifest ok(url=%s size=%" PRId64 " sha256=%.8s…)——下载/校验/分区为 IDF 半,待真板",
                     m.url, m.size, m.sha256);
            break;
        }
        default:
            ESP_LOGW(TAG, "未知 type=%d,忽略", type);
            break;
    }
}

// ── 遥测上报 ──────────────────────────────────────────────────────
// level_mm 传**滤波后**值(见 level_filter):ToF 原始读数带水面波动,直接上报会抖成锯齿。
static bool publish_telemetry(const sensor_sample_t *s, motion_state_t motion, float level_mm,
                              bool realtime) {
    lid_telemetry_t t = {0};
    t.ts = now_unix_ms();
    t.seq = s_seq++;
    t.sample_ms = realtime ? REALTIME_SAMPLE_MS : CONFIG_CUP_SAMPLE_MS;

    t.temp_c = s->has_temp ? s->temp_c : 25.0f;
    t.level_mm = s->has_level ? level_mm : 0.0f;
    t.level_pct = s->has_level ? (int)(level_mm / 130.0f * 100.0f + 0.5f) : 0;
    t.motion = motion;
    t.tilt_deg = s->has_tilt ? s->tilt_deg : 0.0f;
    t.tilt_dir = s->has_tilt ? s->tilt_dir : 0;
    t.battery_pct = s->has_battery ? s->battery_pct : 100;
    t.charging = s->charging;

    // IMU:契约规定 imu **仅实时档携带**。实时档由 realtime 模块决定(晃动/App 请求触发)。
    t.has_imu = realtime && s->has_imu;
    if (t.has_imu) {
        t.imu.ax = s->ax; t.imu.ay = s->ay; t.imu.az = s->az;
        t.imu.gx = s->gx; t.imu.gy = s->gy; t.imu.gz = s->gz;
    }
    // rssi:真机上网后由 WiFi 层给;未连上/合成时为 0,序列化会自动省略。
    t.rssi = wifi_sta_rssi();

    int n = lid_telemetry_to_envelope(&t, CONFIG_CUP_DEVICE_ID, CONFIG_CUP_CUP_ID,
                                      s_frame, sizeof(s_frame));
    if (n < 0) {
        ESP_LOGE(TAG, "遥测序列化失败(缓冲不足)");
        return false;
    }
    ESP_LOGI(TAG, "↑ lid seq=%u motion=%s batt=%d%% temp=%.1f", t.seq,
             motion_state_str(motion), t.battery_pct, (double)t.temp_c);
    if (!mqtt_uplink_publish(s_frame)) {
        ESP_LOGW(TAG, "遥测未即时发出(broker 未连?)—— 已暂存,连上后补发");
        return false;
    }
    return true;
}

// ── 硬件脸(双形体人格的硬件半边)──────────────────────────────────
// 眼睛状态机(eye_state,纯 C)在杯盖本地按固定帧率推进,结果经 face_display
// **只推脏行**给 Memory LCD(备忘 §2:局部刷新才有 62 天续航)。
//
// 输入从哪来:主循环每轮把"该长什么样"的快照写进 s_eye_in;脸任务只读它喂 eyes_step。
// 用一把小锁交换(结构小、临界区极短),避免 1Hz~40Hz 主循环与 20Hz 脸任务读到半帧。
//
// owner(谁持脸)本 bring-up **恒为盖**:App 会话/交接通道尚未落地(见 realtime 的
// rt_request 现也写死 false)—— 真板接上 App 后由"谁在前台"翻转成 SCREEN,盖子即
// 按 §1.3 平滑闭眼。forgot_sec 同理:现用"距上次下行/动作"当代理,真板接 App 活跃度后替换。
#define FACE_TASK_HZ 20
#define FACE_FRAME_MS (1000 / FACE_TASK_HZ)

static eye_eyes_t      s_eyes;                 // 仅脸任务触碰(状态机实例)
static eye_inputs_t    s_eye_in;               // 主循环写、脸任务读 → 加锁
static bool            s_eye_drink_pulse;      // 主循环置"喝了一口",脸任务消费并清 → 同锁
static int             s_eye_expr_state;       // 主循环置"强制表情"(eye_state_t),-1 = 无 → 同锁
static float           s_eye_expr_sec;         // 强制表情持续秒数
static SemaphoreHandle_t s_eye_lock;
static volatile uint32_t s_eye_idle_ms = 0;    // 上次"有事"的本机毫秒(算 idle_sec)
static volatile uint32_t s_eye_forgot_ms = 0;  // 上次下行/动作的本机毫秒(算 forgot_sec)

/**
 * 主循环侧:更新脸输入快照 + 可选"喝了一口"脉冲(带锁;非阻塞取锁,拿不到就跳过本帧,脸不卡)。
 * 注意:眼睛实例 s_eyes **只归脸任务**;主循环绝不直接调 eyes_*(否则跨任务竞争)。
 * 事件(喝水)经这个脉冲端口传过去,由脸任务在 step 前应用。
 */
static void face_post_inputs(const eye_inputs_t *in, bool drink_pulse) {
    if (s_eye_lock && xSemaphoreTake(s_eye_lock, 0) == pdTRUE) {
        s_eye_in = *in;
        if (drink_pulse) s_eye_drink_pulse = true;
        xSemaphoreGive(s_eye_lock);
    }
}

/**
 * 主循环侧:投递一次**强制表情**(成长庆祝用;手势/庆祝都经这个口)。
 * 只置脉冲,真正调用 eyes_note_expression 由脸任务在 step 前做(避免跨任务碰 s_eyes)。
 * @param state    eye_state_t(如 EYE_CONTENT / EYE_SMUG)
 * @param seconds  持续秒数;<=0 → 用默认庆祝时长
 */
static void face_post_expression(eye_state_t state, float seconds) {
    if (s_eye_lock && xSemaphoreTake(s_eye_lock, 0) == pdTRUE) {
        s_eye_expr_state = (int)state;
        s_eye_expr_sec = seconds > 0.0f ? seconds : CELEBR_EYE_S_DEFAULT;
        xSemaphoreGive(s_eye_lock);
    }
}

/** 脸任务:按固定帧率推进眼睛状态机,并按脏行推屏。 */
static void face_task(void *arg) {
    (void)arg;
    eyes_init(&s_eyes);
    const float dt = 1.0f / (float)FACE_TASK_HZ;
    while (true) {
        vTaskDelay(pdMS_TO_TICKS(FACE_FRAME_MS));
        uint32_t now = xTaskGetTickCount() * portTICK_PERIOD_MS;

        eye_inputs_t in;
        bool drink = false;
        int  expr = -1;
        float expr_sec = 0.0f;
        if (s_eye_lock && xSemaphoreTake(s_eye_lock, portMAX_DELAY) == pdTRUE) {
            in = s_eye_in;
            drink = s_eye_drink_pulse;
            s_eye_drink_pulse = false;
            expr = s_eye_expr_state;
            expr_sec = s_eye_expr_sec;
            s_eye_expr_state = -1;
            xSemaphoreGive(s_eye_lock);
        } else {
            in = eye_inputs_default();
        }
        in.idle_sec   = (float)(now - s_eye_idle_ms) / 1000.0f;
        in.forgot_sec = (float)(now - s_eye_forgot_ms) / 1000.0f;

        if (drink) eyes_note_drink(&s_eyes);   // 在 step 前应用,避免跨任务触碰 s_eyes
        if (expr >= 0) eyes_note_expression(&s_eyes, (eye_state_t)expr, expr_sec);
        const eye_pose_t *pose = eyes_step(&s_eyes, dt, &in);
        face_display_show(pose);
    }
}

void app_main(void) {
    ESP_LOGI(TAG, "杯盖固件启动 —— device=%s cup=%s", CONFIG_CUP_DEVICE_ID,
             CONFIG_CUP_CUP_ID);

    // 上报间隔:NVS 续存值优先(上次 config 指令落的盘),否则 Kconfig 默认。
    if (cmd_store_init() && cmd_store_load_report_ms(&s_report_ms)) {
        ESP_LOGI(TAG, "上报间隔续存自 NVS:%" PRId32 " ms", s_report_ms);
    } else {
        s_report_ms = CONFIG_CUP_REPORT_MS;
        ESP_LOGI(TAG, "上报间隔用默认值:%" PRId32 " ms", s_report_ms);
    }

    sensor_source_init();
    ESP_LOGI(TAG, "传感源:%s", sensor_source_name());

    // 联网上线:开了 CUP_USE_BLE_PROV 且 NVS 无凭据时,这里会先阻塞等 BLE 配网。
    if (!wifi_bringup()) {
        ESP_LOGE(TAG, "Wi-Fi 未连上,固件继续跑但无法上行;检查 menuconfig / 配网");
    } else {
        sntp_start();
        sntp_wait();
    }
    // 可信绑定设备端半:发/沿用一次性 claim code(须在 SNTP 后 —— issued_at 要真墙钟)。
    claim_bringup(now_unix_ms());

    mqtt_uplink_start(on_command);

    if (!led_driver_init()) {
        ESP_LOGW(TAG, "LED 驱动初始化失败,remind 点灯不可用(其余功能不受影响)");
    }

    // 硬件脸:起手先给一份默认输入并建锁,再起脸任务(固定帧率推进眼睛 + 局部刷屏)。
    uint32_t boot_ms = xTaskGetTickCount() * portTICK_PERIOD_MS;
    s_eye_in = eye_inputs_default();
    s_eye_idle_ms = boot_ms;
    s_eye_forgot_ms = boot_ms;
    s_eye_lock = xSemaphoreCreateMutex();
    face_display_init();
    xTaskCreate(face_task, "face", 4096, NULL, 4, NULL);

    lid_logic_t logic;
    lid_logic_init(&logic);
    level_filter_t lvl;
    level_filter_init(&lvl);
    realtime_t rt;
    realtime_init(&rt);

    lid_logic_in_t in = {0};
    sensor_sample_t s = {0};
    // 首帧立即上报:否则 bring-up 验收要干等 5 分钟才看到第一条遥测。
    uint32_t last_report = 0;
    bool first_report = true;
    uint32_t t0 = xTaskGetTickCount() * portTICK_PERIOD_MS;

    while (true) {
        uint32_t now = xTaskGetTickCount() * portTICK_PERIOD_MS;
        uint32_t rel = now - t0;  // 相对启动毫秒,驱动合成波形与判定窗口

        sensor_source_read(&s, rel);
        if (!wifi_sta_connected() && mqtt_uplink_connected()) {
            // 说明刚断网;esp-mqtt 会自己重连,这里只记一条
            ESP_LOGW(TAG, "Wi-Fi 掉线,等重连");
        }

        in.temp_c = s.has_temp ? s.temp_c : 25.0f;
        in.ax = s.ax; in.ay = s.ay; in.az = s.az;
        in.tilt_deg = s.has_tilt ? s.tilt_deg : 0.0f;
        in.battery_pct = s.has_battery ? s.battery_pct : 100;
        in.press_g = s.has_press ? s.press_g : 0.0f;  // 未接压力传感器 → 0(永不判手势)

        lid_logic_out_t out = lid_logic_step(&logic, &in, rel);

        // 实时档决策:晃动(英雄功能——摇杯画面即同步)或 App 请求 → 40Hz 带 imu;
        // 保持窗过后回落常规档省电(架构 §3.3)。
        realtime_out_t rtu = realtime_step(&rt, false, out.motion == MOTION_SHAKE, rel);

        // ToF 液位滤波:晃动/倾倒时水面在动 → 重平滑;静止档跟得住真实喝水(架构 §4.2 / R2)。
        bool noisy = (out.motion == MOTION_SHAKE || out.motion == MOTION_TILT ||
                      out.motion == MOTION_LIFTED);
        float level_mm = s.has_level
                             ? level_filter_step(&lvl, s.level_mm, noisy, rel).level_mm
                             : 0.0f;

        // ── 硬件脸:把本帧遥测喂给眼睛状态机(脸任务读快照推进)──────────
        // owner 本 bring-up 恒为盖(App 交接通道未落地);disposition 亦恒 NORMAL
        // (长期性格由后端战报给,接 MQTT 下行后替换)。故这里只喂**本地物理量**。
        {
            eye_inputs_t ei = eye_inputs_default();
            ei.owner = EYE_OWNER_LID;
            ei.motion = out.motion;
            ei.tilt_deg = in.tilt_deg;
            ei.tilt_dir = s.has_tilt ? (float)s.tilt_dir : 0.0f;
            ei.battery_pct = s.has_battery ? s.battery_pct : EYE_PCT_NONE;
            ei.charging = s.charging;
            ei.level01 = s.has_level ? (level_mm / (float)CUP_INNER_MM) : 1.0f;
            ei.temp_c = s.has_temp ? s.temp_c : NAN;

            // 喝水(水位掉档 ≥2%)→ 眼睛"喝一口满足"(与契约 drink 事件同源阈值)。
            bool drank = false;
            static float prev_pct = -1.0f;
            if (s.has_level) {
                float pct = level_mm / (float)CUP_INNER_MM;
                if (prev_pct >= 0.0f && prev_pct - pct >= 0.02f) drank = true;
                prev_pct = pct;
            }
            if (drank) s_eye_idle_ms = now;                    // 有动作 → 重置打盹计时
            if (out.motion != MOTION_IDLE) s_eye_idle_ms = now;
            face_post_inputs(&ei, drank);
        }

        // 事件即时上报(时间敏感,不等常规档)
        if (out.emit_shake) publish_event(EVENT_SHAKE, false, 0, false, 0, false, 0);
        if (out.emit_tilt_alert) publish_event(EVENT_TILT_ALERT, false, 0, false, 0, false, 0);
        if (out.emit_temp_alert) publish_event(EVENT_TEMP_ALERT, false, 0, true, in.temp_c, false, 0);
        if (out.emit_low_battery) publish_event(EVENT_LOW_BATTERY, false, 0, false, 0, false, 0);
        // 手势(轻磕/长按 → 确认):松手时由 lid_logic 按接触时长分类发出,带 duration_ms。
        if (out.emit_gesture) {
            publish_event(out.gesture_type, false, 0, false, 0, true, out.gesture_duration_ms);
        }

        // 常规档遥测按 CUP_REPORT_MS 上报;首帧立刻发一次。
        // 发失败(broker 未连)不推进 last_report,故下个采样周期自动重试,
        // 直到真正发出 —— 这也让"刚启动、esp-mqtt 还没连上 broker"时不会白等 5 分钟。
        if (first_report || rel - last_report >= (uint32_t)s_report_ms) {
            // 发送失败不再靠"下帧重试"(那会重复造帧)——数据已被 mqtt_uplink 暂存到
            // 上行缓存,连上后自动补发(见 uplink_buffer),故无论成败都推进 last_report。
            publish_telemetry(&s, out.motion, level_mm, rtu.realtime);
            last_report = rel;
            first_report = false;
        }

        // 推进灯效(闪烁翻转 / 呼吸调占空 / 一次性灯效跑完自灭)。用本轮 now。
        led_driver_tick(now);

        // 采样周期:实时档 25ms(40Hz),常规档 CUP_SAMPLE_MS(见 realtime 模块)。
        vTaskDelay(pdMS_TO_TICKS(rtu.sample_ms));
    }
}
