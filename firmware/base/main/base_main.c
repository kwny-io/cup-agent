/**
 * 底座固件入口 + 主循环(M6 最小 bring-up)。
 *
 * 这一刀要证明的与杯盖对称:**真底座的数据(称重+事件),后端一行不改就能收**。
 * 流程刻意走最短闭环:
 *   联网(Wi-Fi)→ 连 broker(先订 down + hello 握手)→ 采一帧称重 → 端侧判定 →
 *   按契约序列化 → 发 `dev/<id>/up` → 若后端捎回指令,收下并打日志。
 *
 * 与杯盖的两点结构差异:
 *   1. 判定层是 base_weight(状态机 OFF/SETTLING/RESTING),不是 lid_logic;
 *   2. 底座事件(drink/refill/off_base)量值来自**称重差**,故 amount_ml 由 ΔW 给出。
 *
 * 采样与上报同一任务(mqtt publish 入队即返回,不阻塞),bring-up 阶段少一层并发。
 *
 * 时间戳:联网后用 SNTP 拿 Unix 毫秒;失败退回自启动毫秒(契约只要求 ts 非负单调)。
 */
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "esp_log.h"
#include "esp_sntp.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include "base_weight.h"
#include "claim_store.h"
#include "cmd_exec.h"
#include "cmd_payload.h"
#include "cmd_store.h"
#include "command_parse.h"
#include "contract_dev.h"
#include "led_driver.h"
#include "led_pattern.h"
#include "ota_manifest.h"
#include "mqtt_uplink.h"
#include "weight_comp.h"
#include "weight_source.h"
#include "wifi_sta.h"

static const char *TAG = "base";

// ── 上报/样本缓冲 ─────────────────────────────────────────────────
static char s_frame[512];
static uint32_t s_seq = 0;

/** 运行时上报间隔(ms)。启动时由 NVS 续存值或 Kconfig 默认值初始化;config 指令可改。 */
static int32_t s_report_ms = 0;

/** 当前 Unix 毫秒;SNTP 未对时则退回"自启动毫秒"。 */
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
/** 底座事件:drink/refill 带 amount_ml(由 ΔW 给),其余不带。derived_by=base。 */
static void publish_event(event_type_t type, bool has_amount, float amount_ml) {
    cup_event_t e = {0};
    e.ts = now_unix_ms();
    e.type = type;
    e.has_amount = has_amount;
    e.amount_ml = amount_ml;
    e.confidence = 0.95f;              // 与模拟器 base.ts 一致
    e.derived_by = DERIVED_BY_BASE;

    int n = cup_event_to_envelope(&e, CONFIG_CUP_CUP_ID, CONFIG_CUP_DEVICE_ID,
                                  s_frame, sizeof(s_frame));
    if (n < 0) {
        ESP_LOGE(TAG, "事件序列化失败(缓冲不足)");
        return;
    }
    ESP_LOGI(TAG, "↑ event %s amount=%.1f", event_type_str(type), (double)amount_ml);
    if (!mqtt_uplink_publish(s_frame)) {
        ESP_LOGW(TAG, "事件发送失败(broker 未连?)");
    }
}

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
            // 契约 §5:remind.payload = { "text": "...", "led": "breath_blue" }。
            // led 是**字符串**(效果名),非整数 —— 早先用 cmd_payload_i64 读永远读不到。
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
static bool publish_telemetry(const weight_sample_t *s, const base_weight_out_t *w,
                              float raw_g) {
    base_telemetry_t t = {0};
    t.ts = now_unix_ms();
    t.seq = s_seq++;
    t.weight_g = w->weight_g;  // 补偿后重量
    t.stable = w->stable;
    t.present = w->present;
    t.temp_c = s->has_temp ? s->temp_c : 25.0f;
    t.battery_pct = s->has_battery ? s->battery_pct : 100;
    t.charging = s->charging;

    int n = base_telemetry_to_envelope(&t, CONFIG_CUP_DEVICE_ID, CONFIG_CUP_CUP_ID,
                                       s_frame, sizeof(s_frame));
    if (n < 0) {
        ESP_LOGE(TAG, "遥测序列化失败(缓冲不足)");
        return false;
    }
    // raw vs corrected 并列打印:T 升 → raw 漂 → corrected 稳,联调时一眼看出温补在干活。
    ESP_LOGI(TAG, "↑ base seq=%u weight=%.1fg(raw %.1f,T %.1f℃) present=%d stable=%d batt=%d%%",
             t.seq, (double)t.weight_g, (double)raw_g, (double)t.temp_c, (int)t.present,
             (int)t.stable, t.battery_pct);
    if (!mqtt_uplink_publish(s_frame)) {
        ESP_LOGW(TAG, "遥测未即时发出(broker 未连?)—— 已暂存,连上后补发");
        return false;
    }
    return true;
}

void app_main(void) {
    ESP_LOGI(TAG, "底座固件启动 —— device=%s cup=%s", CONFIG_CUP_DEVICE_ID,
             CONFIG_CUP_CUP_ID);

    // 上报间隔:NVS 续存值优先(上次 config 指令落的盘),否则 Kconfig 默认。
    if (cmd_store_init() && cmd_store_load_report_ms(&s_report_ms)) {
        ESP_LOGI(TAG, "上报间隔续存自 NVS:%" PRId32 " ms", s_report_ms);
    } else {
        s_report_ms = CONFIG_CUP_REPORT_MS;
        ESP_LOGI(TAG, "上报间隔用默认值:%" PRId32 " ms", s_report_ms);
    }

    weight_source_init();
    ESP_LOGI(TAG, "称重源:%s", weight_source_name());

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

    base_weight_t weight;
    base_weight_init(&weight);
    weight_comp_t comp;
    weight_comp_init(&comp);

    weight_sample_t s = {0};
    uint32_t last_report = 0;
    bool first_report = true;
    uint32_t t0 = xTaskGetTickCount() * portTICK_PERIOD_MS;

    while (true) {
        uint32_t now = xTaskGetTickCount() * portTICK_PERIOD_MS;
        uint32_t rel = now - t0;

        weight_source_read(&s, rel);
        if (!wifi_sta_connected() && mqtt_uplink_connected()) {
            ESP_LOGW(TAG, "Wi-Fi 掉线,等重连");
        }

        int batt = s.has_battery ? s.battery_pct : 100;
        float raw = s.has_weight ? s.weight_g : 0.0f;

        // 温漂补偿:先扣零点漂移,判定与上报都用**补偿后**重量(M6 验收 #2)。
        weight_comp_out_t c = weight_comp_step(&comp, raw, s.temp_c, rel);
        if (c.got_anchor) {
            ESP_LOGI(TAG, "温补:采到空座锚点 T=%.1f℃ raw=%.1fg → k=%.3f g/℃ calibrated=%d",
                     (double)s.temp_c, (double)raw, (double)c.k, (int)c.calibrated);
        }
        float corrected = c.corrected_g;

        base_weight_out_t out = base_weight_step(&weight, corrected, batt, rel);

        // 事件即时上报(drink/refill 带量;off_base/低电不带)
        if (out.emit_drink)      publish_event(EVENT_DRINK, true, out.drink_ml);
        if (out.emit_refill)     publish_event(EVENT_REFILL, true, out.refill_ml);
        if (out.emit_off_base)   publish_event(EVENT_OFF_BASE, false, 0);
        if (out.emit_low_battery) publish_event(EVENT_LOW_BATTERY, false, 0);

        // 常规档遥测按 CUP_REPORT_MS;首帧立刻发。发送失败的数据由 mqtt_uplink 暂存到
        // 上行缓存、连上后补发,故无论成败都推进 last_report(不再靠下帧重试造重复帧)。
        if (first_report || rel - last_report >= (uint32_t)s_report_ms) {
            publish_telemetry(&s, &out, raw);
            last_report = rel;
            first_report = false;
        }

        // 推进灯效(闪烁翻转 / 呼吸调占空 / 一次性灯效跑完自灭)。
        led_driver_tick(now);

        vTaskDelay(pdMS_TO_TICKS(CONFIG_CUP_SAMPLE_MS));
    }
}
