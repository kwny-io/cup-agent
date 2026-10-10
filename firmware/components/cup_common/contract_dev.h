/**
 * 杯盖侧 · 契约对齐层 —— 与 `packages/contract/src/schemas.ts` 的 §2/§4 字段**逐字对齐**。
 *
 * 为什么手写 JSON 不引 cJSON:字段少、形状固定,固件里 rssi/imu 又是可选,
 * 手写反而更短、更好读、零依赖。代价是**字段名必须一字不差** —— 故全部集中在本文件,
 * 改动只此一处(对应契约的核心价值:"字段名一字不差")。
 *
 * 单位/范围与常量取自 `packages/contract/src/constants.ts`(见下方 CUP_* 宏);
 * 后端用 zod 收包,越界会被拒收,所以这里序列化前先 clamp。
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// ── 契约常量(镜像 constants.ts 的 CUP;杯体几何)─────────────────
#define CUP_CAPACITY_ML 400
#define CUP_INNER_MM 130
#define CUP_TARE_G 285
#define CUP_G_PER_ML 1.0f
/** 400/130 ≈ 3.0769,与 constants.ts 的 ml_per_mm 一致。 */
#define CUP_ML_PER_MM ((float)CUP_CAPACITY_ML / (float)CUP_INNER_MM)

// ── 契约阈值(镜像 constants.ts 的 IMU_THRESH / ALERT;端侧判定用它)──
// §6.3 杯盖 IMU 判定
#define IMU_SHAKE_ENERGY_G 0.35f  // 加速度超出 1g 部分的模长阈值
#define IMU_SHAKE_FRAMES 8        // 连续超阈值帧数 → 判 shake
#define IMU_SHAKE_HOLD_MS 400     // 判 shake 后维持 motion=shake 的时间
#define IMU_TILT_DEG 35.0f        // 倾角超此值 → motion=tilt
// 拿起判定(**固件侧启发式;constants.ts 无对应常量 —— 契约未定义 lifted 的 IMU 判据**)。
// 真杯盖看不到底座的 present 位,只能从加速度反推:拿起瞬间竖直加速度降低(≈失重),
// 模长明显 <1g。作为模拟器 world.ts `setOnBase(false) → motion='lifted'` 的 IMU 等价物。
// **[待实测]** 阈值是离线估的:真手托着/悬停时可能读出 ~1g(而非 <0.8g),上真板后需按
// 实测标定 0.8f / 200ms 这两个数(甚至改为"变化率"判据)。优先级 shake>lifted 已与后端
// eyes.ts 的 startled>look 对齐,勿翻。
#define IMU_LIFTED_MAG_G 0.8f     // 加速度模长持续低于此 → motion=lifted
#define IMU_LIFTED_MS 200         // 低模长需持续此时长才判 lifted(去抖;滤掉放下/噪声的瞬时低模长)
// §6.4 报警
#define ALERT_TEMP_HOT_C 65.0f    // 水温超此值 → temp_alert
#define ALERT_TEMP_COLD_C 5.0f    // 水温低于此值 → temp_alert
#define ALERT_TEMP_HYST_C 3.0f    // 滞回:报警后回落到 (阈值∓3) 才复位
#define ALERT_TILT_ALERT_MS 2000  // 持续倾倒超此时间 → tilt_alert
#define ALERT_BATTERY_LOW_PCT 15  // 电量低于此 → low_battery
#define ALERT_BATTERY_RESET_PCT 20 // 回升到此才复位(滞回)

// ── 契约常量(镜像 constants.ts 的 SCALE;底座称重判定用它)────────
// §6.2 底座 · 称重
#define SCALE_SETTLE_WINDOW_MS 800  // 稳定窗口:窗口内标准差 < 阈值 → stable
#define SCALE_SETTLE_STD_G 1.5f     // 窗口内标准差阈值
#define SCALE_PRESENT_MIN_G 50.0f   // 重量低于此 → present=false(杯子拿走)
#define SCALE_DRINK_MIN_G 30.0f     // |ΔW| 超此值才算 drink/refill 事件(≈30ml)
#define SCALE_DRINK_MIN_ML 30
#define SCALE_OFF_BASE_DELAY_MS 120000  // 离座超此时间才发 off_base(短暂拿起不算)

// ── §2 枚举 ──────────────────────────────────────────────────────
/** motion 状态;序列化出的字符串必须与 MOTION_STATES 逐字一致。 */
typedef enum {
    MOTION_IDLE = 0,
    MOTION_TILT,
    MOTION_SHAKE,
    MOTION_LIFTED,
} motion_state_t;

/** 事件类型;必须与 EVENT_TYPES 逐字一致。 */
typedef enum {
    EVENT_DRINK = 0,
    EVENT_REFILL,
    EVENT_SHAKE,
    EVENT_TEMP_ALERT,
    EVENT_TILT_ALERT,
    EVENT_LOW_BATTERY,
    EVENT_OFF_BASE,
} event_type_t;

/** 谁算出来的;必须与 DERIVED_BY 逐字一致。 */
typedef enum {
    DERIVED_BY_BASE = 0,
    DERIVED_BY_LID,
    DERIVED_BY_BACKEND,
} derived_by_t;

/** 实时档 IMU 六轴(ax/ay/az 单位 g;gx/gy/gz 单位 °/s)。 */
typedef struct {
    float ax, ay, az;
    float gx, gy, gz;
} imu_t;

// ── §2 上行 · 杯盖遥测 ────────────────────────────────────────────
/**
 * 一帧 lid 遥测。字段与 LidTelemetrySchema 一一对应;
 * `has_imu` / `has_rssi` 控制可选字段是否出现在 JSON 里
 * (契约:imu **仅实时档携带**;rssi 可省)。
 */
typedef struct {
    uint64_t ts;          // Unix 毫秒 —— 必须 64 位!13 位数,uint32 会截断成 1970 年
    uint32_t seq;         // 设备内单调递增,不重复(后端按 (device_id,seq) 去重)
    uint32_t sample_ms;   // 本帧采样周期,>0
    float temp_c;         // -10..120
    float level_mm;       // 0..999(schema 上界;实现侧 clamp 到 CUP_INNER_MM)
    int level_pct;        // 0..100
    motion_state_t motion;
    float tilt_deg;       // 0..180
    int tilt_dir;         // 0..359
    int battery_pct;      // 0..100
    bool charging;

    int rssi;             // dBm,负值(真机由通信层用 esp_wifi_sta_get_ap_info 填;
                          // 合成源/无 WiFi 时填 sane 默认,序列化时按范围钳掉)

    bool has_imu;         // 实时档才置 true
    imu_t imu;
} lid_telemetry_t;

// ── §3 上行 · 底座遥测 ────────────────────────────────────────────
/**
 * 一帧 base 遥测。字段与 BaseTelemetrySchema 一一对应。
 * 底座**没有** imu/rssi 可选字段(schema 里就没有);weight_g 是总重(含皮重)。
 */
typedef struct {
    uint64_t ts;        // Unix 毫秒(同 lid,必须 64 位)
    uint32_t seq;
    float weight_g;     // 总重(皮重 + 水重),schema 上界 2000
    bool stable;        // 窗口内已稳定
    bool present;       // 杯在座上
    float temp_c;       // 底座内部温度(温补用)
    bool charging;
    int battery_pct;
} base_telemetry_t;

// ── §4 上行 · 事件 ────────────────────────────────────────────────
/**
 * 一个事件。`amount_ml` 只在 drink/refill 时有效(契约 .refine:
 * amount_ml 必须且仅在 drink/refill 时携带);序列化时按 type 自动取舍。
 */
typedef struct {
    uint64_t ts;          // Unix 毫秒(同 lid,必须 64 位)
    event_type_t type;
    bool has_amount;      // drink/refill 必为 true,其余必须 false
    float amount_ml;
    bool has_temp;        // temp_alert 时可带
    float temp_c;
    float confidence;     // 0..1
    derived_by_t derived_by;
} cup_event_t;

/**
 * 把一帧 lid 遥测序列化成**上行信封**
 *   {"kind":"lid","payload":{ v, device_id, cup_id, ts, seq, sample_ms, temp_c, ... }}
 * device_id / cup_id 由 `device_id` / `cup_id` 参数给入(来自 menuconfig)。
 *
 * @param t          遥测
 * @param device_id  本设备 id(形如 lid-XXXXXX)
 * @param cup_id     逻辑杯 id(形如 cup-XXXXXX)
 * @param out        输出缓冲
 * @param out_size   缓冲大小;需留足余量(实测一帧远小于 256 字节)
 * @return 写入的字符数(不含结尾 NUL);<0 表示缓冲不足或参数非法。
 */
int lid_telemetry_to_envelope(const lid_telemetry_t *t, const char *device_id,
                              const char *cup_id, char *out, size_t out_size);

/**
 * 把一帧 base 遥测序列化成 {"kind":"base","payload":{...}}(字段对齐 §3)。
 * @return 写入字符数;<0 表示缓冲不足或参数非法。
 */
int base_telemetry_to_envelope(const base_telemetry_t *t, const char *device_id,
                               const char *cup_id, char *out, size_t out_size);

/**
 * 把一个事件序列化成上行信封 {"kind":"event","payload":{...}}。
 * derived_by 由 `derived_by_device_id` 决定(形如 lid-XXXXXX / base-XXXXXX)。
 * @return 写入字符数;<0 表示缓冲不足或参数非法。
 */
int cup_event_to_envelope(const cup_event_t *e, const char *cup_id,
                          const char *derived_by_device_id, char *out, size_t out_size);

// ── 换算助手(镜像 constants.ts 的同名函数)────────────────────────

/** 水体积(ml)→ 液位高度(mm),clamp [0, CUP_INNER_MM]。 */
float ml_to_level_mm(float ml);

/** 水体积(ml)→ 满杯百分比(整数),clamp [0, 100]。 */
int ml_to_level_pct(float ml);

/** 总重(g)→ 净水体积(ml),下界截到 0。 */
float volume_ml_from_weight(float weight_g);

/** 总重(g)→ 满杯百分比(整数)。 */
int level_pct_from_weight(float weight_g);

// 枚举 → 契约字符串(供序列化;也便于单测断言)。
const char *motion_state_str(motion_state_t m);
const char *event_type_str(event_type_t t);
const char *derived_by_str(derived_by_t d);

#ifdef __cplusplus
}
#endif
