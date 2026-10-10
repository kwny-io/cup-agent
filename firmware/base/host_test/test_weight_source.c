/**
 * 宿主单测 —— 合成称重源(weight_source.c 的 synth 路径)。
 * 断言:长时间扫描下读数**恒落在契约 §3 的合法区间**,且**同一相位内**噪声足够小
 * (不能让裸板在静止相位里自抖出 drink/refill)。
 *
 * 注意:合成源现在带**慢场景**(每 5min 一次"拿起 20s"),故"稳定窗口"必须整段落在
 * 同一相位内 —— 跨"拿起/放回"边界的窗口重量会跳变,那是场景本身,不是噪声。
 */
#include "weight_source.h"

#include <math.h>
#include <stdio.h>

static int g_fail = 0, g_total = 0;
static void ok(int cond, const char *what) {
    g_total++;
    if (!cond) { g_fail++; printf("  ✗ %s\n", what); }
    else printf("  ✓ %s\n", what);
}

#define PERIOD_MS 300000u
#define AIR_MS 20000u

static void test_ranges_over_time(void) {
    printf("[合成源 · 长时间扫描恒在契约区间]\n");
    weight_sample_t s;
    int ok_w = 1, ok_temp = 1, ok_batt = 1;
    float min_w = 1e9f, max_w = -1e9f;
    for (uint32_t i = 0; i < 24u * 3600u; i += 30) {
        weight_synth_read(&s, i * 1000u);
        if (s.has_weight && (s.weight_g < 0.0f || s.weight_g > 2000.0f)) ok_w = 0;
        if (s.has_temp && (s.temp_c < -10.0f || s.temp_c > 120.0f)) ok_temp = 0;
        if (s.has_battery && (s.battery_pct < 0 || s.battery_pct > 100)) ok_batt = 0;
        if (s.weight_g < min_w) min_w = s.weight_g;
        if (s.weight_g > max_w) max_w = s.weight_g;
    }
    ok(ok_w, "weight_g 恒在 [0,2000]");
    ok(ok_temp, "temp_c 恒在 [-10,120]");
    ok(ok_batt, "battery_pct 恒在 [0,100]");
    printf("    (重量游走范围 %.2f .. %.2f g)\n", (double)min_w, (double)max_w);
}

/** 取一段**整段落在同一相位内**的 8 帧,算窗口标准差。 */
static float phase_window_std(uint32_t start_ms) {
    float win[8];
    for (int i = 0; i < 8; i++) {
        weight_sample_t s;
        weight_synth_read(&s, start_ms + (uint32_t)i * 1000u);
        win[i] = s.weight_g;
    }
    float sum = 0;
    for (int i = 0; i < 8; i++) sum += win[i];
    float mean = sum / 8.0f, acc = 0;
    for (int i = 0; i < 8; i++) { float d = win[i] - mean; acc += d * d; }
    return sqrtf(acc / 8.0f);
}

static void test_noise_below_settle(void) {
    printf("[合成源 · 相位内静止噪声不触发事件]\n");
    float max_std = 0.0f;
    for (uint32_t k = 0; k < 6; k++) {
        uint32_t base = k * PERIOD_MS;
        float s_on = phase_window_std(base + 30000u);   // 在座相位(30..37s,避开 0..20s 拿起)
        float s_air = phase_window_std(base + 2000u);   // 拿起相位(2..9s,整段在内)
        if (s_on > max_std) max_std = s_on;
        if (s_air > max_std) max_std = s_air;
    }
    ok(max_std < 1.5f, "同相位 8 帧窗口 std < settle_std_g(不被噪声抖成未稳)");
    printf("    (最大相位内窗口 std %.3f g,阈值 1.5)\n", (double)max_std);
}

static void test_phases(void) {
    printf("[合成源 · 在座/拿起 两相位]\n");
    weight_sample_t s;
    weight_synth_read(&s, 30000u);   // 在座相位
    ok(s.weight_g > 50.0f, "在座相位:weight 超 present_min_g");
    weight_synth_read(&s, 2000u);    // 拿起相位
    ok(s.weight_g < 50.0f, "拿起相位:weight 低于 present_min_g(给温补喂空座样本)");
    ok(s.has_temp && s.has_battery, "温度/电量齐备");
}

int main(void) {
    printf("== weight_source 宿主单测 ==\n");
    test_ranges_over_time();
    test_noise_below_settle();
    test_phases();
    printf("\n== %d/%d 通过,%d 失败 ==\n", g_total - g_fail, g_total, g_fail);
    return g_fail == 0 ? 0 : 1;
}
