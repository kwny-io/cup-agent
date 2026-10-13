/**
 * 成长庆祝 · 宿主单测(纯 C)。
 * 钉住:reason 判定入口、kind→表情映射、未知回落、时长/灯效边界。
 */
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "celebr.h"

static int g_fail = 0;
#define CHECK(cond, msg)                                                  \
    do {                                                                  \
        if (!(cond)) {                                                    \
            printf("  ✗ %s\n", (msg));                                    \
            g_fail++;                                                     \
        } else {                                                          \
            printf("  ✓ %s\n", (msg));                                    \
        }                                                                 \
    } while (0)

static const char *MILESTONE_7 =
    "[{\"v\":1,\"cmd_id\":\"c1\",\"target\":\"lid-A1B2C3\",\"ts\":1,\"expires_at\":2,"
    "\"type\":\"remind\",\"payload\":{\"reason\":\"milestone\",\"id\":\"together_7\","
    "\"label\":\"一起一周\",\"kind\":\"together\",\"threshold\":7}}]";

static const char *PLAIN_REMIND =
    "[{\"v\":1,\"cmd_id\":\"c9\",\"target\":\"lid-A1B2C3\",\"ts\":1,\"expires_at\":2,"
    "\"type\":\"remind\",\"payload\":{\"text\":\"该喝水了\",\"led\":\"breath_blue\"}}]";

static const char *MILESTONE_NO_KIND =
    "[{\"v\":1,\"cmd_id\":\"c2\",\"target\":\"lid-A1B2C3\",\"ts\":1,\"expires_at\":2,"
    "\"type\":\"remind\",\"payload\":{\"reason\":\"milestone\",\"id\":\"x\",\"label\":\"y\"}}]";

static const char *MILESTONE_STREAK =
    "[{\"v\":1,\"cmd_id\":\"c3\",\"target\":\"lid-A1B2C3\",\"ts\":1,\"expires_at\":2,"
    "\"type\":\"remind\",\"payload\":{\"reason\":\"milestone\",\"id\":\"streak_14\","
    "\"label\":\"连续达标两周\",\"kind\":\"streak\",\"threshold\":14}}]";

int main(void) {
    printf("── celebr ──\n");

    // 判定入口:只认 reason == "milestone"
    CHECK(celebr_is_milestone(MILESTONE_7, "c1"), "reason=milestone → 判为庆祝");
    CHECK(!celebr_is_milestone(PLAIN_REMIND, "c9"), "普通 remind → 非庆祝");
    CHECK(!celebr_is_milestone(MILESTONE_7, "nope"), "cmd_id 不匹配 → 找不到,非庆祝");
    CHECK(!celebr_is_milestone(NULL, "c1"), "NULL json 不崩,返回 false");

    // 计划:kind=together → 满足弧眼 + 提取 id/label
    celebr_plan_t p;
    CHECK(celebr_plan(MILESTONE_7, "c1", &p), "together 里程碑 → 有计划");
    CHECK(p.eye == EYE_CONTENT, "together → 满足弧眼(CONTENT)");
    CHECK(p.eye_seconds == CELEBR_EYE_S_TOGETHER, "together 时长 = 4.0s");
    CHECK(p.led.effect == LED_BLINK, "庆祝灯 = 闪烁");
    CHECK(p.led.color == LED_COLOR_YELLOW, "庆祝灯色 = 黄");
    CHECK(p.led.count == CELEBR_LED_BLINK_COUNT, "庆祝闪 3 次");
    CHECK(strcmp(p.id, "together_7") == 0, "提取到 id");
    CHECK(strcmp(p.label, "一起一周") == 0, "提取到 label(UTF-8 原样)");

    // kind 缺失 → 默认庆祝脸(绝不因此不庆祝)
    CHECK(celebr_plan(MILESTONE_NO_KIND, "c2", &p), "无 kind 的里程碑仍给计划");
    CHECK(p.eye == EYE_CONTENT && p.eye_seconds == CELEBR_EYE_S_DEFAULT,
          "无 kind → 默认庆祝(3.5s)");

    // kind=streak → 得意
    CHECK(celebr_plan(MILESTONE_STREAK, "c3", &p), "streak 里程碑 → 有计划");
    CHECK(p.eye == EYE_SMUG, "streak → 得意(SMUG)");

    // 非庆祝 → 不产生计划(调用方走原 remind 路径)
    CHECK(!celebr_plan(PLAIN_REMIND, "c9", &p), "普通 remind → celebr_plan 返回 false");

    if (g_fail == 0) {
        printf("── celebr 全部通过 ──\n");
        return 0;
    }
    printf("── celebr 有 %d 处失败 ──\n", g_fail);
    return 1;
}
