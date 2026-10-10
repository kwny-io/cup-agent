/**
 * 宿主单测 —— ToF 液位 α-β 滤波(level_filter.c)。零 IDF,mingw gcc 直接编译运行。
 * 覆盖:静止噪声压制、慢斜坡跟踪、单帧尖峰被门挡、真实阶跃被采信、区间 clamp。
 */
#include "level_filter.h"

#include <math.h>
#include <stdio.h>

static int g_fail = 0, g_total = 0;
static void ok(int cond, const char *what) {
    g_total++;
    if (!cond) { g_fail++; printf("  ✗ %s\n", what); }
    else printf("  ✓ %s\n", what);
}

// 确定性伪随机(LCG),免得依赖 rand() 的跨平台差异。
static uint32_t g_seed = 12345u;
static void seed(uint32_t s) { g_seed = s; }
static float urand(void) {  // [0,1)
    g_seed = g_seed * 1664525u + 1013904223u;
    return (float)(g_seed >> 8) / (float)(1u << 24);
}
/** Box-Muller 正态(0,σ)。 */
static float gnoise(float sigma) {
    float u1 = urand();
    if (u1 < 1e-7f) u1 = 1e-7f;
    float u2 = urand();
    return sigma * sqrtf(-2.0f * logf(u1)) * cosf(6.2831853f * u2);
}

static float mean_of(const float *a, int n) {
    float s = 0; for (int i = 0; i < n; i++) s += a[i]; return s / (float)n;
}
static float std_of(const float *a, int n) {
    float m = mean_of(a, n), acc = 0;
    for (int i = 0; i < n; i++) { float d = a[i] - m; acc += d * d; }
    return sqrtf(acc / (float)n);
}

/** 静止档压制噪声:真值恒定 + 静噪 σ=0.6mm → 滤波后残差远小于输入标准差。 */
static void test_quiet_smoothing(void) {
    printf("[静止档:压制噪声]\n");
    level_filter_t st; level_filter_init(&st);
    const float truth = 60.0f;
    seed(1u);
    float in[400], outv[300];
    for (int i = 0; i < 400; i++) {
        float raw = truth + gnoise(0.6f);
        in[i] = raw;
        float y = level_filter_step(&st, raw, false, (uint32_t)(i * 100)).level_mm;
        if (i >= 100) outv[i - 100] = y;  // 丢掉收敛段
    }
    float in_std = std_of(in + 100, 300);
    float out_std = std_of(outv, 300);
    float out_err = fabsf(mean_of(outv, 300) - truth);
    printf("    输入 σ=%.3f  输出 σ=%.3f  均值误差=%.3f\n", (double)in_std, (double)out_std, (double)out_err);
    ok(in_std > 0.4f, "输入噪声确实约 0.6mm(构造有效)");
    ok(out_std < in_std * 0.5f, "滤波后标准差降一半以上");
    ok(out_err < 1.0f, "估计均值贴近真值(<1mm)");
}

/** 真实变化能跟住:液位 60→68mm 慢速下降(喝水),估计持续跟随,不被门永久挡住。 */
static void test_tracks_ramp(void) {
    printf("[慢斜坡:跟得住真实变化]\n");
    level_filter_t st; level_filter_init(&st);
    seed(2u);
    // 前 100 帧稳在 60,之后以 2mm/s 下降(喝酒)到 68mm 附近
    float last = 0;
    for (int i = 0; i < 500; i++) {
        float t = (float)i * 0.1f;
        float truth = 60.0f + (i > 100 ? fminf((t - 10.0f) * 2.0f, 8.0f) : 0.0f);
        float raw = truth + gnoise(0.6f);
        last = level_filter_step(&st, raw, false, (uint32_t)(i * 100)).level_mm;
    }
    printf("    真值终点≈68.0  估计=%.2f\n", (double)last);
    ok(fabsf(last - 68.0f) < 3.0f, "慢变化后估计跟到真值 ±3mm 内");
}

/** 单帧尖峰(晃动)被新息门挡下:输出保持预测,不被一帧拽跑。 */
static void test_gate_single_spike(void) {
    printf("[新息门:单帧尖峰被挡]\n");
    level_filter_t st; level_filter_init(&st);
    // 先稳定在 50mm
    for (int i = 0; i < 50; i++) level_filter_step(&st, 50.0f, false, (uint32_t)(i * 100));
    float before = level_filter_step(&st, 50.0f, false, 5000).level_mm;
    // 一帧跳到 90mm(+40mm,超静止门 25)
    level_filter_out_t o = level_filter_step(&st, 90.0f, false, 5100);
    printf("    尖峰前=%.2f  尖峰帧=%.2f gated=%d\n", (double)before, (double)o.level_mm, (int)o.gated);
    ok(o.gated == true, "单帧 +40mm 被门判为可可疑");
    ok(fabsf(o.level_mm - before) < 2.0f, "被挡后输出几乎不动(未采信尖峰)");
    // 下一帧回到真值 50 → 门清,恢复正常
    level_filter_out_t r = level_filter_step(&st, 50.0f, false, 5200);
    ok(r.gated == false, "尖峰消失后门清除");
}

/** 真实阶跃(倒水持续多帧)最终被采信并吸附。 */
static void test_gate_real_step_accepted(void) {
    printf("[新息门:持续阶跃被采信]\n");
    level_filter_t st; level_filter_init(&st);
    for (int i = 0; i < 50; i++) level_filter_step(&st, 40.0f, false, (uint32_t)(i * 100));
    // 真值跳到 90mm 并保持(倒水后新水面)—— 连续多帧都超门
    bool ever_gated = false;
    float last = 0;
    for (int i = 0; i < 20; i++) {
        level_filter_out_t o = level_filter_step(&st, 90.0f, false, (uint32_t)(5000 + i * 100));
        if (o.gated) ever_gated = true;
        last = o.level_mm;
    }
    printf("    曾触发门=%d  终值=%.2f\n", (int)ever_gated, (double)last);
    ok(ever_gated, "阶跃头几帧确实触发门(先怀疑)");
    ok(fabsf(last - 90.0f) < 2.0f, "持续阶跃后估计吸附到新真值");
}

/** 晃动档:噪声 σ=9mm(晃动)下,重平滑仍稳住,且均值不离真值。 */
static void test_noisy_mode_shake(void) {
    printf("[晃动档:大噪声下重平滑]\n");
    level_filter_t st; level_filter_init(&st);
    seed(3u);
    const float truth = 70.0f;
    float outv[300];
    for (int i = 0; i < 400; i++) {
        float raw = truth + gnoise(9.0f);
        float y = level_filter_step(&st, raw, true, (uint32_t)(i * 50)).level_mm;  // 20Hz
        if (i >= 100) outv[i - 100] = y;
    }
    float out_std = std_of(outv, 300);
    printf("    晃动档输出 σ=%.3f(输入 σ=9)\n", (double)out_std);
    ok(out_std < 2.0f, "晃动下滤波输出标准差 < 2mm(远小于输入 9)");
    ok(fabsf(mean_of(outv, 300) - truth) < 3.0f, "晃动档均值不离真值");
}

/** 区间 clamp:ToF 偶发越界(负/超内胆高)不会漏进估计。 */
static void test_clamp(void) {
    printf("[clamp 到 [0,130]]\n");
    level_filter_t st; level_filter_init(&st);
    float y = level_filter_step(&st, -5.0f, false, 0).level_mm;
    ok(y >= 0.0f, "负读数被夹到 0");
    level_filter_init(&st);
    y = level_filter_step(&st, 500.0f, false, 0).level_mm;
    ok(y <= 130.0f, "超内胆高读数被夹到 130");
    // 长时间扫描:输出恒在区间
    level_filter_init(&st);
    seed(4u);
    int bad = 0;
    for (int i = 0; i < 1000; i++) {
        float raw = urand() * 200.0f - 20.0f;   // [-20, 180):含越界值
        float y2 = level_filter_step(&st, raw, i % 7 == 0, (uint32_t)(i * 100)).level_mm;
        if (y2 < 0.0f || y2 > 130.0f) bad++;
    }
    ok(bad == 0, "1000 帧扫描恒在 [0,130]");
}

int main(void) {
    printf("== level_filter 宿主单测 ==\n");
    test_quiet_smoothing();
    test_tracks_ramp();
    test_gate_single_spike();
    test_gate_real_step_accepted();
    test_noisy_mode_shake();
    test_clamp();
    printf("\n== %d/%d 通过,%d 失败 ==\n", g_total - g_fail, g_total, g_fail);
    return g_fail == 0 ? 0 : 1;
}
