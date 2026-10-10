/**
 * 杯盖 · 端侧判定逻辑(纯 C,零 IDF 依赖)—— 固件必须自己实现的那部分。
 *
 * 为什么要这层:探查确认**所有判定都在设备端闭环**(后端只收遥测/事件),
 * 而后端用契约的 UpstreamFrameSchema 校验,事件类型/数值越界会被拒收。
 * 所以 shake/tilt/温度/电量 的判定**必须**按 constants.ts 的阈值在固件里复刻。
 *
 * 抽成零依赖纯 C 的另一个理由:**可测**。本机有 mingw gcc,不必等真板、不必装 ESP-IDF,
 * 就能把边界/滞回全跑绿(见 host_test/test_lid_logic.c)。真板上的逻辑与此逐字一致。
 *
 * 阈值全部来自 contract_dev.h 的 IMU_* / ALERT_* 宏(=镜像 constants.ts)。
 */
#pragma once

#include "contract_dev.h"

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** 判定状态(调用方持有;lid_logic_init 清零)。 */
typedef struct {
    uint32_t shake_frames;    // 连续超过能量阈值的帧数
    uint32_t shake_until_ms;  // motion=shake 维持到的时刻(hold 窗)
    bool shaking_latched;     // 已在 shake hold 窗内(用于事件的上升沿判定)
    bool tilting;             // 当前是否倾倒姿态
    uint32_t tilt_since_ms;   // 本次倾倒起始时刻
    bool tilt_alerted;        // 本次倾倒是否已发过 tilt_alert
    bool temp_alerted;        // 温度报警滞回锁存
    bool low_batt_alerted;    // 低电量滞回锁存
    bool lifting;             // 当前加速度模长是否持续偏低(判 lifted 的去抖)
    uint32_t lift_since_ms;   // 本次低模长起始时刻
} lid_logic_t;

/** 本帧输入(从传感器读到的原始量)。 */
typedef struct {
    float temp_c;
    float ax, ay, az;   // 加速度(g),用于 shake 能量
    float tilt_deg;     // 倾角
    int battery_pct;
} lid_logic_in_t;

/** 本帧输出:合成的 motion 状态 + 本帧要不要各发一个事件。 */
typedef struct {
    motion_state_t motion;
    bool emit_shake;        // 上升沿:首次判到 shake
    bool emit_tilt_alert;   // 倾倒持续够久
    bool emit_temp_alert;   // 温度越界(带滞回)
    bool emit_low_battery;  // 电量过低(带滞回)
} lid_logic_out_t;

void lid_logic_init(lid_logic_t *st);

/**
 * 推进一帧判定。`now_ms` 是单调递增的本机毫秒(仅用于 400ms/2000ms 窗口,
 * 与 Unix 时间无关)。纯函数式:除 st 外无副作用,便于单测。
 */
lid_logic_out_t lid_logic_step(lid_logic_t *st, const lid_logic_in_t *in, uint32_t now_ms);

/** 加速度模长超出 1g 的部分(契约:shake 能量定义)。公开供单测。 */
float lid_shake_energy(float ax, float ay, float az);

#ifdef __cplusplus
}
#endif
