/**
 * 杯盖 · 实时档决策(纯 C,零 IDF 依赖)。
 *
 * 背景:契约 §6.5 定了两个节奏 ——
 *   RATE.report_ms = 300000(常规档上报间隔 5 min)
 *   RATE.fast_hz   = 40     (实时档 IMU 采样率)
 * 英雄功能「摇杯 → 画面同步」要求 IMU 以 40Hz 采样、遥测带 `imu` 六轴
 * (契约:LidTelemetrySchema 的 `imu` **仅实时档携带**,`has_imu=true` 才序列化)。
 * 常规档则 1Hz 采样、不带 imu,以省电(架构 §3.3:BLE 实时会话绑定 App 活跃)。
 *
 * 本模块只做**决策**:由"是否需要实时(如 App 播/摇杯演出中)"与运动状态,
 * 决定当前是常规还是实时档、以及本帧该按多快采样。真正切 Wi-Fi/BLE 射频、
 * 起高优先级任务属 IDF 侧,不在这里(纯 C 层保持零依赖、可测)。
 *
 * 进入实时档的触发:显式请求(rt_request,如 App 连上要演出)**或**检测到晃动
 * (英雄功能:你一摇杯子画面就要跟着动,不必等 App 先发指令)。退出靠**保持窗**:
 * 触发源消失后,先按 hold_ms 继续实时(否则一停手就掉回 1Hz,演出会卡顿),
 * 超过 hold_ms 才回落常规档 —— 抖动/短暂间隙不会来回切档。
 *
 * 为什么抽成零依赖纯 C:可测(见 host_test/test_realtime.c)。真板逻辑与此逐字一致。
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** 单次触发的实时档保持时长(ms):触发源消失后仍维持这么久,防演出中途卡顿。 */
#define REALTIME_HOLD_MS 3000

/** 实时档采样周期(ms)= 1000 / RATE.fast_hz(40)。 */
#define REALTIME_SAMPLE_MS 25
/** 常规档采样周期(ms):契约 RATE.report_ms 是**上报**间隔;采样按 CUP_SAMPLE_MS。 */
#ifndef REALTIME_NORMAL_SAMPLE_MS
#define REALTIME_NORMAL_SAMPLE_MS 1000
#endif

/** 决策状态(调用方持有;realtime_init 清零)。 */
typedef struct {
    bool realtime;          // 当前是否实时档
    uint32_t hold_until_ms; // 实时档保持到的时刻
} realtime_t;

/** 本帧输出。 */
typedef struct {
    bool realtime;      // 本帧是否实时档(决定遥测是否带 imu)
    uint32_t sample_ms; // 本帧建议采样周期(ms)
} realtime_out_t;

void realtime_init(realtime_t *st);

/**
 * 推进一帧决策。
 * @param rt_request 外部触发(如 App 已连上、要播摇杯演出);true 即强制进入实时档
 * @param motion_shake 本帧是否判到晃动(英雄功能的即时触发)—— 传 lid_logic 的 motion==SHAKE
 * @param now_ms     单调递增本机毫秒
 */
realtime_out_t realtime_step(realtime_t *st, bool rt_request, bool motion_shake, uint32_t now_ms);

#ifdef __cplusplus
}
#endif
