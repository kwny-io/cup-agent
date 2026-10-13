/**
 * 端侧判定实现 —— 阈值取自 contract_dev.h(=镜像 constants.ts)。
 * 语义逐条对齐契约 §6.3/§6.4 与模拟器 sensors/lid.ts 的判定(便于对照)。
 */
#include "lid_logic.h"

#include <math.h>

float lid_shake_energy(float ax, float ay, float az) {
    float mag = sqrtf(ax * ax + ay * ay + az * az);
    // 静止时模长应≈1g;超出 1g 的部分才是"晃动能量"。
    return fabsf(mag - 1.0f);
}

void lid_logic_init(lid_logic_t *st) {
    if (!st) return;
    st->shake_frames = 0;
    st->shake_until_ms = 0;
    st->shaking_latched = false;
    st->tilting = false;
    st->tilt_since_ms = 0;
    st->tilt_alerted = false;
    st->temp_alerted = false;
    st->low_batt_alerted = false;
    st->lifting = false;
    st->lift_since_ms = 0;
    st->press_contact = false;
    st->press_since_ms = 0;
}

lid_logic_out_t lid_logic_step(lid_logic_t *st, const lid_logic_in_t *in, uint32_t now_ms) {
    lid_logic_out_t out = {0};
    out.motion = MOTION_IDLE;
    if (!st || !in) return out;

    // ── shake:能量超阈值连续 N 帧 → 锁存 400ms ──
    float energy = lid_shake_energy(in->ax, in->ay, in->az);
    if (energy > IMU_SHAKE_ENERGY_G) {
        if (st->shake_frames < IMU_SHAKE_FRAMES) st->shake_frames++;
    } else {
        st->shake_frames = 0;
    }
    if (st->shake_frames >= IMU_SHAKE_FRAMES) {
        if (!st->shaking_latched) {
            st->shaking_latched = true;
            out.emit_shake = true;  // 上升沿:只在首次判到时发一次 shake 事件
        }
        st->shake_until_ms = now_ms + IMU_SHAKE_HOLD_MS;  // 每帧续期,停手后 400ms 自动落
    }
    bool in_shake_hold = st->shaking_latched && (now_ms < st->shake_until_ms);
    if (!in_shake_hold) st->shaking_latched = false;

    // ── tilt:倾角超阈值且持续够久 → tilt_alert ──
    if (in->tilt_deg >= IMU_TILT_DEG) {
        if (!st->tilting) {
            st->tilting = true;
            st->tilt_since_ms = now_ms;
            st->tilt_alerted = false;
        }
        if (!st->tilt_alerted && (now_ms - st->tilt_since_ms) >= ALERT_TILT_ALERT_MS) {
            out.emit_tilt_alert = true;
            st->tilt_alerted = true;
        }
    } else {
        st->tilting = false;
        st->tilt_alerted = false;
    }

    // ── 温度报警(带滞回:越界即报,回落到 阈值∓3 才复位)──
    if (!st->temp_alerted) {
        if (in->temp_c >= ALERT_TEMP_HOT_C || in->temp_c <= ALERT_TEMP_COLD_C) {
            out.emit_temp_alert = true;
            st->temp_alerted = true;
        }
    } else {
        // 复位条件:既离开过热带、也离开过冷带
        if (in->temp_c < (ALERT_TEMP_HOT_C - ALERT_TEMP_HYST_C) &&
            in->temp_c > (ALERT_TEMP_COLD_C + ALERT_TEMP_HYST_C)) {
            st->temp_alerted = false;
        }
    }

    // ── 低电量(带滞回:<=15 报,>=20 复位)──
    if (!st->low_batt_alerted) {
        if (in->battery_pct <= ALERT_BATTERY_LOW_PCT) {
            out.emit_low_battery = true;
            st->low_batt_alerted = true;
        }
    } else {
        if (in->battery_pct >= ALERT_BATTERY_RESET_PCT) {
            st->low_batt_alerted = false;
        }
    }

    // ── lifted:加速度模长持续偏低(拿起≈失重;真杯盖看不到底座 present 位,只能这样反推)──
    float mag = sqrtf(in->ax * in->ax + in->ay * in->ay + in->az * in->az);
    if (mag < IMU_LIFTED_MAG_G) {
        if (!st->lifting) {
            st->lifting = true;
            st->lift_since_ms = now_ms;
        }
    } else {
        st->lifting = false;
    }
    bool lifted_now = st->lifting && (now_ms - st->lift_since_ms) >= IMU_LIFTED_MS;

    // ── 手势:盖顶压力 → 松手时按接触时长分 tap/long_press ──
    // 状态机极简:接触上升沿记时,下降沿(松手)按时长分类发一次事件。
    // 为什么在"松手"发而非"够久即发":接触时长只有到松手才知道,一次性算准;
    // 且一次接触恰好一个事件(不重复),与契约 duration_ms 天然对齐。
    // 短于 GESTURE_TAP_MIN_MS 的接触视为抖动/噪声,丢弃(不产生事件)。
    bool contact = in->press_g >= GESTURE_PRESS_MIN_G;
    if (contact) {
        if (!st->press_contact) {
            st->press_contact = true;
            st->press_since_ms = now_ms;
        }
    } else if (st->press_contact) {
        st->press_contact = false;
        uint32_t dur = now_ms - st->press_since_ms;
        if (dur >= (uint32_t)GESTURE_TAP_MIN_MS) {
            out.emit_gesture = true;
            out.gesture_type = (dur >= (uint32_t)GESTURE_LONG_PRESS_MS) ? EVENT_LONG_PRESS
                                                                       : EVENT_TAP;
            out.gesture_duration_ms = (int)dur;
        }
    }

    // ── 合成 motion(优先级:shake > tilt > lifted > idle)──
    if (in_shake_hold) {
        out.motion = MOTION_SHAKE;
    } else if (st->tilting) {
        out.motion = MOTION_TILT;
    } else if (lifted_now) {
        out.motion = MOTION_LIFTED;
    } else {
        out.motion = MOTION_IDLE;
    }
    return out;
}
