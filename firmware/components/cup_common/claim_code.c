/**
 * 设备一次性 claim code 的纯 C 实现。见 claim_code.h 的说明。
 * 零 IDF 依赖:不读时钟、不碰 RNG —— 种子由调用方给,时间由调用方传 → 宿主单测可注入。
 */
#include "claim_code.h"

#include <string.h>

// 多留 1 字节放结尾 NUL(32 个字符的串面量需要 33 字节,否则编译器截掉 NUL 并告警)。
static const char kAlphabet[CUP_CLAIM_ALPHABET_LEN + 1] = CUP_CLAIM_ALPHABET;

/** 字符是否在字母表内(返回其索引,否则 -1)。 */
static int alphabet_index(char c) {
    for (int i = 0; i < CUP_CLAIM_ALPHABET_LEN; i++) {
        if (kAlphabet[i] == c) return i;
    }
    return -1;
}

/**
 * splitmix64 —— 由单一种子扩展出足量伪随机位(8×5=40 bit)。
 * 用标准 splitmix64(finalizer 常数来自 Vigna 的公开定义):分布好、无状态、可复现。
 */
static uint64_t splitmix64(uint64_t *state) {
    uint64_t z = (*state += 0x9E3779B97F4A7C15ull);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
    return z ^ (z >> 31);
}

bool claim_code_generate(uint64_t seed, char *out, size_t out_len) {
    if (!out || out_len < (size_t)CUP_CLAIM_LEN + 1) return false;
    uint64_t st = seed;
    uint64_t bits = splitmix64(&st);
    for (int i = 0; i < CUP_CLAIM_LEN; i++) {
        // 每字符取 5 bit(40 bit 正好用满;每轮左移,高位先出)。
        int idx = (int)((bits >> (64 - 5 * (i + 1))) & 0x1Full);
        out[i] = kAlphabet[idx];
    }
    out[CUP_CLAIM_LEN] = '\0';
    return true;
}

bool claim_code_normalize(const char *in, char *out, size_t out_len) {
    if (!in || !out) return false;
    size_t n = 0;
    for (const char *p = in; *p; p++) {
        char c = *p;
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '-' || c == '_') {
            continue;  // 分隔符:手抄/分组时会有,丢弃
        }
        if (c >= 'a' && c <= 'z') c = (char)(c - 'a' + 'A');
        // Crockford 容错:易混字符映射回数字。
        if (c == 'I' || c == 'L') c = '1';
        else if (c == 'O') c = '0';
        if (n + 1 >= out_len) return false;  // 装不下 → 太长,必非法
        out[n++] = c;
    }
    out[n] = '\0';
    if (n != (size_t)CUP_CLAIM_LEN) return false;
    for (size_t i = 0; i < n; i++) {
        if (alphabet_index(out[i]) < 0) return false;  // 字母表外字符
    }
    return true;
}

bool claim_code_equal(const char *a, const char *b) {
    if (!a || !b) return false;
    size_t la = strlen(a), lb = strlen(b);
    if (la != lb) return false;  // 长度本非秘密
    unsigned char diff = 0;
    for (size_t i = 0; i < la; i++) {
        diff |= (unsigned char)(a[i] ^ b[i]);  // 不短路:恒定时间
    }
    return diff == 0;
}

bool claim_code_fresh(uint64_t issued_at_ms, uint64_t now_ms) {
    if (issued_at_ms == 0) return false;  // 签发时刻未知 → 宁缺毋滥
    if (now_ms < issued_at_ms) return false;  // 时钟倒挂(异常)
    return (now_ms - issued_at_ms) <= CUP_CLAIM_TTL_MS;
}

bool claim_code_verify(const char *input, const char *stored_code,
                       uint64_t issued_at_ms, bool used, uint64_t now_ms) {
    if (used) return false;  // 一次性:用过即废
    if (!claim_code_fresh(issued_at_ms, now_ms)) return false;
    char norm[CUP_CLAIM_BUF];
    if (!claim_code_normalize(input, norm, sizeof(norm))) return false;
    return claim_code_equal(norm, stored_code);
}
