/**
 * 成长庆祝(纯 C,零 IDF 依赖)—— 可宿主单测。
 *
 * ── 这是什么 ────────────────────────────────────────────────────
 * 养成闭环(一起多久 / 连续达标 / 累计达标 / 续杯)在后端 `growth.ts` 里派生出里程碑;
 * 用户**今天新跨一道坎**时,后端旁挂一条 `remind` 下行,payload 里带
 * `reason:'milestone'`。本模块做**设备端那半**:认出这条提醒,并把它翻译成
 * "硬件脸的一段庆祝表情 + 一记庆祝灯效"。
 *
 * payload 形状(与后端 growth-notify 逐字对齐,见窗口 A 的 diff):
 *   { "reason":"milestone", "id":"together_7", "label":"一起一周",
 *     "kind":"together", "threshold":7 }
 * 只有 `reason` 是**判定入口**(恒等于字面量 'milestone');`id`/`label`/`kind`/`threshold`
 * 都是元信息,固件**可选**消费。
 *
 * ── 分工按 P3:判定在后端,摆脸在端侧 ─────────────────────────────
 * "今天有没有跨里程碑"是后端算的 —— 本模块**绝不**自己判定是否该庆祝。
 * 它只回答:"这条 remind 是不是庆祝?是 → 摆成什么脸、打什么灯。"
 * `kind` 仅用于**在庆祝变体里挑一个**(一起→满足弧眼、连击→得意);
 * kind 缺失/未知 → 一律回落到**默认庆祝脸**(绝不因此不庆祝)。
 *
 * ── 为什么单独一个模块 ──────────────────────────────────────────
 * 与 cmd_exec / led_pattern 同一取舍:把"字符串 → 状态/时长"的映射、未知值回落、
 * 时长边界这些**最容易写错**的部分抽成零依赖纯 C,在 PC 上钉死;真板逻辑与此逐字一致。
 * 主循环只做"投递"(见 lid_main 的表情端口),不在此模块里。
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "eye_state.h"
#include "led_pattern.h"

#ifdef __cplusplus
extern "C" {
#endif

/** 庆祝灯的默认参数(设备内部;不进契约)。 */
#define CELEBR_LED_PERIOD_MS 300
#define CELEBR_LED_BLINK_COUNT 3
/** 庆祝表情的持续时长(秒)—— 各类别;均为 [待实测] 的工程默认。 */
#define CELEBR_EYE_S_DEFAULT 3.5f
#define CELEBR_EYE_S_TOGETHER 4.0f
#define CELEBR_EYE_S_STREAK 4.0f
#define CELEBR_EYE_S_ACHIEVED 4.0f
#define CELEBR_EYE_S_REFILL 3.0f

/** 一条庆祝的**呈现计划**(纯数据;调用方拿去摆脸 / 打灯)。 */
typedef struct {
    eye_state_t eye;      /**< 一次性表情(经 eyes_note_expression 应用) */
    float eye_seconds;    /**< 表情持续秒数(>0) */
    led_pattern_t led;    /**< 庆祝灯效(恒为合法值) */
    char id[40];          /**< 里程碑 id(日志用;缺失则空串) */
    char label[64];       /**< 里程碑中文名(日志用;缺失则空串) */
} celebr_plan_t;

/**
 * 这条 `remind` 是不是"成长庆祝"?
 * 只认 `payload.reason == "milestone"` 一个条件;其余键一律不看。
 *
 * @param json    下行数组原文(与喂给 cmd_parse_payload 的同一段)
 * @param cmd_id  目标指令 id(精确定位那条对象)
 * @return true = 是庆祝提醒
 */
bool celebr_is_milestone(const char *json, const char *cmd_id);

/**
 * 把一条庆祝 `remind` → 呈现计划。**非庆祝 → 返回 false(调用方走原 remind 路径)**。
 *
 * 映射规则(纯呈现,非业务判定):
 *   kind "together" → 满足弧眼(EYE_CONTENT)4.0s
 *   kind "streak"   → 得意微眯(EYE_SMUG)  4.0s
 *   kind "achieved" → 满足弧眼(EYE_CONTENT)4.0s
 *   kind "refill"   → 满足弧眼(EYE_CONTENT)3.0s
 *   其余 / 缺失   → 默认庆祝(EYE_CONTENT)3.5s
 * 灯效恒为"庆祝闪三下"(黄,300ms 周期,3 次)。
 *
 * @param out 命中时填充(调用方持有;各字符串以 NUL 结尾,超长截断)
 * @return true = 是庆祝且 out 已填充
 */
bool celebr_plan(const char *json, const char *cmd_id, celebr_plan_t *out);

#ifdef __cplusplus
}
#endif
