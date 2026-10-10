/**
 * 上行缓存(纯 C,零 IDF 依赖)—— 断网/未连 broker 时的报告暂存。
 *
 * 为什么需要:契约 §5 说上行是拉取式、设备定期上报;但如果此刻 **broker 没连上**
 * (刚开机、Wi-Fi 抖动、断网),report 直接丢会留下数据空洞 —— 一天的喝水曲线缺一段。
 * bring-up 期的做法是"发失败就下帧重试",但重试的只是**最新**那帧,中间那些帧照样丢。
 *
 * 本模块是有界 FIFO:发失败时把信封入队,连上后按**入队顺序**逐条补发(QoS1 保证到达),
 * 队列满则**丢最旧**并计数(丢的是最老的数据;计数供日志/遥测暴露,不静默)。
 *
 * 为什么抽成零依赖纯 C:可测(见 host_test/test_uplink_buffer.c)。且**不依赖** mqtt_uplink ——
 * 主循环持有它,发失败入队、连上后排空,真正的 publish 回调由调用方注入。
 *
 * 容量是**编译期常量**(静态分配,不用 malloc —— 固件里避免堆碎片)。
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** 队列容量(条)。每条信封最长 UPLINK_MAX_PAYLOAD 字节。 */
#define UPLINK_BUFFER_SLOTS 16
/** 单条信封缓冲上限(字节,含结尾 NUL)。一帧遥测远小于此。 */
#define UPLINK_MAX_PAYLOAD 512

/** 缓存状态(调用方持有;uplink_buffer_init 清零)。 */
typedef struct {
    char slot[UPLINK_BUFFER_SLOTS][UPLINK_MAX_PAYLOAD];
    int head;             // 出队位置
    int count;            // 当前条数
    uint32_t dropped;     // 累计因溢出丢掉的条数
    uint32_t queued;      // 累计入队条数(含已补发)
} uplink_buffer_t;

void uplink_buffer_init(uplink_buffer_t *b);

/** 当前暂存条数。 */
int uplink_buffer_count(const uplink_buffer_t *b);

/** 累计丢弃条数(溢出);调用方可据此打日志。 */
uint32_t uplink_buffer_dropped(const uplink_buffer_t *b);

/**
 * 入队一条信封。队列满时**丢最旧**一条再入(返回 false 表示发生过丢弃)。
 * payload 过长(≥ UPLINK_MAX_PAYLOAD)会被截断。空指针返回 false。
 */
bool uplink_buffer_push(uplink_buffer_t *b, const char *payload);

/**
 * 取最旧一条的指针(**不出队**;调用方补发成功后须调 uplink_buffer_pop 确认)。
 * 队列空返回 NULL。指针在下次 push/pop 前有效。
 */
const char *uplink_buffer_peek(const uplink_buffer_t *b);

/** 出队最旧一条(补发成功后调)。空队列无操作。 */
void uplink_buffer_pop(uplink_buffer_t *b);

/**
 * 排空:反复 peek → 用 `send` 回调补发;回调返回 true 才 pop,返回 false 即停
 * (broker 又断了,剩下的留到下次)。
 * @return 本次成功补发的条数。
 */
typedef bool (*uplink_send_fn)(const char *payload, void *ctx);
int uplink_buffer_drain(uplink_buffer_t *b, uplink_send_fn send, void *ctx);

#ifdef __cplusplus
}
#endif
