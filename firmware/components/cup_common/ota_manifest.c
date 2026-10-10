/**
 * ota manifest 解析与校验实现 —— 手写极小 JSON 扫描(与 command_parse.c / cmd_payload.c 同立场)。
 *
 * 为什么本模块自带一份 tokenizer(而非全复用 cmd_payload.*):sha256 必须**恰好 64 个 hex 字符**,
 * 而 cmd_payload_str 超长会**静默截断到 cap** —— 一份 70 字符的 sha256 会被截成 64 而"看起来合法"。
 * 这正是 ota 最核心的门禁,不能容忍。故这里自带可**回报真实长度**的扫描(与 cmd_payload 各持一份,
 * 同"各模块各持一份 tokenizer、互不耦合"的惯例)。
 */
#include "ota_manifest.h"

#include <string.h>

// ── 极小 tokenizer ────────────────────────────────────────────────

static const char *skip_ws(const char *p) {
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    return p;
}

/**
 * 解析一个 JSON 字符串(*p 指向开引号)。dst 为 NULL 时只量长度不拷贝。
 * @param out_len 非 NULL 时写入**真实解码后**的字符数(不受 cap 截断影响)
 */
static const char *parse_string_len(const char *p, char *dst, size_t cap, size_t *out_len) {
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
        if (dst && n + 1 < cap) dst[n] = c;
        n++;
        p++;
    }
    if (dst) dst[n < cap ? n : cap - 1] = '\0';
    if (out_len) *out_len = n;
    if (*p == '"') p++;
    return p;
}

/** 跳过一个任意 JSON 值(字符串/对象/数组/标量)。返回其后的位置。 */
static const char *skip_value(const char *p) {
    p = skip_ws(p);
    char c = *p;
    if (c == '"') return parse_string_len(p, NULL, 0, NULL);
    if (c == '{' || c == '[') {
        char open = c, close = (c == '{') ? '}' : ']';
        int depth = 0;
        while (*p != '\0') {
            if (*p == '"') { p = parse_string_len(p, NULL, 0, NULL); continue; }
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
    while (*p >= '0' && *p <= '9') { v = v * 10 + (*p - '0'); p++; }
    *out = neg ? -v : v;
    *pp = p;
    return true;
}

/** 在 payload 对象 [start,end) 内找 key 的字符串值,回报真实长度。 */
static bool find_str(const char *start, const char *end, const char *key, char *out,
                     size_t cap, size_t *out_len) {
    const char *p = skip_ws(start);
    if (*p != '{') return false;
    p = skip_ws(p + 1);
    while (p < end && *p == '"') {
        char k[32] = {0};
        p = parse_string_len(p, k, sizeof(k), NULL);
        p = skip_ws(p);
        if (*p == ':') p++;
        p = skip_ws(p);
        if (strcmp(k, key) == 0) {
            if (*p != '"') return false;   // 命中 key 但值非字符串 → false
            parse_string_len(p, out, cap, out_len);
            return true;
        }
        p = skip_value(p);
        p = skip_ws(p);
        if (*p == ',') { p = skip_ws(p + 1); }
        else break;
    }
    return false;
}

/** 在 payload 对象 [start,end) 内找 key 的整数值。 */
static bool find_i64(const char *start, const char *end, const char *key, int64_t *out) {
    const char *p = skip_ws(start);
    if (*p != '{') return false;
    p = skip_ws(p + 1);
    while (p < end && *p == '"') {
        char k[32] = {0};
        p = parse_string_len(p, k, sizeof(k), NULL);
        p = skip_ws(p);
        if (*p == ':') p++;
        p = skip_ws(p);
        if (strcmp(k, key) == 0) return parse_i64(&p, out);
        p = skip_value(p);
        p = skip_ws(p);
        if (*p == ',') { p = skip_ws(p + 1); }
        else break;
    }
    return false;
}

/** 按 cmd_id 定位那条指令的 payload 对象起止 [*s,*e)(与 cmd_payload.c 同款)。 */
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
                p = parse_string_len(p, k, sizeof(k), NULL);
                p = skip_ws(p);
                if (*p == ':') p++;
                p = skip_ws(p);
                if (strcmp(k, "cmd_id") == 0) {
                    p = parse_string_len(p, cid, sizeof(cid), NULL);
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
            if (strcmp(cid, cmd_id) == 0 && pay_s && pay_e) {
                *s = pay_s;
                *e = pay_e;
                return true;
            }
        } else {
            p = skip_value(p);
        }
        p = skip_ws(p);
        if (*p == ',') { p = skip_ws(p + 1); }
        else break;
    }
    return false;
}

// ── 校验小工具 ────────────────────────────────────────────────────

static bool is_hex(char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

static int hex_nibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static bool has_prefix(const char *s, const char *pfx) {
    while (*pfx) {
        if (*s != *pfx) return false;
        s++;
        pfx++;
    }
    return true;
}

// ── 对外 ──────────────────────────────────────────────────────────

bool ota_sha256_to_bytes(const char *hex, uint8_t out[OTA_SHA256_BYTES]) {
    if (!hex || !out || strlen(hex) != OTA_SHA256_HEX) return false;
    for (size_t i = 0; i < OTA_SHA256_BYTES; i++) {
        int hi = hex_nibble(hex[i * 2]);
        int lo = hex_nibble(hex[i * 2 + 1]);
        if (hi < 0 || lo < 0) return false;
        out[i] = (uint8_t)((hi << 4) | lo);
    }
    return true;
}

bool ota_manifest_parse(const char *json, const char *cmd_id, ota_manifest_t *out) {
    if (!out) return false;

    const char *s, *e;
    if (!locate_payload(json, cmd_id, &s, &e)) return false;

    ota_manifest_t m;
    memset(&m, 0, sizeof(m));

    // url:非空、长度 [8, OTA_URL_MAX]、带 http:// 或 https:// 前缀
    size_t url_len = 0;
    if (!find_str(s, e, "url", m.url, sizeof(m.url), &url_len)) return false;
    if (url_len < 8 || url_len > OTA_URL_MAX) return false;
    if (!has_prefix(m.url, "http://") && !has_prefix(m.url, "https://")) return false;

    // sha256:恰好 64 个 hex 字符
    size_t sha_len = 0;
    if (!find_str(s, e, "sha256", m.sha256, sizeof(m.sha256), &sha_len)) return false;
    if (sha_len != OTA_SHA256_HEX) return false;
    for (size_t i = 0; i < OTA_SHA256_HEX; i++) {
        if (!is_hex(m.sha256[i])) return false;
    }

    // size:整数、> 0(含拒掉契约示例里的占位 0)且 ≤ 上限
    int64_t size = 0;
    if (!find_i64(s, e, "size", &size)) return false;
    if (size <= 0 || size > OTA_SIZE_MAX) return false;
    m.size = size;

    *out = m;
    return true;
}
