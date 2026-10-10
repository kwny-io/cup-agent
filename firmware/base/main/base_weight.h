/**
 * 底座 · 称重判定(纯 C,零 IDF 依赖)—— 固件必须自己实现的那部分。
 *
 * 为什么这层必须存在:后端只收遥测/事件,drink/refill/off_base 的判定**在端侧闭环**
 * (见 simulator 的 sensors/base.ts 与契约 §6.2)。后端用契约校验,事件越界会被拒收,
 * 所以阈值/窗口/延迟必须在固件里按 constants.ts 的 SCALE 复刻。
 *
 * 状态机(镜像 simulator/sensors/base.ts 的 BaseSensor):
 *   OFF_BASE   杯不在座上(present=false)
 *   SETTLING   杯在座上但还没稳(等 settle_window_ms)
 *   RESTING(W) 已稳定,记住基准重量 W
 *
 *   RESTING(W1) ──重量→0──► OFF_BASE ──重量↑──► SETTLING ──稳定──► RESTING(W2)
 *   RESTING(W2): W2 < W1−阈值 → drink ; W2 > W1+阈值 → refill ; 否则无事件
 *
 * 与模拟器的**两点差异**(都在真固件里必须做、模拟器可省):
 *   1. 稳定判定用"窗口内标准差 < settle_std_g"(模拟器直接等 800ms);
 *   2. off_base 有 off_base_delay_ms(120s)延迟 —— 短暂拿起(喝一口)不算"带走了"。
 *
 * 抽成零依赖纯 C 的另一个理由:可测(见 host_test/test_base_weight.c)。
 * 真板逻辑与此逐字一致。
 */
#pragma once

#include "contract_dev.h"

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** 稳定判定的滑动窗口长度(样本数)。窗口内标准差 < SCALE_SETTLE_STD_G 即 stable。 */
#define BASE_STD_WINDOW 8

typedef enum {
    BASE_OFF = 0,   // 杯不在座上
    BASE_SETTLING,  // 在座上,未稳
    BASE_RESTING,   // 在座上,已稳(has 基准重量)
} base_state_t;

/** 判定状态(调用方持有;base_weight_init 清零)。 */
typedef struct {
    base_state_t state;
    float resting_weight_g;   // 上次稳定时的基准总重(0 = 尚无基准)
    uint32_t settling_since_ms;  // 进入 SETTLING 的时刻
    bool has_settling_since;
    // 稳定窗口:环形缓冲最近 BASE_STD_WINDOW 个重量
    float win[BASE_STD_WINDOW];
    int win_count;
    int win_head;
    // off_base 延迟计时
    uint32_t off_since_ms;    // 重量跌落(present→false)的时刻
    bool has_off_since;
    bool off_base_emitted;    // 本次离座是否已发过 off_base
    // 低电量滞回
    bool low_batt_alerted;
} base_weight_t;

/** 本帧判定输出。 */
typedef struct {
    base_state_t state;
    bool present;            // 重量 >= present_min_g
    bool stable;             // 已稳
    float weight_g;          // 本帧总重(过滤前原值,供遥测)
    // 事件(上升沿;每类最多一次)
    bool emit_drink;
    float drink_ml;
    bool emit_refill;
    float refill_ml;
    bool emit_off_base;
    bool emit_low_battery;
} base_weight_out_t;

void base_weight_init(base_weight_t *st);

/**
 * 推进一帧称重判定。`now_ms` 是单调递增本机毫秒(仅用于 800ms/120s 窗口,与 Unix 时间无关)。
 * @param raw_weight_g 本帧总重读数(已含皮重,由称重源给,可带噪声)
 * @param battery_pct  电量(0..100);用于低电量滞回事件
 */
base_weight_out_t base_weight_step(base_weight_t *st, float raw_weight_g, int battery_pct,
                                   uint32_t now_ms);

/** 窗口内标准差(公开供单测)。count<2 时返回 0。 */
float base_window_std(const float *xs, int count);

#ifdef __cplusplus
}
#endif
