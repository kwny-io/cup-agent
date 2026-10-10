/**
 * 杯盖 · remind 灯效(纯 C,零 IDF 依赖)。实现见 led_pattern.h 的说明。
 */
#include "led_pattern.h"

#include <stddef.h>
#include <string.h>

// ── 小工具 ────────────────────────────────────────────────────────
static char lower(char c) { return (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c; }

static bool streq(const char *a, const char *b) {
    while (*a && *b) {
        if (*a != *b) return false;
        a++;
        b++;
    }
    return *a == '\0' && *b == '\0';
}

/** 把 src 的小写副本写进 dst(cap 含结尾 NUL);超长则截断(截断后当未知处理)。 */
static void copy_lower(char *dst, size_t cap, const char *src) {
    size_t i = 0;
    if (cap == 0) return;
    for (; src[i] && i + 1 < cap; i++) dst[i] = lower(src[i]);
    dst[i] = '\0';
}

// ── 名字解析 ──────────────────────────────────────────────────────
bool led_effect_parse(const char *name, led_effect_t *out) {
    if (!name || !*name) return false;
    char buf[16];
    copy_lower(buf, sizeof(buf), name);
    if (streq(buf, "off")) { *out = LED_OFF; return true; }
    if (streq(buf, "on") || streq(buf, "solid")) { *out = LED_SOLID; return true; }
    if (streq(buf, "blink") || streq(buf, "flash")) { *out = LED_BLINK; return true; }
    if (streq(buf, "breath") || streq(buf, "pulse")) { *out = LED_BREATH; return true; }
    return false;
}

bool led_color_parse(const char *name, led_color_t *out) {
    if (!name || !*name) return false;
    char buf[16];
    copy_lower(buf, sizeof(buf), name);
    if (streq(buf, "blue")) { *out = LED_COLOR_BLUE; return true; }
    if (streq(buf, "green")) { *out = LED_COLOR_GREEN; return true; }
    if (streq(buf, "red")) { *out = LED_COLOR_RED; return true; }
    if (streq(buf, "white")) { *out = LED_COLOR_WHITE; return true; }
    if (streq(buf, "yellow")) { *out = LED_COLOR_YELLOW; return true; }
    if (streq(buf, "cyan")) { *out = LED_COLOR_CYAN; return true; }
    if (streq(buf, "purple")) { *out = LED_COLOR_PURPLE; return true; }
    if (streq(buf, "orange")) { *out = LED_COLOR_ORANGE; return true; }
    return false;
}

const char *led_effect_str(led_effect_t e) {
    switch (e) {
        case LED_OFF: return "off";
        case LED_SOLID: return "solid";
        case LED_BLINK: return "blink";
        case LED_BREATH: return "breath";
    }
    return "?";
}

const char *led_color_str(led_color_t c) {
    switch (c) {
        case LED_COLOR_NONE: return "none";
        case LED_COLOR_BLUE: return "blue";
        case LED_COLOR_GREEN: return "green";
        case LED_COLOR_RED: return "red";
        case LED_COLOR_WHITE: return "white";
        case LED_COLOR_YELLOW: return "yellow";
        case LED_COLOR_CYAN: return "cyan";
        case LED_COLOR_PURPLE: return "purple";
        case LED_COLOR_ORANGE: return "orange";
    }
    return "?";
}

// ── 钳制 ──────────────────────────────────────────────────────────
led_pattern_t led_pattern_make(led_effect_t effect, led_color_t color, int period_ms,
                               int count) {
    led_pattern_t p;
    p.effect = effect;
    p.color = color;

    if (period_ms <= 0) {
        p.period_ms = LED_DEFAULT_PERIOD_MS;
    } else if (period_ms < LED_PERIOD_MIN_MS) {
        p.period_ms = LED_PERIOD_MIN_MS;
    } else if (period_ms > LED_PERIOD_MAX_MS) {
        p.period_ms = LED_PERIOD_MAX_MS;
    } else {
        p.period_ms = (uint32_t)period_ms;
    }

    if (count <= 0) {
        p.count = LED_DEFAULT_BLINK_COUNT;
    } else if (count > LED_BLINK_COUNT_MAX) {
        p.count = LED_BLINK_COUNT_MAX;
    } else {
        p.count = count;
    }
    return p;
}

/** led 缺席 / 未知名字时的回想:有文本 → 闪一下提醒,否则灭。 */
static led_pattern_t default_for(bool has_text) {
    if (!has_text) return led_pattern_make(LED_OFF, LED_COLOR_NONE, 0, 0);
    return led_pattern_make(LED_BLINK, LED_COLOR_NONE, 0, 0);
}

led_pattern_t led_pattern_from_remind(const char *led_str, bool has_text) {
    if (!led_str || !*led_str) return default_for(has_text);

    // 拷一份小写,在首个 '_' 处切成 <effect>_<color>。
    char buf[32];
    copy_lower(buf, sizeof(buf), led_str);

    char *sep = strchr(buf, '_');
    char *eff_name = buf;
    const char *col_name = NULL;
    if (sep) {
        *sep = '\0';
        col_name = sep + 1;
    }

    led_effect_t eff;
    if (!led_effect_parse(eff_name, &eff)) return default_for(has_text);

    led_color_t col = LED_COLOR_NONE;
    if (col_name) (void)led_color_parse(col_name, &col);  // 颜色可选:解析失败不影响效果

    return led_pattern_make(eff, col, 0, 0);
}

bool led_pattern_is_active(const led_pattern_t *p) {
    return p && p->effect != LED_OFF;
}
