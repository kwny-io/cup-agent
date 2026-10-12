/**
 * 宿主单测 —— 设备一次性 claim code 的纯 C 层(claim_code.c)。零 IDF,mingw 直接跑。
 * 覆盖:生成形状/字母表/确定性、规范化容错(空格/连字符/大小写/0↔O/1↔I,L)、
 * 常量时间比对(长度不等/逐字差),时效(过期/倒挂/边界),一站式校验(用过/过期/错码)。
 */
#include "claim_code.h"

#include <stdio.h>
#include <string.h>

static int g_fail = 0, g_total = 0;
static void ok(int cond, const char *what) {
    g_total++;
    if (!cond) { g_fail++; printf("  ✗ %s\n", what); }
    else printf("  ✓ %s\n", what);
}

static int in_alphabet(char c) {
    return strchr(CUP_CLAIM_ALPHABET, c) != NULL;
}

static void test_generate(void) {
    printf("[生成:定长/字母表内/NUL 结尾]\n");
    char code[CUP_CLAIM_BUF];
    ok(claim_code_generate(12345, code, sizeof(code)), "生成成功");
    ok(strlen(code) == CUP_CLAIM_LEN, "长度恰 8");
    int all_in = 1;
    for (size_t i = 0; i < strlen(code); i++) if (!in_alphabet(code[i])) all_in = 0;
    ok(all_in, "每个字符都在 Crockford 字母表内(无 I/L/O/U)");
    ok(strchr(code, 'I') == NULL && strchr(code, 'L') == NULL &&
       strchr(code, 'O') == NULL && strchr(code, 'U') == NULL,
       "确无易混字符 I/L/O/U");

    printf("[确定性:同种子 → 同码]\n");
    char a[CUP_CLAIM_BUF], b[CUP_CLAIM_BUF];
    claim_code_generate(999, a, sizeof(a));
    claim_code_generate(999, b, sizeof(b));
    ok(strcmp(a, b) == 0, "seed=999 两次生成一致");

    printf("[分布:不同种子 → 不同码(抽查)]\n");
    char c1[CUP_CLAIM_BUF], c2[CUP_CLAIM_BUF];
    claim_code_generate(1, c1, sizeof(c1));
    claim_code_generate(2, c2, sizeof(c2));
    ok(strcmp(c1, c2) != 0, "seed 1 vs 2 不同");

    printf("[缓冲不足 → 拒绝]\n");
    char tiny[4];
    ok(!claim_code_generate(1, tiny, sizeof(tiny)), "out_len<9 拒绝");
    ok(!claim_code_generate(1, NULL, 0), "NULL 拒绝");
}

static void test_normalize(void) {
    printf("[规范化:大小写/空格/连字符/下划线]\n");
    char out[CUP_CLAIM_BUF];
    ok(claim_code_normalize("abcd2345", out, sizeof(out)) && strcmp(out, "ABCD2345") == 0,
       "小写 → 大写");
    ok(claim_code_normalize(" ABCD-2345 ", out, sizeof(out)) && strcmp(out, "ABCD2345") == 0,
       "去首尾空白 + 连字符");
    ok(claim_code_normalize("ABCD_2345", out, sizeof(out)) && strcmp(out, "ABCD2345") == 0,
       "去下划线");

    printf("[Crockford 容错:O→0, I/L→1]\n");
    ok(claim_code_normalize("O1234567", out, sizeof(out)) && strcmp(out, "01234567") == 0,
       "O → 0");
    ok(claim_code_normalize("I2345678", out, sizeof(out)) && strcmp(out, "12345678") == 0,
       "I → 1");
    ok(claim_code_normalize("l2345678", out, sizeof(out)) && strcmp(out, "12345678") == 0,
       "l(小写 L) → 1");

    printf("[形状不合法 → false]\n");
    ok(!claim_code_normalize("ABC", out, sizeof(out)), "太短拒绝");
    ok(!claim_code_normalize("ABCDEFGHJ", out, sizeof(out)), "太长拒绝");
    ok(!claim_code_normalize("ABC!2345", out, sizeof(out)), "'!' 字母表外拒绝");
    ok(!claim_code_normalize("", out, sizeof(out)), "空串拒绝");
    ok(!claim_code_normalize(NULL, out, sizeof(out)), "NULL 拒绝");

    printf("[Crockford 边界:U 不在字母表 → 拒]\n");
    ok(!claim_code_normalize("ABCDU234", out, sizeof(out)), "含 U 拒绝");
}

static void test_equal(void) {
    printf("[比对:相等/长度不等/逐字差/常量时间语义]\n");
    ok(claim_code_equal("ABCD2345", "ABCD2345"), "相同 → true");
    ok(!claim_code_equal("ABCD2345", "ABCD2346"), "末位差 → false");
    ok(!claim_code_equal("ABCD2345", "ABCD234"), "长度不等 → false");
    ok(claim_code_equal("", ""), "两空串 → 相等(边界;长度非秘密)");
    ok(!claim_code_equal(NULL, "ABCD2345"), "NULL → false");
    ok(!claim_code_equal("ABCD2345", NULL), "右 NULL → false");
}

static void test_fresh(void) {
    printf("[时效:有效期内 / 过期 / 边界 / 倒挂 / 未知名签发时刻]\n");
    uint64_t t0 = 1700000000000ull;
    ok(claim_code_fresh(t0, t0), "刚签发 → 有效");
    ok(claim_code_fresh(t0, t0 + CUP_CLAIM_TTL_MS), "恰在 TTL 边界 → 有效(≤)");
    ok(!claim_code_fresh(t0, t0 + CUP_CLAIM_TTL_MS + 1), "过 TTL 1ms → 过期");
    ok(!claim_code_fresh(0, t0), "签发时刻 0(未知)→ 视为过期");
    ok(!claim_code_fresh(t0 + 5000, t0), "now 早于签发(时钟倒挂)→ 过期");
}

static void test_verify(void) {
    printf("[一站式校验]\n");
    uint64_t t0 = 1700000000000ull;
    char code[CUP_CLAIM_BUF];
    claim_code_generate(777, code, sizeof(code));

    ok(claim_code_verify(code, code, t0, false, t0 + 1000), "正确码 + 未用 + 未过期 → true");
    ok(claim_code_verify(" ABCD-2345 ", "ABCD2345", t0, false, t0), "带空格/连字符的输入仍收敛");
    ok(!claim_code_verify(code, code, t0, true, t0 + 1000), "已用过 → false(一次性)");
    ok(!claim_code_verify(code, code, t0, false, t0 + CUP_CLAIM_TTL_MS + 1), "过期 → false");
    ok(!claim_code_verify("WRONGCODE", code, t0, false, t0 + 1000), "错码 → false");
    ok(!claim_code_verify("ABC", code, t0, false, t0 + 1000), "形状非法 → false");
    ok(!claim_code_verify(code, code, 0, false, t0 + 1000), "签发时刻未知 → false");
}

int main(void) {
    printf("== claim_code 宿主单测 ==\n");
    test_generate();
    test_normalize();
    test_equal();
    test_fresh();
    test_verify();
    printf("\n== %d/%d 通过,%d 失败 ==\n", g_total - g_fail, g_total, g_fail);
    return g_fail == 0 ? 0 : 1;
}
