/**
 * 称重温漂补偿实现 —— 自标定两点法。模型与门槛见 weight_comp.h 顶部注释。
 */
#include "weight_comp.h"

#include "base_weight.h"     // base_window_std()(复用滑动窗口标准差)
#include "contract_dev.h"    // SCALE_PRESENT_MIN_G / SCALE_SETTLE_STD_G

#include <math.h>
#include <string.h>

void weight_comp_init(weight_comp_t *st) {
    if (!st) return;
    memset(st, 0, sizeof(*st));
}

/** 把一帧原始读数推入空座静默窗口。 */
static void push_window(weight_comp_t *st, float raw_g) {
    st->win[st->win_head] = raw_g;
    st->win_head = (st->win_head + 1) % COMP_STD_WINDOW;
    if (st->win_count < COMP_STD_WINDOW) st->win_count++;
}

static float window_mean(const weight_comp_t *st) {
    float sum = 0.0f;
    for (int i = 0; i < st->win_count; i++) sum += st->win[i];
    return st->win_count > 0 ? sum / (float)st->win_count : 0.0f;
}

/**
 * 更新两个温度分离的空座锚点(lo = 低温端,hi = 高温端)。
 * 只在**新极值**时刷新,故锚点间温差单调不减 —— 避免"在区间内刷新"把分离度压回阈值以下。
 */
static bool update_anchors(weight_comp_t *st, float temp_c, float r_mean) {
    bool got = false;
    if (!st->has_lo) {
        st->t_lo = temp_c;
        st->r_lo = r_mean;
        st->has_lo = true;
        got = true;
    } else if (temp_c < st->t_lo) {
        st->t_lo = temp_c;
        st->r_lo = r_mean;
        got = true;
    } else if (!st->has_hi) {
        if (temp_c - st->t_lo >= COMP_MIN_DT_C) {
            st->t_hi = temp_c;
            st->r_hi = r_mean;
            st->has_hi = true;
            got = true;
        }
    } else if (temp_c > st->t_hi) {
        st->t_hi = temp_c;
        st->r_hi = r_mean;
        got = true;
    }
    return got;
}

/** 两点反解零点直线 z(T)=a+k·T;分离度/系数越界则不标定。 */
static void try_calibrate(weight_comp_t *st) {
    if (!st->has_lo || !st->has_hi) return;
    float dt = st->t_hi - st->t_lo;
    if (dt < COMP_MIN_DT_C) return;               // 温差不够,不反解(防噪声放大)
    float k = (st->r_hi - st->r_lo) / dt;
    if (fabsf(k) > COMP_K_MAX) return;            // 越界 = 污染/坏数据,丢弃
    st->k = k;
    st->a = st->r_lo - k * st->t_lo;              // 直线过 lo 锚点
    st->calibrated = true;
}

weight_comp_out_t weight_comp_step(weight_comp_t *st, float raw_g, float temp_c,
                                   uint32_t now_ms) {
    (void)now_ms;  // 目前只用于接口一致性;将来做锚点老化时启用
    weight_comp_out_t out = {0};
    out.corrected_g = raw_g < 0.0f ? 0.0f : raw_g;  // 未标定 → 恒等
    if (!st) return out;

    push_window(st, raw_g);

    // 锚点门:必须同时满足"空座 + 静止 + 窗口满"才认一个空座样本
    float std = base_window_std(st->win, st->win_count);
    bool full = st->win_count >= COMP_STD_WINDOW;
    bool air = raw_g < SCALE_PRESENT_MIN_G;
    bool quiet = std < SCALE_SETTLE_STD_G;
    if (full && air && quiet) {
        out.got_anchor = update_anchors(st, temp_c, window_mean(st));
    }
    try_calibrate(st);

    // 已标定 → 扣除零点直线
    if (st->calibrated) {
        float zero = st->a + st->k * temp_c;
        float corrected = raw_g - zero;
        if (corrected < 0.0f) corrected = 0.0f;
        if (corrected > 2000.0f) corrected = 2000.0f;  // 契约上界,防越界被后端拒收
        out.corrected_g = corrected;
    }
    out.calibrated = st->calibrated;
    out.k = st->calibrated ? st->k : 0.0f;
    return out;
}
