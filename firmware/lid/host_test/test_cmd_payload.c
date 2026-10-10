/**
 * 宿主单测 —— 下行指令 payload 取值(cmd_payload.c)。零 IDF,mingw 直接跑。
 * 覆盖:命中、错 cmd_id、无该 key、值非整数、负数、大数(Unix ms)、多指令数组。
 */
#include "cmd_payload.h"

#include <stdio.h>
#include <string.h>

static int g_fail = 0, g_total = 0;
static void ok(int cond, const char *what) {
    g_total++;
    if (!cond) { g_fail++; printf("  ✗ %s\n", what); }
    else printf("  ✓ %s\n", what);
}

static void test_basic_hit(void) {
    printf("[基本:按 cmd_id 取 payload 整数字段]\n");
    const char *json =
        "[{\"v\":1,\"cmd_id\":\"c1\",\"target\":\"lid-A1B2C3\",\"ts\":100,"
        "\"expires_at\":9999999999999,\"type\":\"sync_time\",\"payload\":{\"server_ts\":1759756800000}}]";
    int64_t v = 0;
    ok(cmd_payload_i64(json, "c1", "server_ts", &v), "命中 server_ts");
    ok(v == 1759756800000LL, "取到 13 位 Unix 毫秒(未截断)");
}

static void test_config_report_ms(void) {
    printf("[config.report_ms]\n");
    const char *json =
        "[{\"cmd_id\":\"cfg-1\",\"target\":\"lid-A1B2C3\",\"type\":\"config\","
        "\"payload\":{\"report_ms\":60000}}]";
    int64_t v = 0;
    ok(cmd_payload_i64(json, "cfg-1", "report_ms", &v) && v == 60000, "取到 report_ms=60000");
}

static void test_wrong_cmd_id(void) {
    printf("[错 cmd_id → 不命中]\n");
    const char *json =
        "[{\"cmd_id\":\"c1\",\"target\":\"lid-A1B2C3\",\"type\":\"config\","
        "\"payload\":{\"report_ms\":60000}}]";
    int64_t v = 0;
    ok(!cmd_payload_i64(json, "c2", "report_ms", &v), "cmd_id 不匹配 → false");
}

static void test_missing_key(void) {
    printf("[payload 里没有该 key → false]\n");
    const char *json =
        "[{\"cmd_id\":\"c1\",\"type\":\"config\",\"payload\":{\"led\":\"off\"}}]";
    int64_t v = 123;
    ok(!cmd_payload_i64(json, "c1", "report_ms", &v), "无 report_ms → false");
    ok(v == 123, "输出未被写(调用方保持原值)");
}

static void test_value_not_integer(void) {
    printf("[值非整数 → false]\n");
    const char *json =
        "[{\"cmd_id\":\"c1\",\"type\":\"config\",\"payload\":{\"report_ms\":\"soon\"}}]";
    int64_t v = 0;
    ok(!cmd_payload_i64(json, "c1", "report_ms", &v), "字符串值 → false");
}

static void test_negative(void) {
    printf("[负值也能取(交 cmd_exec 裁定)]\n");
    const char *json =
        "[{\"cmd_id\":\"c1\",\"type\":\"config\",\"payload\":{\"report_ms\":-5}}]";
    int64_t v = 0;
    ok(cmd_payload_i64(json, "c1", "report_ms", &v) && v == -5, "取到 -5");
}

static void test_multiple_commands(void) {
    printf("[多指令数组:只取 cmd_id 匹配那条]\n");
    const char *json =
        "[{\"cmd_id\":\"a\",\"type\":\"config\",\"payload\":{\"report_ms\":10000}},"
        "{\"cmd_id\":\"b\",\"type\":\"config\",\"payload\":{\"report_ms\":20000}}]";
    int64_t v = 0;
    ok(cmd_payload_i64(json, "b", "report_ms", &v) && v == 20000, "取到 b 的 20000");
    ok(cmd_payload_i64(json, "a", "report_ms", &v) && v == 10000, "取到 a 的 10000");
}

static void test_nested_payload(void) {
    printf("[payload 含嵌套对象/字符串括号 → 仍能取到相邻 key]\n");
    const char *json =
        "[{\"cmd_id\":\"c1\",\"type\":\"config\",\"payload\":"
        "{\"nested\":{\"a\":[1,2,{\"b\":\"}\"}]},\"s\":\"[not array]\",\"report_ms\":45000}}]";
    int64_t v = 0;
    ok(cmd_payload_i64(json, "c1", "report_ms", &v) && v == 45000, "跳过嵌套后取到 report_ms");
}

static void test_bad_input(void) {
    printf("[非数组/NULL/空 id → false]\n");
    int64_t v = 0;
    ok(!cmd_payload_i64("{\"a\":1}", "c1", "k", &v), "非数组 → false");
    ok(!cmd_payload_i64("[{\"cmd_id\":\"c1\"}]", "", "k", &v), "空 cmd_id → false");
    ok(!cmd_payload_i64(NULL, "c1", "k", &v), "NULL json → false");
    ok(!cmd_payload_i64("[]", "c1", "k", &v), "空数组 → false");
}

static void test_str_hit(void) {
    printf("[字符串值:remind.text]\n");
    const char *json =
        "[{\"cmd_id\":\"chat-1\",\"type\":\"remind\",\"payload\":{\"text\":\"该喝水啦\",\"led\":\"breath_blue\"}}]";
    char t[64] = {0};
    ok(cmd_payload_str(json, "chat-1", "text", t, sizeof(t)), "命中 text");
    ok(strcmp(t, "该喝水啦") == 0, "取到中文文本");
    // 契约 §5:remind.led 是效果名字符串(不是整数)—— 与 cmd_payload_str 一致。
    char led[24] = {0};
    ok(cmd_payload_str(json, "chat-1", "led", led, sizeof(led)) && strcmp(led, "breath_blue") == 0,
       "同一 payload 里还能取 led(字符串)");
}

static void test_str_escape(void) {
    printf("[字符串转义:\\\\n \\\\t \\\\\" 解开]\n");
    const char *json =
        "[{\"cmd_id\":\"c1\",\"type\":\"remind\",\"payload\":{\"text\":\"a\\nb\\tc\\\"d\"}}]";
    char t[64] = {0};
    ok(cmd_payload_str(json, "c1", "text", t, sizeof(t)), "命中");
    ok(strcmp(t, "a\nb\tc\"d") == 0, "转义已解开");
}

static void test_str_miss(void) {
    printf("[未命中/值非字符串 → false]\n");
    const char *json =
        "[{\"cmd_id\":\"c1\",\"type\":\"config\",\"payload\":{\"report_ms\":60000}}]";
    char t[16] = "keep";
    ok(!cmd_payload_str(json, "c1", "text", t, sizeof(t)), "无该 key → false");
    ok(!cmd_payload_str(json, "c1", "report_ms", t, sizeof(t)), "值非字符串 → false");
    ok(!cmd_payload_str(json, "c9", "report_ms", t, sizeof(t)), "错 cmd_id → false");
}

static void test_str_truncate(void) {
    printf("[超长字符串:截断但以 NUL 结尾]\n");
    const char *json =
        "[{\"cmd_id\":\"c1\",\"payload\":{\"text\":\"0123456789ABCDEF\"}}]";
    char t[8] = {0};
    ok(cmd_payload_str(json, "c1", "text", t, sizeof(t)), "命中");
    ok(strcmp(t, "0123456") == 0, "截到 cap-1 且 NUL 结尾");
}

int main(void) {
    printf("== cmd_payload 宿主单测 ==\n");
    test_basic_hit();
    test_config_report_ms();
    test_wrong_cmd_id();
    test_missing_key();
    test_value_not_integer();
    test_negative();
    test_multiple_commands();
    test_nested_payload();
    test_bad_input();
    test_str_hit();
    test_str_escape();
    test_str_miss();
    test_str_truncate();
    printf("\n== %d/%d 通过,%d 失败 ==\n", g_total - g_fail, g_total, g_fail);
    return g_fail == 0 ? 0 : 1;
}
