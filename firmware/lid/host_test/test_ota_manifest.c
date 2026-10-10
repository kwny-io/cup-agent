/**
 * 宿主单测 —— 下行 ota 的 manifest 解析与校验(ota_manifest.c)。零 IDF,mingw gcc 直接跑。
 * 覆盖:合法通过、url 前缀/长度、sha256 恰 64 hex、size 范围、cmd_id 不匹配、缺字段、
 * 嵌套 payload 跳过、hex→bytes 解码。
 */
#include "ota_manifest.h"

#include <stdio.h>
#include <string.h>

static int g_fail = 0, g_total = 0;
static void ok(int cond, const char *what) {
    g_total++;
    if (!cond) { g_fail++; printf("  ✗ %s\n", what); }
    else printf("  ✓ %s\n", what);
}

// 合法 sha256(64 hex):空串的 sha256,便于逐字节断言
#define SHA_OK "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
// 合法 url(带 https:// 前缀)
#define URL_OK "https://fw.example.com/cup/base-1.0.1.bin"

static void test_valid(void) {
    printf("[合法 manifest → 通过并取全字段]\n");
    const char *json =
        "[{\"cmd_id\":\"ota-1\",\"target\":\"lid-A1B2C3\",\"type\":\"ota\",\"payload\":"
        "{\"url\":\"" URL_OK "\",\"sha256\":\"" SHA_OK "\",\"size\":524288}}]";
    ota_manifest_t m;
    ok(ota_manifest_parse(json, "ota-1", &m), "解析通过");
    ok(strcmp(m.url, URL_OK) == 0, "url 取全(未截断)");
    ok(strcmp(m.sha256, SHA_OK) == 0, "sha256 取全");
    ok(m.size == 524288, "size 取到 524288");
}

static void test_url_scheme(void) {
    printf("[url 缺 http(s):// 前缀 → 拒]\n");
    const char *j1 =
        "[{\"cmd_id\":\"o\",\"payload\":{\"url\":\"ftp://x/fw.bin\",\"sha256\":\"" SHA_OK "\",\"size\":1000}}]";
    ota_manifest_t m;
    ok(!ota_manifest_parse(j1, "o", &m), "ftp:// → false");
    const char *j2 =
        "[{\"cmd_id\":\"o\",\"payload\":{\"url\":\"fw.example.com/fw.bin\",\"sha256\":\"" SHA_OK "\",\"size\":1000}}]";
    ok(!ota_manifest_parse(j2, "o", &m), "无协议头 → false");
    // 边界:恰 8 字符的 http://a 应通过(长度下限就是 8)
    const char *j3 =
        "[{\"cmd_id\":\"o\",\"payload\":{\"url\":\"http://a\",\"sha256\":\"" SHA_OK "\",\"size\":1000}}]";
    ok(ota_manifest_parse(j3, "o", &m), "\"http://a\"(恰 8 字符)→ 通过");
}

static void test_sha256(void) {
    printf("[sha256 必须恰 64 个 hex 字符]\n");
    ota_manifest_t m;
    // 63 个
    const char *j63 =
        "[{\"cmd_id\":\"o\",\"payload\":{\"url\":\"" URL_OK "\",\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85\",\"size\":1000}}]";
    ok(!ota_manifest_parse(j63, "o", &m), "63 个 → false");
    // 65 个(多一位 —— 截断式取值会误判,这里必须拒)
    const char *j65 =
        "[{\"cmd_id\":\"o\",\"payload\":{\"url\":\"" URL_OK "\",\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b8550\",\"size\":1000}}]";
    ok(!ota_manifest_parse(j65, "o", &m), "65 个 → false(不被截断骗过)");
    // 含非 hex('z')
    const char *jbad =
        "[{\"cmd_id\":\"o\",\"payload\":{\"url\":\"" URL_OK "\",\"sha256\":\"z3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"size\":1000}}]";
    ok(!ota_manifest_parse(jbad, "o", &m), "含非 hex → false");
    // 全大写 hex 应通过
    const char *jupper =
        "[{\"cmd_id\":\"o\",\"payload\":{\"url\":\"" URL_OK "\",\"sha256\":\"E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855\",\"size\":1000}}]";
    ok(ota_manifest_parse(jupper, "o", &m), "大写 hex → 通过");
}

static void test_size(void) {
    printf("[size 必须 > 0 且 ≤ 4MB]\n");
    ota_manifest_t m;
    const char *j0 =
        "[{\"cmd_id\":\"o\",\"payload\":{\"url\":\"" URL_OK "\",\"sha256\":\"" SHA_OK "\",\"size\":0}}]";
    ok(!ota_manifest_parse(j0, "o", &m), "size=0(契约占位)→ false");
    const char *jneg =
        "[{\"cmd_id\":\"o\",\"payload\":{\"url\":\"" URL_OK "\",\"sha256\":\"" SHA_OK "\",\"size\":-1}}]";
    ok(!ota_manifest_parse(jneg, "o", &m), "size 负 → false");
    const char *jmax =
        "[{\"cmd_id\":\"o\",\"payload\":{\"url\":\"" URL_OK "\",\"sha256\":\"" SHA_OK "\",\"size\":4194304}}]";
    ok(ota_manifest_parse(jmax, "o", &m), "size=4194304(=上限)→ 通过");
    const char *jover =
        "[{\"cmd_id\":\"o\",\"payload\":{\"url\":\"" URL_OK "\",\"sha256\":\"" SHA_OK "\",\"size\":4194305}}]";
    ok(!ota_manifest_parse(jover, "o", &m), "size=上限+1 → false");
}

static void test_missing_and_mismatch(void) {
    printf("[缺字段 / cmd_id 不匹配 → false]\n");
    ota_manifest_t m;
    const char *j_no_url =
        "[{\"cmd_id\":\"o\",\"payload\":{\"sha256\":\"" SHA_OK "\",\"size\":1000}}]";
    ok(!ota_manifest_parse(j_no_url, "o", &m), "缺 url → false");
    const char *j_no_sha =
        "[{\"cmd_id\":\"o\",\"payload\":{\"url\":\"" URL_OK "\",\"size\":1000}}]";
    ok(!ota_manifest_parse(j_no_sha, "o", &m), "缺 sha256 → false");
    const char *j_no_size =
        "[{\"cmd_id\":\"o\",\"payload\":{\"url\":\"" URL_OK "\",\"sha256\":\"" SHA_OK "\"}}]";
    ok(!ota_manifest_parse(j_no_size, "o", &m), "缺 size → false");
    const char *json =
        "[{\"cmd_id\":\"ota-1\",\"payload\":{\"url\":\"" URL_OK "\",\"sha256\":\"" SHA_OK "\",\"size\":1000}}]";
    ok(!ota_manifest_parse(json, "ota-9", &m), "cmd_id 不匹配 → false");
    ok(!ota_manifest_parse(NULL, "o", &m), "NULL json → false");
}

static void test_field_order_and_nesting(void) {
    printf("[字段乱序 / 前面有嵌套对象 → 仍能取到]\n");
    // size 在前,url 在后;且 payload 里 url 之前先有一个嵌套对象
    const char *json =
        "[{\"cmd_id\":\"o\",\"payload\":{\"extra\":{\"a\":[1,2,{\"b\":\"}\"}]},\"size\":2048,"
        "\"sha256\":\"" SHA_OK "\",\"url\":\"" URL_OK "\"}}]";
    ota_manifest_t m;
    ok(ota_manifest_parse(json, "o", &m) && m.size == 2048, "跳过嵌套后取全三字段");
}

static void test_sha_to_bytes(void) {
    printf("[sha256 hex → 32 字节]\n");
    uint8_t b[OTA_SHA256_BYTES];
    ok(ota_sha256_to_bytes(SHA_OK, b), "解码成功");
    ok(b[0] == 0xe3 && b[1] == 0xb0, "首两字节 e3 b0");
    ok(b[OTA_SHA256_BYTES - 1] == 0x55, "末字节 55");
    ok(!ota_sha256_to_bytes("abcd", b), "长度不足 → false");
    ok(!ota_sha256_to_bytes("z3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", b),
       "含非 hex → false");
    ok(!ota_sha256_to_bytes(NULL, b), "NULL → false");
}

int main(void) {
    printf("== ota_manifest 宿主单测 ==\n");
    test_valid();
    test_url_scheme();
    test_sha256();
    test_size();
    test_missing_and_mismatch();
    test_field_order_and_nesting();
    test_sha_to_bytes();
    printf("\n== %d/%d 通过,%d 失败 ==\n", g_total - g_fail, g_total, g_fail);
    return g_fail == 0 ? 0 : 1;
}
