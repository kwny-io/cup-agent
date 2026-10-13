/**
 * 成长庆祝 —— 实现(纯 C,零 IDF)。
 * 详见 celebr.h 的立场说明。取值全部经 cmd_payload_*(手写极小 JSON 扫描,不引 cJSON)。
 */
#include "celebr.h"

#include <string.h>

#include "cmd_payload.h"

/** reason 字段的最大缓存长度(够放 'milestone' 即可) */
#define CELEBR_REASON_CAP 16

bool celebr_is_milestone(const char *json, const char *cmd_id) {
    if (json == NULL || cmd_id == NULL) return false;
    char reason[CELEBR_REASON_CAP] = {0};
    if (!cmd_payload_str(json, cmd_id, "reason", reason, sizeof(reason))) return false;
    return strcmp(reason, "milestone") == 0;
}

bool celebr_plan(const char *json, const char *cmd_id, celebr_plan_t *out) {
    if (out == NULL) return false;
    if (!celebr_is_milestone(json, cmd_id)) return false;

    memset(out, 0, sizeof(*out));

    // kind 仅用于"在庆祝变体里挑一个";未知/缺失 → 默认庆祝脸(绝不因此不庆祝)
    char kind[16] = {0};
    if (cmd_payload_str(json, cmd_id, "kind", kind, sizeof(kind))) {
        if (strcmp(kind, "streak") == 0) {
            out->eye = EYE_SMUG;
            out->eye_seconds = CELEBR_EYE_S_STREAK;
        } else if (strcmp(kind, "refill") == 0) {
            out->eye = EYE_CONTENT;
            out->eye_seconds = CELEBR_EYE_S_REFILL;
        } else if (strcmp(kind, "together") == 0) {
            out->eye = EYE_CONTENT;
            out->eye_seconds = CELEBR_EYE_S_TOGETHER;
        } else if (strcmp(kind, "achieved") == 0) {
            out->eye = EYE_CONTENT;
            out->eye_seconds = CELEBR_EYE_S_ACHIEVED;
        }
        // 其余情况落到下方默认
    }
    if (out->eye_seconds <= 0.0f) {
        out->eye = EYE_CONTENT;
        out->eye_seconds = CELEBR_EYE_S_DEFAULT;
    }

    // 庆祝灯:闪三下(黄);id/label 取出仅作日志
    out->led = led_pattern_make(LED_BLINK, LED_COLOR_YELLOW, CELEBR_LED_PERIOD_MS,
                                CELEBR_LED_BLINK_COUNT);
    cmd_payload_str(json, cmd_id, "id", out->id, sizeof(out->id));
    cmd_payload_str(json, cmd_id, "label", out->label, sizeof(out->label));
    return true;
}
