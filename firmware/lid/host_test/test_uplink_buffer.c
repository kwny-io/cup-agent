/**
 * 宿主单测 —— 上行缓存(uplink_buffer.c)。零 IDF,mingw gcc 直接编译运行。
 * 覆盖:入队/计数、FIFO 顺序、满则丢最旧 + 计数、peek/pop、drain 成功排空、drain 中途失败保留。
 */
#include "uplink_buffer.h"

#include <stdio.h>
#include <string.h>

static int g_fail = 0, g_total = 0;
static void ok(int cond, const char *what) {
    g_total++;
    if (!cond) { g_fail++; printf("  ✗ %s\n", what); }
    else printf("  ✓ %s\n", what);
}

static void test_push_count(void) {
    printf("[入队 / 计数]\n");
    uplink_buffer_t b; uplink_buffer_init(&b);
    ok(uplink_buffer_count(&b) == 0, "初始为空");
    ok(uplink_buffer_push(&b, "a") == true, "入队成功返回 true(无丢弃)");
    ok(uplink_buffer_push(&b, "b") == true, "再入一条");
    ok(uplink_buffer_count(&b) == 2, "计数 = 2");
    ok(uplink_buffer_dropped(&b) == 0, "无丢弃");
}

static void test_fifo_order(void) {
    printf("[FIFO 顺序]\n");
    uplink_buffer_t b; uplink_buffer_init(&b);
    for (int i = 0; i < 5; i++) { char s[8]; snprintf(s, sizeof(s), "m%d", i); uplink_buffer_push(&b, s); }
    ok(strcmp(uplink_buffer_peek(&b), "m0") == 0, "peek 取最旧 m0");
    uplink_buffer_pop(&b);
    ok(strcmp(uplink_buffer_peek(&b), "m1") == 0, "pop 后最旧变 m1");
    ok(uplink_buffer_count(&b) == 4, "pop 后计数 4");
}

static void test_overflow_drops_oldest(void) {
    printf("[满则丢最旧 + 计数]\n");
    uplink_buffer_t b; uplink_buffer_init(&b);
    for (int i = 0; i < UPLINK_BUFFER_SLOTS; i++) { char s[8]; snprintf(s, sizeof(s), "m%d", i); uplink_buffer_push(&b, s); }
    ok(uplink_buffer_count(&b) == UPLINK_BUFFER_SLOTS, "满队列");
    ok(uplink_buffer_dropped(&b) == 0, "满但未丢");
    // 再入一条:丢 m0,最旧变 m1
    ok(uplink_buffer_push(&b, "new") == false, "溢出入队返回 false");
    ok(uplink_buffer_count(&b) == UPLINK_BUFFER_SLOTS, "计数仍为容量");
    ok(uplink_buffer_dropped(&b) == 1, "丢弃计数 = 1");
    ok(strcmp(uplink_buffer_peek(&b), "m1") == 0, "最旧变成 m1(丢了 m0)");
    // 末尾应是刚入的 new
    // 逐个 pop 到最后一个
    for (int i = 0; i < UPLINK_BUFFER_SLOTS - 1; i++) uplink_buffer_pop(&b);
    ok(strcmp(uplink_buffer_peek(&b), "new") == 0, "队尾是刚入的 new");
}

static void test_truncate_overlong(void) {
    printf("[超长截断]\n");
    uplink_buffer_t b; uplink_buffer_init(&b);
    char big[UPLINK_MAX_PAYLOAD + 100];
    memset(big, 'x', sizeof(big) - 1);
    big[sizeof(big) - 1] = '\0';
    uplink_buffer_push(&b, big);
    const char *p = uplink_buffer_peek(&b);
    ok(p != NULL && strlen(p) == UPLINK_MAX_PAYLOAD - 1, "超长被截到上限-1");
}

static bool always_ok(const char *payload, void *ctx) {
    (void)payload;
    int *n = (int *)ctx;
    (*n)++;
    return true;
}

static void test_drain_all(void) {
    printf("[drain:全部补发]\n");
    uplink_buffer_t b; uplink_buffer_init(&b);
    for (int i = 0; i < 4; i++) { char s[8]; snprintf(s, sizeof(s), "m%d", i); uplink_buffer_push(&b, s); }
    int sent = 0;
    int got = uplink_buffer_drain(&b, always_ok, &sent);
    ok(got == 4 && sent == 4, "4 条全部补发");
    ok(uplink_buffer_count(&b) == 0, "排空后为空");
    ok(uplink_buffer_peek(&b) == NULL, "空队列 peek 返回 NULL");
}

/** 补发到第 3 条时又断了:前 2 条出队,剩下的保留。 */
static bool fail_after_two(const char *payload, void *ctx) {
    (void)payload;
    int *n = (int *)ctx;
    (*n)++;
    return *n <= 2;  // 头两次成功,之后失败
}

static void test_drain_partial_keeps_rest(void) {
    printf("[drain:中途失败保留剩余]\n");
    uplink_buffer_t b; uplink_buffer_init(&b);
    for (int i = 0; i < 5; i++) { char s[8]; snprintf(s, sizeof(s), "m%d", i); uplink_buffer_push(&b, s); }
    int n = 0;
    int got = uplink_buffer_drain(&b, fail_after_two, &n);
    ok(got == 2, "只成功补发 2 条");
    ok(uplink_buffer_count(&b) == 3, "剩余 3 条保留");
    ok(strcmp(uplink_buffer_peek(&b), "m2") == 0, "最旧是 m2(前两条已出队)");
}

static void test_drain_empty(void) {
    printf("[drain 空队列]\n");
    uplink_buffer_t b; uplink_buffer_init(&b);
    int n = 0;
    ok(uplink_buffer_drain(&b, always_ok, &n) == 0, "空队列 drain 返回 0");
}

static void test_null_safety(void) {
    printf("[空指针安全]\n");
    ok(uplink_buffer_push(NULL, "x") == false, "push NULL 返回 false");
    uplink_buffer_t b; uplink_buffer_init(&b);
    ok(uplink_buffer_push(&b, NULL) == false, "push NULL payload 返回 false");
    ok(uplink_buffer_peek(NULL) == NULL, "peek NULL 返回 NULL");
    ok(uplink_buffer_count(NULL) == 0, "count NULL 返回 0");
}

int main(void) {
    printf("== uplink_buffer 宿主单测 ==\n");
    test_push_count();
    test_fifo_order();
    test_overflow_drops_oldest();
    test_truncate_overlong();
    test_drain_all();
    test_drain_partial_keeps_rest();
    test_drain_empty();
    test_null_safety();
    printf("\n== %d/%d 通过,%d 失败 ==\n", g_total - g_fail, g_total, g_fail);
    return g_fail == 0 ? 0 : 1;
}
