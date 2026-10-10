/**
 * 宿主单测 —— 底座称重换算层(weight_convert.c)。零 IDF,mingw gcc 直接编译运行。
 * 覆盖:HX711 24 位补码符号扩展(正/负/边界)、上电/掉电哨兵识别、零点+灵敏度换算、未标定不猜。
 */
#include "weight_convert.h"

#include <math.h>
#include <stdio.h>

static int g_fail = 0, g_total = 0;
static void ok(int cond, const char *what) {
    g_total++;
    if (!cond) { g_fail++; printf("  ✗ %s\n", what); }
    else printf("  ✓ %s\n", what);
}
static int near(float a, float b, float eps) { return fabsf(a - b) <= eps; }

static void test_signed24(void) {
    printf("[HX711:24 位补码扩展]\n");
    ok(hx711_signed_24(0x000000) == 0, "0x000000 = 0");
    ok(hx711_signed_24(0x000001) == 1, "0x000001 = +1");
    ok(hx711_signed_24(0x7FFFFF) == 8388607, "0x7FFFFF = +2^23-1(最大正)");
    ok(hx711_signed_24(0x800000) == -8388608, "0x800000 = -2^23(最小负)");
    ok(hx711_signed_24(0xFFFFFF) == -1, "0xFFFFFF = -1(全 1)");
    // 高位垃圾应被掩掉(只取低 24 位)
    ok(hx711_signed_24(0xAB000001) == 1, "高 8 位垃圾被掩掉 → +1");
}

static void test_power_status(void) {
    printf("[HX711:上电/掉电哨兵]\n");
    ok(hx711_power_status(0x800000) == HX711_POWER_ON, "0x800000 → 上电/复位");
    ok(hx711_power_status(0x7FFFFF) == HX711_POWER_OFF, "0x7FFFFF → 掉电");
    ok(hx711_power_status(0x000000) == HX711_OK, "0x000000 → 正常");
    ok(hx711_power_status(0x123456) == HX711_OK, "普通读数 → 正常");
}

static void test_scale(void) {
    printf("[HX711:零点+灵敏度换算]\n");
    // 标定:零点 8388608 计数、2000 counts/g
    int32_t zero = 100000;
    float cpg = 2000.0f;
    ok(near(hx711_apply_scale(100000, zero, cpg), 0.0f, 1e-4f), "等于零点 → 0 g");
    ok(near(hx711_apply_scale(120000, zero, cpg), 10.0f, 1e-4f), "+20000 计数 / 2000 = 10 g");
    ok(near(hx711_apply_scale(80000, zero, cpg), -10.0f, 1e-4f), "-20000 计数 → -10 g(可负)");
    ok(near(hx711_apply_scale(100000, zero, 0.0f), 0.0f, 1e-6f), "未标定(counts_per_g=0)→ 不猜,0");
    ok(near(hx711_apply_scale(100000, zero, -5.0f), 0.0f, 1e-6f), "非法负灵敏度 → 0");
}

int main(void) {
    test_signed24();
    test_power_status();
    test_scale();
    printf("\n== %d/%d 通过,%d 失败 ==\n", g_total - g_fail, g_total, g_fail);
    return g_fail ? 1 : 0;
}
