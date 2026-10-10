/**
 * 宿主单测 —— remind 灯效(led_pattern.c)。零 IDF,mingw gcc 直接编译运行。
 * 覆盖:契约 §5 各效果名/颜色解析、led 缺席默认、未知名安全回落、
 * 周期/次数钳制、大小写与分隔符、NULL 安全。
 */
#include "led_pattern.h"

#include <stdio.h>

static int g_fail = 0, g_total = 0;
static void ok(int cond, const char *what) {
    g_total++;
    if (!cond) { g_fail++; printf("  ✗ %s\n", what); }
    else printf("  ✓ %s\n", what);
}

/** 契约 §5 的示例名 → 期望效果。 */
static void test_names(void) {
    printf("[效果名解析]\n");
    ok(led_pattern_from_remind("breath_blue", true).effect == LED_BREATH, "breath_blue → BREATH");
    ok(led_pattern_from_remind("blink_red", true).effect == LED_BLINK, "blink_red → BLINK");
    ok(led_pattern_from_remind("solid_green", true).effect == LED_SOLID, "solid_green → SOLID");
    ok(led_pattern_from_remind("on", true).effect == LED_SOLID, "on → SOLID");
    ok(led_pattern_from_remind("flash", true).effect == LED_BLINK, "flash → BLINK(别名)");
    ok(led_pattern_from_remind("pulse", true).effect == LED_BREATH, "pulse → BREATH(别名)");
    ok(led_pattern_from_remind("off", true).effect == LED_OFF, "off → OFF");
    ok(led_pattern_from_remind("BREATH_BLUE", true).effect == LED_BREATH, "大写也认");
    ok(led_pattern_from_remind("breath", true).effect == LED_BREATH, "无颜色段 → 仍认效果");
}

static void test_colors(void) {
    printf("[颜色解析:单色 LED 不吃,但解出来给日志/将来 RGB]\n");
    ok(led_pattern_from_remind("breath_blue", true).color == LED_COLOR_BLUE, "blue");
    ok(led_pattern_from_remind("solid_white", true).color == LED_COLOR_WHITE, "white");
    ok(led_pattern_from_remind("blink_orange", true).color == LED_COLOR_ORANGE, "orange");
    ok(led_pattern_from_remind("breath", true).color == LED_COLOR_NONE, "无颜色 → NONE");
    ok(led_pattern_from_remind("breath_chartreuse", true).color == LED_COLOR_NONE,
       "未知颜色 → NONE 但不影响效果,且效果仍是 BREATH");
    ok(led_pattern_from_remind("breath_chartreuse", true).effect == LED_BREATH,
       "未知颜色未把效果带塌");
}

/** 后端 push_device 白名单 5 名(breath_blue/breath_green/blink_blue/blink_white/blink_red)
 *  逐名钉死:效果 ∧ 颜色都要对。breath_blue / blink_red 已在上两组覆盖,这里补其余 3 名。 */
static void test_whitelist(void) {
    printf("[后端白名单:其余 3 名全覆盖]\n");
    led_pattern_t g = led_pattern_from_remind("breath_green", true);
    ok(g.effect == LED_BREATH && g.color == LED_COLOR_GREEN, "breath_green → BREATH + GREEN");
    led_pattern_t b = led_pattern_from_remind("blink_blue", true);
    ok(b.effect == LED_BLINK && b.color == LED_COLOR_BLUE, "blink_blue → BLINK + BLUE");
    led_pattern_t w = led_pattern_from_remind("blink_white", true);
    ok(w.effect == LED_BLINK && w.color == LED_COLOR_WHITE, "blink_white → BLINK + WHITE");
}

static void test_missing_led(void) {
    printf("[led 缺席的默认(防御路径:后端现已兜默认 led)]\n");
    ok(led_pattern_from_remind(NULL, true).effect == LED_BLINK, "无 led + 有文本 → 闪(提醒)");
    ok(led_pattern_from_remind("", true).effect == LED_BLINK, "空 led + 有文本 → 闪");
    ok(led_pattern_from_remind(NULL, false).effect == LED_OFF, "无 led + 无文本 → 灭");
    ok(led_pattern_from_remind("", false).effect == LED_OFF, "空 led + 无文本 → 灭");
}

static void test_unknown(void) {
    printf("[未知效果名 → 安全默认(不点常亮)]\n");
    ok(led_pattern_from_remind("disco_party", true).effect == LED_BLINK,
       "未知名 + 有文本 → 闪");
    ok(led_pattern_from_remind("disco_party", false).effect == LED_OFF,
       "未知名 + 无文本 → 灭");
    ok(led_pattern_from_remind("__", true).effect == LED_BLINK, "空效果段 → 默认");
    ok(led_pattern_from_remind("breath_", true).effect == LED_BREATH, "尾随下划线 → 效果仍认");
}

static void test_clamp(void) {
    printf("[周期 / 次数钳制]\n");
    led_pattern_t lo = led_pattern_make(LED_BLINK, LED_COLOR_NONE, 5, 0);
    ok(lo.period_ms == LED_PERIOD_MIN_MS, "周期过小 → 抬到下限");
    led_pattern_t hi = led_pattern_make(LED_BLINK, LED_COLOR_NONE, 999999, 0);
    ok(hi.period_ms == LED_PERIOD_MAX_MS, "周期过大 → 压到上限");
    led_pattern_t mid = led_pattern_make(LED_BREATH, LED_COLOR_NONE, 800, 0);
    ok(mid.period_ms == 800, "区间内不动");
    led_pattern_t zero = led_pattern_make(LED_BLINK, LED_COLOR_NONE, 0, 0);
    ok(zero.period_ms == LED_DEFAULT_PERIOD_MS, "周期 0 → 默认");
    led_pattern_t neg = led_pattern_make(LED_BLINK, LED_COLOR_NONE, -100, 0);
    ok(neg.period_ms == LED_DEFAULT_PERIOD_MS, "负周期 → 默认(不取绝对值)");

    ok(led_pattern_make(LED_BLINK, LED_COLOR_NONE, 0, 0).count == LED_DEFAULT_BLINK_COUNT,
       "次数 0 → 默认");
    ok(led_pattern_make(LED_BLINK, LED_COLOR_NONE, 0, 3).count == 3, "合法次数不动");
    ok(led_pattern_make(LED_BLINK, LED_COLOR_NONE, 0, 999).count == LED_BLINK_COUNT_MAX,
       "次数过大 → 压到上限");
    ok(led_pattern_make(LED_BLINK, LED_COLOR_NONE, 0, -5).count == LED_DEFAULT_BLINK_COUNT,
       "负次数 → 默认");
}

static void test_is_active(void) {
    printf("[is_active]\n");
    led_pattern_t on = led_pattern_from_remind("solid_red", true);
    led_pattern_t off = led_pattern_from_remind("off", true);
    ok(led_pattern_is_active(&on), "solid → 需驱动");
    ok(!led_pattern_is_active(&off), "off → 不需驱动");
    ok(!led_pattern_is_active(NULL), "NULL → 不需驱动");
}

static void test_str_safe(void) {
    printf("[枚举 → 字符串永不 NULL]\n");
    ok(led_effect_str(LED_BREATH) != NULL, "effect_str");
    ok(led_color_str(LED_COLOR_BLUE) != NULL, "color_str");
    ok(led_effect_str((led_effect_t)999) != NULL, "未知枚举也非 NULL");
}

int main(void) {
    printf("== led_pattern 宿主单测 ==\n");
    test_names();
    test_colors();
    test_whitelist();
    test_missing_led();
    test_unknown();
    test_clamp();
    test_is_active();
    test_str_safe();
    printf("\n== %d/%d 通过,%d 失败 ==\n", g_total - g_fail, g_total, g_fail);
    return g_fail == 0 ? 0 : 1;
}
