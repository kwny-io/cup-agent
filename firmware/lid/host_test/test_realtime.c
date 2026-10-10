/**
 * 宿主单测 —— 实时档决策(realtime.c)。零 IDF,mingw gcc 直接编译运行。
 * 覆盖:晃动即进实时、显式请求、保持窗内不掉档、超窗回落、采样周期取值。
 */
#include "realtime.h"

#include <stdio.h>

static int g_fail = 0, g_total = 0;
static void ok(int cond, const char *what) {
    g_total++;
    if (!cond) { g_fail++; printf("  ✗ %s\n", what); }
    else printf("  ✓ %s\n", what);
}

static void test_normal_by_default(void) {
    printf("[默认常规档]\n");
    realtime_t st; realtime_init(&st);
    realtime_out_t o = realtime_step(&st, false, false, 0);
    ok(o.realtime == false, "无触发 → 常规档");
    ok(o.sample_ms == REALTIME_NORMAL_SAMPLE_MS, "常规档采样 1000ms");
}

static void test_shake_triggers_realtime(void) {
    printf("[晃动即进实时(英雄功能)]\n");
    realtime_t st; realtime_init(&st);
    realtime_out_t o = realtime_step(&st, false, true, 1000);
    ok(o.realtime == true, "判到晃动 → 立刻实时档");
    ok(o.sample_ms == REALTIME_SAMPLE_MS, "实时档采样 25ms(=40Hz)");
    ok(REALTIME_SAMPLE_MS == 25, "REALTIME_SAMPLE_MS 与 RATE.fast_hz=40 一致");
}

static void test_request_triggers_realtime(void) {
    printf("[App 显式请求]\n");
    realtime_t st; realtime_init(&st);
    realtime_out_t o = realtime_step(&st, true, false, 500);
    ok(o.realtime == true, "App 请求 → 实时档(无需晃动)");
}

static void test_hold_window(void) {
    printf("[保持窗:停手后不立刻掉档]\n");
    realtime_t st; realtime_init(&st);
    // 1000ms 时晃一下
    realtime_step(&st, false, true, 1000);
    // 停手后,窗口内仍实时
    ok(realtime_step(&st, false, false, 1000 + REALTIME_HOLD_MS - 1).realtime == true,
       "保持窗内仍实时");
    ok(realtime_step(&st, false, false, 1000 + REALTIME_HOLD_MS + 1).realtime == false,
       "超保持窗回落到常规档");
}

static void test_hold_renewed_each_shake(void) {
    printf("[保持窗每帧续期]\n");
    realtime_t st; realtime_init(&st);
    // 连续晃动:每次都把窗口往后推
    realtime_step(&st, false, true, 1000);
    realtime_step(&st, false, true, 2500);
    // 距最后一次晃动 2500,窗口内
    ok(realtime_step(&st, false, false, 2500 + REALTIME_HOLD_MS - 1).realtime == true,
       "以最后一次晃动计时,窗口内仍实时");
    // 距最后一次超过窗口
    ok(realtime_step(&st, false, false, 2500 + REALTIME_HOLD_MS + 1).realtime == false,
       "距最后一次晃动超窗 → 回落");
}

static void test_request_keeps_alive(void) {
    printf("[持续请求维持实时]\n");
    realtime_t st; realtime_init(&st);
    for (uint32_t t = 0; t < 20000; t += 500) {
        realtime_step(&st, true, false, t);
    }
    // 请求一断,窗口过后才回落
    ok(realtime_step(&st, false, false, 20000 + REALTIME_HOLD_MS + 1).realtime == false,
       "请求停止 + 超窗 → 回落");
    realtime_init(&st);
    ok(realtime_step(&st, true, false, 0).realtime == true, "重新请求 → 再进实时");
}

int main(void) {
    printf("== realtime 宿主单测 ==\n");
    test_normal_by_default();
    test_shake_triggers_realtime();
    test_request_triggers_realtime();
    test_hold_window();
    test_hold_renewed_each_shake();
    test_request_keeps_alive();
    printf("\n== %d/%d 通过,%d 失败 ==\n", g_total - g_fail, g_total, g_fail);
    return g_fail == 0 ? 0 : 1;
}
