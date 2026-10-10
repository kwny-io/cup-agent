/**
 * 实时档决策实现 —— 触发:显式请求或晃动;退出靠保持窗(REALTIME_HOLD_MS)。
 */
#include "realtime.h"

void realtime_init(realtime_t *st) {
    if (!st) return;
    st->realtime = false;
    st->hold_until_ms = 0;
}

realtime_out_t realtime_step(realtime_t *st, bool rt_request, bool motion_shake,
                             uint32_t now_ms) {
    realtime_out_t out = {0};
    if (!st) return out;

    bool triggered = rt_request || motion_shake;
    if (triggered) {
        st->realtime = true;
        st->hold_until_ms = now_ms + REALTIME_HOLD_MS;  // 每帧续期,停手后 hold 自动落
    } else if (st->realtime && now_ms >= st->hold_until_ms) {
        st->realtime = false;
    }

    out.realtime = st->realtime;
    out.sample_ms = st->realtime ? REALTIME_SAMPLE_MS : REALTIME_NORMAL_SAMPLE_MS;
    return out;
}
