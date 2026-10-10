/**
 * 底座 · 称重温漂补偿(纯 C,零 IDF 依赖)—— 抵消应变片零点随温度的漂移。
 *
 * 为什么要这一层:M6 验收 #2 是"热水注入后,读数不因温度漂移而虚高虚低"。应变片零点
 * 随整体升温缓慢偏移(架构 §4.3 / 风险 R1),不补偿就会把"热水烫热了底座"误读成"水变多了"。
 *
 * ── 物理模型(零点漂移)────────────────────────────────────────────
 *   raw = 真实重量 + z(T)      z(T) = a + k·T   (k = 漂移系数 g/℃)
 * 空座时真实重量 = 0,故 raw = z(T) —— **空座读数直接落在零点直线上**。
 *
 * ── 自标定两点法(免人工标定)────────────────────────────────────
 * 采集两个**温度充分分离**的干净空座样本(见下"锚点门"),即可反解 k:
 *   k = (r_hi − r_lo) / (T_hi − T_lo)      要求 T_hi − T_lo ≥ COMP_MIN_DT_C
 *   z(T) = r_lo + k·(T − T_lo)             直线过 lo 锚点
 *   corrected = clamp(raw − z(T), 0, 2000)
 * 未标定(锚点不足或温差不够)时 **corrected = raw**(恒等)——没有空座观测就不猜。
 *
 * ── 防污染(锚点门,用户点名的风险)──────────────────────────────
 * 一个样本被采为空座锚点,必须**同时**满足:
 *   ① raw < SCALE_PRESENT_MIN_G   —— 杯在座上 = 皮重 285g + 水,天然排除;防"没拿干净"
 *   ② 窗口标准差 < SCALE_SETTLE_STD_G —— 静止,防液体晃动/手扶
 *   ③ 窗口填满(COMP_STD_WINDOW)  —— 样本量足够
 * 锚点值取**窗口均值**(非单帧),更抗噪;k 反解后再过 COMP_K_MAX 守卫(越界判污染,丢弃)。
 *
 * 抽成零依赖纯 C 的另一个理由:可测(见 host_test/test_weight_comp.c)。真板逻辑与此逐字一致。
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** 空座静默检测的滑动窗口长度(样本数)。 */
#define COMP_STD_WINDOW 8
/** 两锚点最小温差(℃);低于此不反解 k,防噪声把斜率放大成离谱值。 */
#define COMP_MIN_DT_C 5.0f
/** |k| 上限(g/℃);反解结果超此判为污染/坏数据,丢弃该次标定。 */
#define COMP_K_MAX 2.0f

/** 补偿状态(调用方持有;weight_comp_init 清零)。 */
typedef struct {
    // 空座静默窗口(raw 读数)
    float win[COMP_STD_WINDOW];
    int win_count;
    int win_head;
    // 两个温度分离的空座锚点(窗口均值 + 该时刻温度)
    bool has_lo;
    float t_lo, r_lo;
    bool has_hi;
    float t_hi, r_hi;
    // 反解出的零点直线
    bool calibrated;
    float k;   // g/℃
    float a;   // 截距(z(T) = a + k·T)
} weight_comp_t;

/** 本帧补偿输出。 */
typedef struct {
    float corrected_g;   // 补偿后重量(上报/判定用)
    bool calibrated;     // 是否已标定(否则 corrected==raw)
    float k;             // 当前漂移系数(g/℃);未标定为 0
    bool got_anchor;     // 本帧是否新采到/更新了一个空座锚点(供日志)
} weight_comp_out_t;

void weight_comp_init(weight_comp_t *st);

/**
 * 推进一帧温补。`now_ms` 保留给将来做锚点老化(当前只用于接口一致性,未参与判定)。
 * @param raw_g   本帧**未补偿**原始读数(已含温漂)
 * @param temp_c  本帧底座内部温度(℃)—— 契约 base 遥测的 temp_c 即此量
 */
weight_comp_out_t weight_comp_step(weight_comp_t *st, float raw_g, float temp_c, uint32_t now_ms);

#ifdef __cplusplus
}
#endif
