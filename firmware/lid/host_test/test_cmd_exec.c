/**
 * 宿主单测 —— 下行 config 生效值裁定(cmd_exec.c)。零 IDF,mingw 直接跑。
 * 覆盖:区间内不变、下钳 MIN、上钳 MAX、0/负 → 0(非法)、边界值本身。
 */
#include "cmd_exec.h"

#include <stdio.h>

static int g_fail = 0, g_total = 0;
static void ok(int cond, const char *what) {
    g_total++;
    if (!cond) { g_fail++; printf("  ✗ %s\n", what); }
    else printf("  ✓ %s\n", what);
}

static void test_in_range(void) {
    printf("[区间内 → 原值]\n");
    ok(cmd_exec_clamp_report_ms(60000) == 60000, "60000 保持");
    ok(cmd_exec_clamp_report_ms(5000) == 5000, "下边界 5000 保持");
    ok(cmd_exec_clamp_report_ms(3600000) == 3600000, "上边界 3600000 保持");
}

static void test_clamp_low(void) {
    printf("[过密上报 → 钳到 MIN]\n");
    ok(cmd_exec_clamp_report_ms(4999) == CMD_REPORT_MS_MIN, "4999 → 5000");
    ok(cmd_exec_clamp_report_ms(100) == CMD_REPORT_MS_MIN, "100 → 5000");
    ok(cmd_exec_clamp_report_ms(1) == CMD_REPORT_MS_MIN, "1 → 5000");
}

static void test_clamp_high(void) {
    printf("[几乎停报 → 钳到 MAX]\n");
    ok(cmd_exec_clamp_report_ms(3600001) == CMD_REPORT_MS_MAX, "3600001 → 3600000");
    ok(cmd_exec_clamp_report_ms(99999999999LL) == CMD_REPORT_MS_MAX, "超大值 → 3600000");
}

static void test_invalid(void) {
    printf("[0/负 → 0(非法,调用方保持原值)]\n");
    ok(cmd_exec_clamp_report_ms(0) == 0, "0 → 0");
    ok(cmd_exec_clamp_report_ms(-1) == 0, "-1 → 0");
    ok(cmd_exec_clamp_report_ms(-99999) == 0, "大负数 → 0");
}

int main(void) {
    printf("== cmd_exec 宿主单测 ==\n");
    test_in_range();
    test_clamp_low();
    test_clamp_high();
    test_invalid();
    printf("\n== %d/%d 通过,%d 失败 ==\n", g_total - g_fail, g_total, g_fail);
    return g_fail == 0 ? 0 : 1;
}
