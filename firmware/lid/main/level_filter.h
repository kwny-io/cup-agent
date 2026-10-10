/**
 * 杯盖 · ToF 液位 α-β 滤波(纯 C,零 IDF 依赖)。
 *
 * 为什么要这层:VL53L0X 朝下打液面,读数 = 真实液位 + **水面波动** + 传感噪声,
 * 且波动被运动驱动 —— **不是白噪声**(架构 §4.2 / 风险 R2)。晃杯时噪声 σ 可达 ~9mm
 * (≈27mm 的 3σ 尖峰),直接上报会让后端的液位/趋势图抖成锯齿。
 *
 * 解法:α-β 滤波器。它在"位置 x + 速度 v"两态上做恒定增益的卡尔曼近似 ——
 * 比一阶低通多一个速度态,故能跟住**缓慢的匀速变化**,又不被单帧尖峰带跑。
 *
 * ── 关键洞察:两档增益方向与直觉相反 ─────────────────────────────
 * 摇晃增大的是**测量噪声**,不是真实液位的变化率(摇晃时水位并不变,只是在晃)。
 * 所以要达到同样的输出质量,测量越吵 → 增益应越**小**(平滑越重):
 *   quiet  静止:噪声 σ≈0.6mm。增益取**较大**,因为真实喝水是按 1Hz 慢档来的、
 *          必须跟得住阶跃;噪声小,取大增益输出的抖动仍很小。
 *   shake  晃动/倾倒:噪声 σ≈9mm。增益取**很小** —— 晃动时人不会同时喝水,
 *          故可放心重平滑,把 9mm 的波动压到 ~1.5mm。
 * (若反过来在晃动时放大增益,输出会跟着水波一起抖 —— 正是要滤掉的东西。)
 *
 * 另一道保险是**新息门**(innovation gate):单帧读数与预测差超阈时不直接采信,
 * 需连续若干帧都越阈才认(真实变化会持续,单帧尖峰不会)—— 防晃动尖峰把估计拽跑,
 * 又不永久挡住真实的倒水/喝水(它们持续多帧,很快通过)。晃动档门更宽(噪声大)。
 *
 * 为什么抽成零依赖纯 C:可测(见 host_test/test_level_filter.c)。真板逻辑与此逐字一致。
 * 参数是**设备内部实现**(每颗 ToF 噪声特性不同),故不进契约 —— 与 weight_comp 同理。
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// ── 滤波参数(设备内部;不进契约)────────────────────────────────
/** 静止档位置增益(较大 → 跟得住 1Hz 慢档下的真实喝水阶跃;静噪小,不怕抖)。 */
#define LEVEL_FILTER_ALPHA_QUIET 0.15f
/** 静止档速度增益。 */
#define LEVEL_FILTER_BETA_QUIET 0.010f
/** 晃动档位置增益(很小 → 重平滑,把 σ≈9mm 的水面波动压到 ~1.5mm)。 */
#define LEVEL_FILTER_ALPHA_SHAKE 0.05f
/** 晃动档速度增益。 */
#define LEVEL_FILTER_BETA_SHAKE 0.002f
/** 静止档新息门(mm):σ≈0.6mm → 25mm 约 40σ,只可能是真变化或故障。 */
#define LEVEL_GATE_QUIET_MM 25.0f
/** 晃动档新息门(mm):σ≈9mm → 40mm 约 4.4σ,挡住极端离群而不误杀真变化。 */
#define LEVEL_GATE_SHAKE_MM 40.0f
/** 连续超门帧数达此值 → 认定为真实变化,采信并吸附(否则真实倒水会被永久挡住)。 */
#define LEVEL_GATE_CONFIRM_FRAMES 3

/** 滤波状态(调用方持有;level_filter_init 清零)。 */
typedef struct {
    float x;                 // 估计液位(mm)
    float v;                 // 估计变化率(mm/s)
    bool init;               // 是否已用首帧建立初值
    uint32_t last_ms;        // 上次更新时刻(算 dt)
    int gated_frames;        // 连续超门的帧数
    bool gated;              // 本帧测量是否被门拒绝
    float last_resid;        // 本帧新息(测量 − 预测)
} level_filter_t;

/** 本帧输出。 */
typedef struct {
    float level_mm;   // 滤波后液位(mm,已 clamp 到 [0, CUP_INNER_MM])
    bool gated;       // 本帧测量被新息门拒绝(输出=预测,未采信测量)
} level_filter_out_t;

void level_filter_init(level_filter_t *st);

/**
 * 推进一帧滤波。`now_ms` 是单调递增本机毫秒(算速度用)。
 * @param raw_mm  本帧 ToF 原始读数(mm)
 * @param noisy   true = 高噪声档(晃动/倾倒,读数被水面波动污染 → 重平滑);
 *                false = 静止档(跟得住真实变化)
 */
level_filter_out_t level_filter_step(level_filter_t *st, float raw_mm, bool noisy, uint32_t now_ms);

#ifdef __cplusplus
}
#endif
