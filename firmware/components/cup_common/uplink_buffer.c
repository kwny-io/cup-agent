/**
 * 上行缓存实现 —— 有界环形 FIFO,静态分配,丢最旧策略。
 */
#include "uplink_buffer.h"

#include <string.h>

/** 第 i 个逻辑槽(0 = 最旧)的环形下标。 */
static int slot_index(const uplink_buffer_t *b, int i) {
    return (b->head + i) % UPLINK_BUFFER_SLOTS;
}

void uplink_buffer_init(uplink_buffer_t *b) {
    if (!b) return;
    b->head = 0;
    b->count = 0;
    b->dropped = 0;
    b->queued = 0;
}

int uplink_buffer_count(const uplink_buffer_t *b) { return b ? b->count : 0; }

uint32_t uplink_buffer_dropped(const uplink_buffer_t *b) { return b ? b->dropped : 0; }

bool uplink_buffer_push(uplink_buffer_t *b, const char *payload) {
    if (!b || !payload) return false;

    bool lost = false;
    if (b->count == UPLINK_BUFFER_SLOTS) {
        // 满:丢最旧(头进一格,相当于丢掉原 head)
        b->head = (b->head + 1) % UPLINK_BUFFER_SLOTS;
        b->count--;
        b->dropped++;
        lost = true;
    }

    int idx = slot_index(b, b->count);  // 新元素放在当前末尾
    strncpy(b->slot[idx], payload, UPLINK_MAX_PAYLOAD - 1);
    b->slot[idx][UPLINK_MAX_PAYLOAD - 1] = '\0';
    b->count++;
    b->queued++;
    return !lost;
}

const char *uplink_buffer_peek(const uplink_buffer_t *b) {
    if (!b || b->count == 0) return NULL;
    return b->slot[slot_index(b, 0)];
}

void uplink_buffer_pop(uplink_buffer_t *b) {
    if (!b || b->count == 0) return;
    b->head = (b->head + 1) % UPLINK_BUFFER_SLOTS;
    b->count--;
}

int uplink_buffer_drain(uplink_buffer_t *b, uplink_send_fn send, void *ctx) {
    if (!b || !send) return 0;
    int sent = 0;
    for (;;) {
        const char *p = uplink_buffer_peek(b);
        if (!p) break;
        if (!send(p, ctx)) break;  // 发送失败(又断了)→ 保留,下次再试
        uplink_buffer_pop(b);
        sent++;
    }
    return sent;
}
