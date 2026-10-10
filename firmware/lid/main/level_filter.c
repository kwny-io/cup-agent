/**
 * ToF 液位 α-β 滤波实现 —— 参数取自 level_filter.h(设备内部,不进契约)。
 * α-β 是恒定增益卡尔曼近似:x 用 α 修正、v 用 β 修正;晃动档增益更小(重平滑)。
 */
#include "level_filter.h"

#include "contract_dev.h"

#include <math.h>

void level_filter_init(level_filter_t *st) {
    if (!st) return;
    st->x = 0.0f;
    st->v = 0.0f;
    st->init = false;
    st->last_ms = 0;
    st->gated_frames = 0;
    st->gated = false;
    st->last_resid = 0.0f;
}

static float clamp_level(float mm) {
    if (mm < 0.0f) return 0.0f;
    if (mm > (float)CUP_INNER_MM) return (float)CUP_INNER_MM;
    return mm;
}

level_filter_out_t level_filter_step(level_filter_t *st, float raw_mm, bool noisy,
                                     uint32_t now_ms) {
    level_filter_out_t out = {0};
    if (!st) return out;

    raw_mm = clamp_level(raw_mm);

    // 首帧:没有历史,直接采信建立初值(速度取 0)。
    if (!st->init) {
        st->x = raw_mm;
        st->v = 0.0f;
        st->init = true;
        st->last_ms = now_ms;
        st->gated_frames = 0;
        out.level_mm = st->x;
        out.gated = false;
        return out;
    }

    float dt = (float)(now_ms - st->last_ms) / 1000.0f;
    if (dt < 1e-3f) dt = 1e-3f;
    if (dt > 0.5f) dt = 0.5f;
    st->last_ms = now_ms;

    // 预测步:x 按当前速度外推。
    float x_pred = st->x + st->v * dt;
    float resid = raw_mm - x_pred;
    st->last_resid = resid;

    // 晃动档:测量被水面波动污染 → 增益更小、门更宽。
    float alpha = noisy ? LEVEL_FILTER_ALPHA_SHAKE : LEVEL_FILTER_ALPHA_QUIET;
    float beta = noisy ? LEVEL_FILTER_BETA_SHAKE : LEVEL_FILTER_BETA_QUIET;
    float gate = noisy ? LEVEL_GATE_SHAKE_MM : LEVEL_GATE_QUIET_MM;

    bool rejected = false;
    if (fabsf(resid) > gate) {
        st->gated_frames++;
        if (st->gated_frames < LEVEL_GATE_CONFIRM_FRAMES) {
            // 单帧/短时尖峰:只信预测,不采信测量(输出预测值)。
            rejected = true;
        } else {
            // 连续越门 → 认定为真实变化(倒水/喝水持续多帧),全量吸附并清计数。
            alpha = 1.0f;
            st->gated_frames = 0;
        }
    } else {
        st->gated_frames = 0;
    }

    if (rejected) {
        st->x = clamp_level(x_pred);
        st->gated = true;
    } else {
        // 修正步:x 由 α 拉向测量,速度由 β 跟随。
        st->x = clamp_level(x_pred + alpha * resid);
        st->v = st->v + (beta / dt) * resid;
        st->gated = false;
    }

    out.level_mm = st->x;
    out.gated = st->gated;
    return out;
}
