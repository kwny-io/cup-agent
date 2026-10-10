/**
 * 宿主单测 —— 下行指令解析(command_parse.c)。零 IDF/零 esp-mqtt,mingw 直接跑。
 * 覆盖:target 过滤、未知 type、过期、cmd_id 去重、嵌套 payload 跳过、非数组/非法输入。
 */
#include "command_parse.h"

#include <stdio.h>
#include <string.h>

static int g_fail = 0, g_total = 0;
static void ok(int cond, const char *what) {
    g_total++;
    if (!cond) { g_fail++; printf("  ✗ %s\n", what); }
    else printf("  ✓ %s\n", what);
}

static void test_basic(void) {
    printf("[基本:挑出本机可执行指令]\n");
    const char *json =
        "[{\"v\":1,\"cmd_id\":\"c1\",\"target\":\"lid-A1B2C3\",\"ts\":100,"
        "\"expires_at\":9999999999999,\"type\":\"remind\",\"payload\":{\"text\":\"喝水\"}}]";
    cmd_t out[4];
    int n = cmd_parse_payload(json, "lid-A1B2C3", 1000, NULL, out, 4);
    ok(n == 1, "解析出 1 条");
    ok(strcmp(out[0].cmd_id, "c1") == 0, "cmd_id 正确");
    ok(out[0].type == CMD_TYPE_REMIND, "type=remind");
    ok(strcmp(cmd_type_str(out[0].type), "remind") == 0, "type 字符串");
}

static void test_filter_and_rules(void) {
    printf("[过滤:非本机/未知 type/过期/无 id]\n");
    const char *json =
        "["
        "{\"cmd_id\":\"c1\",\"target\":\"lid-XXXXXX\",\"expires_at\":9999999999999,\"type\":\"remind\",\"payload\":{}},"
        "{\"cmd_id\":\"c2\",\"target\":\"lid-A1B2C3\",\"expires_at\":9999999999999,\"type\":\"teleport\",\"payload\":{}},"
        "{\"cmd_id\":\"c3\",\"target\":\"lid-A1B2C3\",\"expires_at\":500,\"type\":\"config\",\"payload\":{}},"
        "{\"target\":\"lid-A1B2C3\",\"expires_at\":9999999999999,\"type\":\"ota\",\"payload\":{}},"
        "{\"cmd_id\":\"c5\",\"target\":\"lid-A1B2C3\",\"expires_at\":9999999999999,\"type\":\"ota\",\"payload\":{}}"
        "]";
    cmd_t out[8];
    int n = cmd_parse_payload(json, "lid-A1B2C3", 1000, NULL, out, 8);
    ok(n == 1, "5 条里只留 1 条");
    ok(strcmp(out[0].cmd_id, "c5") == 0 && out[0].type == CMD_TYPE_OTA, "留下的是本机且未过期的 ota");
}

static void test_no_expiry_means_forever(void) {
    printf("[expires_at 缺省/为 0 → 不过期]\n");
    const char *json =
        "[{\"cmd_id\":\"c1\",\"target\":\"lid-A1B2C3\",\"type\":\"sync_time\",\"payload\":{}}]";
    cmd_t out[4];
    int n = cmd_parse_payload(json, "lid-A1B2C3", 99999999999999ull, NULL, out, 4);
    ok(n == 1, "无 expires_at 也执行");
    ok(out[0].type == CMD_TYPE_SYNC_TIME, "type=sync_time");
}

static void test_dedup(void) {
    printf("[cmd_id 去重:同一 id 只执行一次]\n");
    cmd_dedup_t d; cmd_dedup_init(&d);
    const char *json =
        "[{\"cmd_id\":\"dup\",\"target\":\"lid-A1B2C3\",\"type\":\"remind\",\"payload\":{}}]";
    cmd_t out[4];
    ok(cmd_parse_payload(json, "lid-A1B2C3", 0, &d, out, 4) == 1, "首投执行");
    ok(cmd_parse_payload(json, "lid-A1B2C3", 0, &d, out, 4) == 0, "重投被去重(QoS1 场景)");
}

static void test_dedup_ring_wraps(void) {
    printf("[去重环:超容量后最旧的被覆盖]\n");
    cmd_dedup_t d; cmd_dedup_init(&d);
    ok(cmd_dedup_seen(&d, "a") == false, "a 首次 → false");
    ok(cmd_dedup_seen(&d, "a") == true, "a 再来 → true");
    for (int i = 0; i < CMD_DEDUP_SLOTS; i++) {
        char id[16]; snprintf(id, sizeof(id), "x%d", i);
        cmd_dedup_seen(&d, id);
    }
    // a 已被挤掉
    ok(cmd_dedup_seen(&d, "a") == false, "被挤出的 a → 视为新");
}

static void test_nested_payload_skipped(void) {
    printf("[嵌套 payload / 字符串含括号 正确跳过]\n");
    const char *json =
        "[{\"cmd_id\":\"c1\",\"target\":\"lid-A1B2C3\",\"type\":\"config\","
        "\"payload\":{\"nested\":{\"a\":[1,2,{\"b\":\"}\"}],\"s\":\"[not array]\"},\"k\":\"v\"},"
        "\"expires_at\":9999999999999}]";
    cmd_t out[4];
    int n = cmd_parse_payload(json, "lid-A1B2C3", 0, NULL, out, 4);
    ok(n == 1, "跳过嵌套 payload 后仍解析出 1 条");
    ok(out[0].type == CMD_TYPE_CONFIG, "type=config");
}

static void test_empty_and_bad(void) {
    printf("[空数组 / 非法输入]\n");
    cmd_t out[4];
    ok(cmd_parse_payload("[]", "lid-A1B2C3", 0, NULL, out, 4) == 0, "空数组 → 0 条");
    ok(cmd_parse_payload("   [  ]  ", "lid-A1B2C3", 0, NULL, out, 4) == 0, "空白空数组 → 0 条");
    ok(cmd_parse_payload("{\"a\":1}", "lid-A1B2C3", 0, NULL, out, 4) == -1, "非数组 → -1");
    // 数组中间的垃圾元素不应让后面的合法指令丢失
    const char *json =
        "[7,{\"cmd_id\":\"c1\",\"target\":\"lid-A1B2C3\",\"type\":\"ota\",\"payload\":{}}]";
    ok(cmd_parse_payload(json, "lid-A1B2C3", 0, NULL, out, 4) == 1, "跳过垃圾元素,保住后面的合法指令");
}

int main(void) {
    printf("== command_parse 宿主单测 ==\n");
    test_basic();
    test_filter_and_rules();
    test_no_expiry_means_forever();
    test_dedup();
    test_dedup_ring_wraps();
    test_nested_payload_skipped();
    test_empty_and_bad();
    printf("\n== %d/%d 通过,%d 失败 ==\n", g_total - g_fail, g_total, g_fail);
    return g_fail == 0 ? 0 : 1;
}
