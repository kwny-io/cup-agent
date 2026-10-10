/**
 * 宿主单测 —— 称重温漂补偿(weight_comp.c)。
 * 覆盖:两点法自标定、锚点门(重/吵/温差不够/系数越界)、未标定恒等、
 *       以及 **E2E:合成源(带真实温漂)→ 补偿 → 残差 < 5g**(M6 验收 #2 的单测形态)。
 */
#include "weight_comp.h"
#include "weight_source.h"

#include <math.h>
#include <stdio.h>

static int g_fail = 0, g_total = 0;
static void ok(int cond, const char *what) {
    g_total++;
    if (!cond) { g_fail++; printf("  ✗ %s\n", what); }
    else printf("  ✓ %s\n", what);
}

#define TARE_PLUS_WATER 485.0f  // 皮重 285 + 水 200

/** 在某个温度下喂 n 帧**空座**读数 raw(恒定 → 窗口 std=0)。 */
static void feed_air(weight_comp_t *st, float temp_c, float raw, int n) {
    for (int i = 0; i < n; i++) weight_comp_step(st, raw, temp_c, (uint32_t)(i * 1000));
}

static void test_identity_before_calibration(void) {
    printf("[未标定 → corrected == raw(不猜)]\n");
    weight_comp_t st; weight_comp_init(&st);
    weight_comp_out_t o = weight_comp_step(&st, 485.0f, 40.0f, 0);
    ok(!o.calibrated, "首帧未标定");
    ok(fabsf(o.corrected_g - 485.0f) < 1e-3f, "未标定时 corrected 恒等 raw");
    ok(o.k == 0.0f, "未标定 k=0");
}

static void test_two_point_calibration(void) {
    printf("[两点法:反解 k、补偿到真值]\n");
    weight_comp_t st; weight_comp_init(&st);
    // 真实单元:z(T)=0.5·(T−25)。空座读数即 z(T)。
    feed_air(&st, 25.0f, 0.0f, COMP_STD_WINDOW + 2);          // 锚点 lo(T=25, r=0)
    ok(st.has_lo && !st.has_hi, "先采到低温锚点");
    feed_air(&st, 45.0f, 10.0f, COMP_STD_WINDOW + 2);         // 锚点 hi(T=45, r=10)
    ok(st.calibrated, "两点温差 20℃ → 完成标定");
    ok(fabsf(st.k - 0.5f) < 0.01f, "反解 k≈0.5 g/℃");
    // 在 T=45 下,真实 485g 的读数是 485+10=495 → 补偿回 485
    weight_comp_out_t o = weight_comp_step(&st, 495.0f, 45.0f, 999999);
    ok(fabsf(o.corrected_g - 485.0f) < 0.01f, "补偿后回到真值 485g");
    // 温度回到 25(标定锚点之一),漂移为 0,读数即真值
    o = weight_comp_step(&st, 485.0f, 25.0f, 1000000);
    ok(fabsf(o.corrected_g - 485.0f) < 0.01f, "低温端补偿后仍 485g");
}

static void test_guard_heavy_not_anchor(void) {
    printf("[守卫:重样本(杯在座)不入锚点]\n");
    weight_comp_t st; weight_comp_init(&st);
    feed_air(&st, 25.0f, 0.0f, COMP_STD_WINDOW + 2);   // 先建低温锚点
    // 真·重样本:485g,远超 present_min_g
    weight_comp_out_t o = weight_comp_step(&st, 485.0f, 25.0f, 5000);
    ok(!o.got_anchor, "485g 样本未被采为空座锚点");
    ok(!st.has_hi, "重样本没污染出高温锚点");
    ok(!st.calibrated, "仅一个锚点,未标定");
}

static void test_guard_noisy_not_anchor(void) {
    printf("[守卫:晃动/噪声样本不入锚点(窗口 std 超阈)]\n");
    weight_comp_t st; weight_comp_init(&st);
    // 空座但读数在 0/40 间跳(std=20,远超 settle_std_g)→ 不静默
    for (int i = 0; i < COMP_STD_WINDOW + 2; i++)
        weight_comp_step(&st, (i % 2) ? 40.0f : 0.0f, 25.0f, (uint32_t)(i * 1000));
    ok(!st.has_lo, "振荡样本未入锚点");
}

static void test_guard_dt_too_small(void) {
    printf("[守卫:两锚点温差 < 5℃ → 不标定]\n");
    weight_comp_t st; weight_comp_init(&st);
    feed_air(&st, 25.0f, 0.0f, COMP_STD_WINDOW + 2);
    feed_air(&st, 27.0f, 1.0f, COMP_STD_WINDOW + 2);   // ΔT=2 < 5
    ok(st.has_lo, "低温锚点已建");
    ok(!st.has_hi, "温差不足 → 高温锚点不建立");
    ok(!st.calibrated, "温差不足 → 不反解 k");
}

static void test_guard_k_over_max(void) {
    printf("[守卫:|k| 越界 → 丢弃该次标定]\n");
    weight_comp_t st; weight_comp_init(&st);
    feed_air(&st, 25.0f, 0.0f, COMP_STD_WINDOW + 2);
    feed_air(&st, 35.0f, 100.0f, COMP_STD_WINDOW + 2); // k=100/10=10 > K_MAX 2
    ok(!st.calibrated, "k 越界被判污染,未标定");
}

/** 模拟器同款:空座判定与温度均可由 now_ms 复算,故能拿"真值"做残差。 */
static int synth_is_air(uint32_t ms) { return (ms % 300000u) < 20000u; }

static void test_e2e_residual(void) {
    printf("[E2E:合成源(真实温漂)→ 补偿 → 残差 < 5g]\n");
    weight_comp_t st; weight_comp_init(&st);
    weight_sample_t s;

    // 阶段1:跑 20min 让自标定收敛(温度正弦会在 15min 处冲到 50℃,给到高温锚点)
    for (uint32_t ms = 0; ms < 20u * 60u * 1000u; ms += 1000u) {
        weight_synth_read(&s, ms);
        weight_comp_step(&st, s.weight_g, s.temp_c, ms);
    }
    ok(st.calibrated, "20min 内完成自标定");
    printf("    (学到 k=%.4f g/℃)\n", (double)st.k);

    // 阶段2:测 20→50min(覆盖 45min 处 50℃ 的温度峰),只统计**在座**样本的残差
    float max_corr_err = 0.0f, max_raw_err = 0.0f;
    for (uint32_t ms = 20u * 60u * 1000u; ms < 50u * 60u * 1000u; ms += 1000u) {
        weight_synth_read(&s, ms);
        weight_comp_out_t o = weight_comp_step(&st, s.weight_g, s.temp_c, ms);
        if (synth_is_air(ms)) continue;   // 只看在座
        float corr_err = fabsf(o.corrected_g - TARE_PLUS_WATER);
        float raw_err = fabsf(s.weight_g - TARE_PLUS_WATER);
        if (corr_err > max_corr_err) max_corr_err = corr_err;
        if (raw_err > max_raw_err) max_raw_err = raw_err;
    }
    printf("    (在座样本:未补偿最大偏差 %.2fg,补偿后最大残差 %.2fg)\n",
           (double)max_raw_err, (double)max_corr_err);
    ok(max_corr_err < 5.0f, "补偿后残差 < 5g(M6 验收 #2)");
    ok(max_raw_err > 5.0f, "对照:未补偿确实漂出 5g 外(证明本测有意义)");
}

int main(void) {
    printf("== weight_comp 宿主单测 ==\n");
    test_identity_before_calibration();
    test_two_point_calibration();
    test_guard_heavy_not_anchor();
    test_guard_noisy_not_anchor();
    test_guard_dt_too_small();
    test_guard_k_over_max();
    test_e2e_residual();
    printf("\n== %d/%d 通过,%d 失败 ==\n", g_total - g_fail, g_total, g_fail);
    return g_fail == 0 ? 0 : 1;
}
