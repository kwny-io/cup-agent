/**
 * 下行指令 payload 取值实现 —— 手写极小 JSON 扫描(与 command_parse.c 同立场)。
 * 不引 cJSON:形状固定(顶层数组 + 对象 + 扁平 payload),手写更短、可审计、零依赖。
 */
#include "cmd_payload.h"

#include <string.h>

// ── 极小 tokenizer(与 command_parse.c 同款;各模块各持一份、互不耦合)──────

static const char *skip_ws(const char *p) {
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    return p;
}

/** 解析一个 JSON 字符串(*p 指向开引号)。dst 为 NULL 时只前进不拷贝。 */
static const char *parse_string(const char *p, char *dst, size_t cap) {
    size_t n = 0;
    if (*p == '"') p++;
    while (*p != '\0' && *p != '"') {
        char c = *p;
        if (c == '\\' && p[1] != '\0') {
            p++;
            char e = *p;
            switch (e) {
                case 'n': c = '\n'; break;
                case 't': c = '\t'; break;
                case 'r': c = '\r'; break;
                default: c = e; break;
            }
        }
        if (dst && n + 1 < cap) dst[n++] = c;
        p++;
    }
    if (dst) dst[n] = '\0';
    if (*p == '"') p++;
    return p;
}

/** 跳过一个任意 JSON 值(字符串/对象/数组/标量)。返回其后的位置。 */
static const char *skip_value(const char *p) {
    p = skip_ws(p);
    char c = *p;
    if (c == '"') return parse_string(p, NULL, 0);
    if (c == '{' || c == '[') {
        char open = c, close = (c == '{') ? '}' : ']';
        int depth = 0;
        while (*p != '\0') {
            if (*p == '"') { p = parse_string(p, NULL, 0); continue; }
            if (*p == open) depth++;
            else if (*p == close) {
                depth--;
                p++;
                if (depth == 0) return p;
                continue;
            }
            p++;
        }
        return p;
    }
    while (*p != '\0' && *p != ',' && *p != '}' && *p != ']' &&
           *p != ' ' && *p != '\t' && *p != '\r' && *p != '\n') {
        p++;
    }
    return p;
}

/** 解析一个有符号整数;非法(无数字)返回 false 且不前移 out。 */
static bool parse_i64(const char **pp, int64_t *out) {
    const char *p = skip_ws(*pp);
    bool neg = false;
    if (*p == '-') { neg = true; p++; }
    if (!(*p >= '0' && *p <= '9')) return false;
    int64_t v = 0;
    while (*p >= '0' && *p <= '9') {
        v = v * 10 + (*p - '0');
        p++;
    }
    *out = neg ? -v : v;
    *pp = p;
    return true;
}

/** 在 payload 对象 [start,end) 内找 key 的整数值。 */
static bool payload_find_int(const char *start, const char *end, const char *key,
                             int64_t *out) {
    const char *p = skip_ws(start);
    if (*p != '{') return false;
    p = skip_ws(p + 1);
    while (p < end && *p == '"') {
        char k[32] = {0};
        p = parse_string(p, k, sizeof(k));
        p = skip_ws(p);
        if (*p == ':') p++;
        p = skip_ws(p);
        if (strcmp(k, key) == 0) {
            return parse_i64(&p, out);   // 命中 key 但值非整数 → false
        }
        p = skip_value(p);
        p = skip_ws(p);
        if (*p == ',') { p = skip_ws(p + 1); }
        else break;
    }
    return false;
}

/** 在 payload 对象 [start,end) 内找 key 的字符串值。 */
static bool payload_find_str(const char *start, const char *end, const char *key, char *out,
                             size_t cap) {
    const char *p = skip_ws(start);
    if (*p != '{') return false;
    p = skip_ws(p + 1);
    while (p < end && *p == '"') {
        char k[32] = {0};
        p = parse_string(p, k, sizeof(k));
        p = skip_ws(p);
        if (*p == ':') p++;
        p = skip_ws(p);
        if (strcmp(k, key) == 0) {
            if (*p != '"') return false;   // 命中 key 但值非字符串 → false
            parse_string(p, out, cap);
            return true;
        }
        p = skip_value(p);
        p = skip_ws(p);
        if (*p == ',') { p = skip_ws(p + 1); }
        else break;
    }
    return false;
}

// ── 顶层 ──────────────────────────────────────────────────────────

/**
 * 在下行数组原文里按 cmd_id 定位那条指令,给出其 payload 对象的起止 [*s,*e)。
 * @return true = 找到该 cmd_id 且它有 payload 对象;false = 没找到
 */
static bool locate_payload(const char *json, const char *cmd_id, const char **s,
                           const char **e) {
    if (!json || !cmd_id || !*cmd_id) return false;

    const char *p = skip_ws(json);
    if (*p != '[') return false;
    p = skip_ws(p + 1);

    while (*p != '\0' && *p != ']') {
        if (*p == '{') {
            char cid[40] = {0};
            const char *pay_s = NULL, *pay_e = NULL;
            p = skip_ws(p + 1);
            while (*p == '"') {
                char k[24] = {0};
                p = parse_string(p, k, sizeof(k));
                p = skip_ws(p);
                if (*p == ':') p++;
                p = skip_ws(p);
                if (strcmp(k, "cmd_id") == 0) {
                    p = parse_string(p, cid, sizeof(cid));
                } else if (strcmp(k, "payload") == 0) {
                    pay_s = p;
                    p = skip_value(p);
                    pay_e = p;
                } else {
                    p = skip_value(p);
                }
                p = skip_ws(p);
                if (*p == ',') { p = skip_ws(p + 1); }
                else break;
            }
            if (*p == '}') p++;
            // 只有 cmd_id 匹配的那条才取 payload(一条下行可能同时来多条指令)
            if (strcmp(cid, cmd_id) == 0 && pay_s && pay_e) {
                *s = pay_s;
                *e = pay_e;
                return true;
            }
        } else {
            p = skip_value(p);   // 数组里的非对象元素 —— 跳过
        }
        p = skip_ws(p);
        if (*p == ',') { p = skip_ws(p + 1); }
        else break;
    }
    return false;
}

bool cmd_payload_i64(const char *json, const char *cmd_id, const char *key, int64_t *out) {
    if (!key || !*key || !out) return false;
    const char *s, *e;
    if (!locate_payload(json, cmd_id, &s, &e)) return false;
    return payload_find_int(s, e, key, out);
}

bool cmd_payload_str(const char *json, const char *cmd_id, const char *key, char *out,
                     size_t cap) {
    if (!key || !*key || !out || cap == 0) return false;
    const char *s, *e;
    if (!locate_payload(json, cmd_id, &s, &e)) return false;
    return payload_find_str(s, e, key, out, cap);
}
