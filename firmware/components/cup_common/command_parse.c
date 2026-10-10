/**
 * 下行指令解析实现 —— 手写极小 JSON 扫描器(只认契约 §5 的扁平形状)。
 * 不做通用 JSON:省依赖、省 flash,且形状固定使代码可审计。
 */
#include "command_parse.h"

#include <string.h>

// ── 极小 tokenizer ────────────────────────────────────────────────

static void skip_ws(const char **p) {
    while (**p == ' ' || **p == '\t' || **p == '\r' || **p == '\n') (*p)++;
}

/** 解析一个 JSON 字符串(调用时 *p 指向开引号)。把内容拷进 dst(带 NUL)。 */
static void parse_string(const char **p, char *dst, size_t cap) {
    size_t n = 0;
    if (**p == '"') (*p)++;
    while (**p != '\0' && **p != '"') {
        char c = **p;
        if (c == '\\' && (*p)[1] != '\0') {
            (*p)++;
            char e = **p;
            switch (e) {
                case 'n': c = '\n'; break;
                case 't': c = '\t'; break;
                case 'r': c = '\r'; break;
                default: c = e; break;  // \" \\ \/ \uXXXX 的 \u 这里降级为字面量,契约里不会出现
            }
        }
        if (n + 1 < cap) dst[n++] = c;
        (*p)++;
    }
    if (dst) dst[n] = '\0';
    if (**p == '"') (*p)++;
}

/** 跳过一个任意 JSON 值(payload 是嵌套对象,形状任意 —— 整体跳过)。 */
static void skip_value(const char **p) {
    skip_ws(p);
    char c = **p;
    if (c == '"') {
        char dummy[1];
        parse_string(p, dummy, 0);  // cap 0 → 只前进不拷贝
        return;
    }
    if (c == '{' || c == '[') {
        char open = c, close = (c == '{') ? '}' : ']';
        int depth = 0;
        while (**p != '\0') {
            char d = **p;
            if (d == '"') {  // 字符串里的括号不算
                char dummy[1];
                parse_string(p, dummy, 0);
                continue;
            }
            if (d == open) depth++;
            else if (d == close) {
                depth--;
                (*p)++;
                if (depth == 0) return;
                continue;
            }
            (*p)++;
        }
        return;
    }
    // 数字 / true / false / null:吃到分隔符
    while (**p != '\0' && **p != ',' && **p != '}' && **p != ']' &&
           **p != ' ' && **p != '\t' && **p != '\r' && **p != '\n') {
        (*p)++;
    }
}

/** 解析一个无符号整数(Unix ms)。非法时返回 0。 */
static uint64_t parse_u64(const char **p) {
    skip_ws(p);
    uint64_t v = 0;
    bool any = false;
    while (**p >= '0' && **p <= '9') {
        v = v * 10u + (uint64_t)(**p - '0');
        any = true;
        (*p)++;
    }
    return any ? v : 0;
}

static cmd_type_t cmd_type_from_str(const char *s) {
    if (strcmp(s, "remind") == 0) return CMD_TYPE_REMIND;
    if (strcmp(s, "config") == 0) return CMD_TYPE_CONFIG;
    if (strcmp(s, "ota") == 0) return CMD_TYPE_OTA;
    if (strcmp(s, "sync_time") == 0) return CMD_TYPE_SYNC_TIME;
    return CMD_TYPE_UNKNOWN;
}

const char *cmd_type_str(cmd_type_t t) {
    switch (t) {
        case CMD_TYPE_REMIND: return "remind";
        case CMD_TYPE_CONFIG: return "config";
        case CMD_TYPE_OTA: return "ota";
        case CMD_TYPE_SYNC_TIME: return "sync_time";
        case CMD_TYPE_UNKNOWN: return "unknown";
    }
    return "unknown";
}

// ── 去重 ──────────────────────────────────────────────────────────

void cmd_dedup_init(cmd_dedup_t *d) {
    if (!d) return;
    d->seen_count = 0;
    d->seen_head = 0;
    for (int i = 0; i < CMD_DEDUP_SLOTS; i++) d->seen[i][0] = '\0';
}

bool cmd_dedup_seen(cmd_dedup_t *d, const char *cmd_id) {
    if (!d || !cmd_id) return false;
    for (int i = 0; i < d->seen_count; i++) {
        if (strcmp(d->seen[i], cmd_id) == 0) return true;
    }
    // 登记(环形覆盖最旧的)
    strncpy(d->seen[d->seen_head], cmd_id, sizeof(d->seen[0]) - 1);
    d->seen[d->seen_head][sizeof(d->seen[0]) - 1] = '\0';
    d->seen_head = (d->seen_head + 1) % CMD_DEDUP_SLOTS;
    if (d->seen_count < CMD_DEDUP_SLOTS) d->seen_count++;
    return false;
}

// ── 顶层解析 ──────────────────────────────────────────────────────

/** 解析一个 Command 对象;*p 指向 '{'。返回是否采纳入 *out(已过 target/expires/去重/type)。 */
static bool parse_command(const char **p, const char *device_id, uint64_t now_ms,
                          cmd_dedup_t *dedup, cmd_t *out) {
    char cmd_id[40] = {0};
    char target[40] = {0};
    char type_s[24] = {0};
    uint64_t expires_at = 0;
    bool has_cmd_id = false;

    skip_ws(p);
    if (**p != '{') return false;
    (*p)++;
    skip_ws(p);

    while (**p == '"') {
        char key[24] = {0};
        parse_string(p, key, sizeof(key));
        skip_ws(p);
        if (**p == ':') (*p)++;
        skip_ws(p);

        if (strcmp(key, "cmd_id") == 0) {
            parse_string(p, cmd_id, sizeof(cmd_id));
            has_cmd_id = true;
        } else if (strcmp(key, "target") == 0) {
            parse_string(p, target, sizeof(target));
        } else if (strcmp(key, "type") == 0) {
            parse_string(p, type_s, sizeof(type_s));
        } else if (strcmp(key, "expires_at") == 0) {
            expires_at = parse_u64(p);
        } else {
            skip_value(p);  // v / ts / payload / 未来字段 —— 一律跳过
        }
        skip_ws(p);
        if (**p == ',') { (*p)++; skip_ws(p); }
        else break;
    }
    if (**p == '}') (*p)++;

    if (!has_cmd_id) return false;                       // 无 id → 无法去重 → 丢
    if (target[0] != '\0' && strcmp(target, device_id) != 0) return false;  // 非本机 → 丢
    cmd_type_t type = cmd_type_from_str(type_s);
    if (type == CMD_TYPE_UNKNOWN) return false;          // 未知 type → 丢
    if (expires_at != 0 && expires_at < now_ms) return false;  // 已过期 → 丢
    if (dedup && cmd_dedup_seen(dedup, cmd_id)) return false;  // 重投 → 丢

    strncpy(out->cmd_id, cmd_id, sizeof(out->cmd_id) - 1);
    out->cmd_id[sizeof(out->cmd_id) - 1] = '\0';
    out->type = type;
    out->expires_at = expires_at;
    return true;
}

int cmd_parse_payload(const char *json, const char *device_id, uint64_t now_ms,
                      cmd_dedup_t *dedup, cmd_t *out, int out_cap) {
    if (!json || !device_id || !out || out_cap <= 0) return -1;
    const char *p = json;
    skip_ws(&p);
    if (*p != '[') return -1;  // 契约:下行恒为数组
    p++;
    skip_ws(&p);

    int n = 0;
    while (*p != '\0' && *p != ']') {
        cmd_t tmp = {0};
        if (*p == '{') {
            if (parse_command(&p, device_id, now_ms, dedup, &tmp)) {
                if (n < out_cap) out[n++] = tmp;
            }
        } else {
            // 数组里的非对象元素(数字/字符串/嵌套数组)—— 整体跳过,别让它拖垮后面的合法指令
            skip_value(&p);
        }
        skip_ws(&p);
        if (*p == ',') { p++; skip_ws(&p); }
        else break;
    }
    return n;
}
