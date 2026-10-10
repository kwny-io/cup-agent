/**
 * 杯盖 · remind 灯效(纯 C,零 IDF 依赖)—— 可宿主单测。
 *
 * 为什么要这层:下行 `remind` 契约 §5 的 payload 是 `{ "text": "...", "led": "breath_blue" }`
 * —— `led` 是**效果名字符串**(不是整数)。板载只有一颗**单色数字 LED**(预留 GPIO10),
 * 故颜色分量对硬件无意义:**只驱动亮/灭与占空比**,颜色名解析出来仅用于日志 & 将来换 RGB 时复用。
 *
 * 与真板无关的部分(把 led 字符串 → 一个**灯效序列**)抽成零依赖纯 C,理由同 M9 换算层:
 * 真板到货前就把"名字 → 效果 / 越界钳制 / 未知回落"这些边界在 PC 上钉死;真板逻辑与此逐字一致。
 *
 * ── 关键设计:led 缺席时的默认 ────────────────────────────────
 * 后端 `chat/tools.ts` 的 push_device 现已发 `{text, led}`(`led` 走白名单、缺席兜
 * `breath_blue`);本条是**防御**:万一某条 `remind` 仍无 led,若 clamp 成 off 则"提醒即静默"
 * —— 违背 `remind` 语义。故:**有文本、无 led → 默认闪一下提醒**;无文本、无 led → off。
 *
 * 效果名沿用契约 §5 示例 `breath_blue` 的 `<effect>_<color>` 命名:
 *   effect ∈ { off, on|solid, blink|flash, breath|pulse }
 *   color  ∈ { blue, green, red, white, yellow, cyan, purple, orange }(可选)
 * 未知效果名 → 回落默认(有文本则闪,否则 off),**不报错、不点常亮**(安全默认)。
 *
 * 参数是**设备内部实现**(LED 型号/数量不同),故不进契约 —— 与 weight_comp / level_filter 同理。
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// ── 灯效参数与边界(设备内部;不进契约)──────────────────────────
/** 闪烁/呼吸的默认周期(ms)。 */
#define LED_DEFAULT_PERIOD_MS 500
/** 周期下限(ms):防下发过密导致可见频闪。 */
#define LED_PERIOD_MIN_MS 100
/** 周期上限(ms):防"闪一下"变成"瞪着眼"。 */
#define LED_PERIOD_MAX_MS 5000
/** 闪烁默认次数。 */
#define LED_DEFAULT_BLINK_COUNT 3
/** 闪烁次数上限:防下发巨量导致电池耗光。 */
#define LED_BLINK_COUNT_MAX 20

/** 灯效种类。 */
typedef enum {
    LED_OFF = 0,      /**< 灭 */
    LED_SOLID,        /**< 常亮(直到被下一条灯效覆盖) */
    LED_BLINK,        /**< 闪 count 下(周期 period_ms) */
    LED_BREATH,       /**< 呼吸(周期 period_ms),单色 LED 用占空比模拟 */
} led_effect_t;

/** 颜色分量(单色 LED 驱动不吃,仅日志 / 将来 RGB 复用)。 */
typedef enum {
    LED_COLOR_NONE = 0,
    LED_COLOR_BLUE,
    LED_COLOR_GREEN,
    LED_COLOR_RED,
    LED_COLOR_WHITE,
    LED_COLOR_YELLOW,
    LED_COLOR_CYAN,
    LED_COLOR_PURPLE,
    LED_COLOR_ORANGE,
} led_color_t;

/** 一条灯效(调用方持有;led_pattern_from_remind 填充)。 */
typedef struct {
    led_effect_t effect;
    led_color_t color;    /**< 解析出的颜色(单色 LED 忽略) */
    uint32_t period_ms;   /**< blink/breath 的周期;SOLID/OFF 时无意义 */
    int count;            /**< blink 的次数;其余无意义 */
} led_pattern_t;

/**
 * 把 `remind` 的 led 字符串 + 有无文本 → 灯效。
 *
 * @param led_str     契约 §5 的 led 名(如 "breath_blue");NULL 或空 = 未提供
 * @param has_text    该 remind 是否带非空文本(决定"未提供 led"时的默认)
 * @return 灯效(effect 恒为合法值;未知名字 → 安全默认)
 */
led_pattern_t led_pattern_from_remind(const char *led_str, bool has_text);

/**
 * 把明确的 (effect, color, period_ms, count) 规格 → 钳制后的灯效。
 * 供 `config` 的 LED 策略键(未来)与单测直接构造边界用。
 * period_ms <=0 → 默认周期;否则 clamp 到 [MIN,MAX]。count <=0 → 默认;否则 clamp 到 [1,MAX]。
 */
led_pattern_t led_pattern_make(led_effect_t effect, led_color_t color, int period_ms, int count);

/** 效果名(不含颜色)→ 枚举;未知返回 false(调用方走默认)。 */
bool led_effect_parse(const char *name, led_effect_t *out);

/** 颜色名 → 枚举;未知返回 false(颜色可选,解析失败不影响效果)。 */
bool led_color_parse(const char *name, led_color_t *out);

/** 日志用:枚举 → 名字(永不返回 NULL)。 */
const char *led_effect_str(led_effect_t e);
const char *led_color_str(led_color_t c);

/** 是否"需要点灯"(OFF 之外都要驱动;主循环据此决定是否调 led_driver)。 */
bool led_pattern_is_active(const led_pattern_t *p);

#ifdef __cplusplus
}
#endif
