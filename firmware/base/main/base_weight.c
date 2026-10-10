/**
 * 底座称重判定实现 —— 阈值/窗口/延迟取自 contract_dev.h(=镜像 constants.ts 的 SCALE)。
 * 状态机语义逐条对齐 simulator/sensors/base.ts 的 BaseSensor(便于对照)。
 */
#include "base_weight.h"

#include <math.h>
#include <string.h>

float base_window_std(const float *xs, int count) {
    if (!xs || count < 2) return 0.0f;
    float sum = 0.0f;
    for (int i = 0; i < count; i++) sum += xs[i];
    float mean = sum / (float)count;
    float acc = 0.0f;
    for (int i = 0; i < count; i++) {
        float d = xs[i] - mean;
        acc += d * d;
    }
    return sqrtf(acc / (float)count);
}

void base_weight_init(base_weight_t *st) {
    if (!st) return;
    memset(st, 0, sizeof(*st));
    st->state = BASE_OFF;
}

/** 把一帧重量推入稳定窗口,返回窗口当前标准差(不足 2 个样本时 0)。 */
static float push_window(base_weight_t *st, float w) {
    st->win[st->win_head] = w;
    st->win_head = (st->win_head + 1) % BASE_STD_WINDOW;
    if (st->win_count < BASE_STD_WINDOW) st->win_count++;
    return base_window_std(st->win, st->win_count);
}

base_weight_out_t base_weight_step(base_weight_t *st, float raw_weight_g, int battery_pct,
                                   uint32_t now_ms) {
    base_weight_out_t out = {0};
    out.state = BASE_OFF;
    if (!st) return out;

    float w = raw_weight_g < 0.0f ? 0.0f : raw_weight_g;
    out.weight_g = w;
    bool present = w >= SCALE_PRESENT_MIN_G;
    out.present = present;

    switch (st->state) {
        case BASE_OFF: {
            if (present) {
                st->state = BASE_SETTLING;
                st->settling_since_ms = now_ms;
                st->has_settling_since = true;
                st->win_count = 0;
                st->win_head = 0;
                push_window(st, w);
            }
            break;
        }

        case BASE_SETTLING: {
            if (!present) {
                // 刚放上又拿走
                st->state = BASE_OFF;
                st->has_settling_since = false;
                break;
            }
            float std = push_window(st, w);
            if (!st->has_settling_since) {
                st->settling_since_ms = now_ms;
                st->has_settling_since = true;
            }
            // 稳定条件:窗口填满 + 标准差达标 + 已过窗口时间
            bool long_enough =
                (now_ms - st->settling_since_ms) >= SCALE_SETTLE_WINDOW_MS;
            bool quiet = st->win_count >= BASE_STD_WINDOW && std < SCALE_SETTLE_STD_G;
            if (long_enough && quiet) {
                float prev = st->resting_weight_g;
                float delta = w - prev;
                st->state = BASE_RESTING;
                st->has_settling_since = false;
                st->resting_weight_g = w;

                if (prev > 0.0f && fabsf(delta) >= SCALE_DRINK_MIN_G) {
                    float ml = fabsf(delta);  // g_per_ml = 1.0
                    if (delta < 0.0f) {
                        out.emit_drink = true;
                        out.drink_ml = ml;
                    } else {
                        out.emit_refill = true;
                        out.refill_ml = ml;
                    }
                }
            }
            break;
        }

        case BASE_RESTING: {
            if (!present) {
                // 杯子被拿走 —— 进入 off_base 延迟计时
                st->state = BASE_OFF;
                st->has_settling_since = false;
                st->has_off_since = true;
                st->off_since_ms = now_ms;
                st->off_base_emitted = false;
            } else {
                // 在座上微动:更新窗口;若明显偏离基准再进入 SETTLING 重新判定
                float std = push_window(st, w);
                if (std >= SCALE_SETTLE_STD_G) {
                    st->state = BASE_SETTLING;
                    st->settling_since_ms = now_ms;
                    st->has_settling_since = true;
                }
            }
            break;
        }
    }

    // off_base:离开已超 off_base_delay_ms 仍未回来 → 发一次
    if (st->has_off_since && !present && !st->off_base_emitted &&
        (now_ms - st->off_since_ms) >= SCALE_OFF_BASE_DELAY_MS) {
        out.emit_off_base = true;
        st->off_base_emitted = true;
    }
    // 回来了 → 清掉 off 计时
    if (present) {
        st->has_off_since = false;
        st->off_base_emitted = false;
    }

    // 低电量(滞回:<=15 报,>=(15+5) 复位 —— 与模拟器 base.ts 一致)
    if (!st->low_batt_alerted) {
        if (battery_pct <= ALERT_BATTERY_LOW_PCT) {
            out.emit_low_battery = true;
            st->low_batt_alerted = true;
        }
    } else if (battery_pct >= ALERT_BATTERY_LOW_PCT + 5) {
        st->low_batt_alerted = false;
    }

    out.state = st->state;
    out.stable = (st->state == BASE_RESTING);
    return out;
}
