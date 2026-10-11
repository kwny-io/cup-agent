/**
 * 硬件脸 · 眼睛状态机实现(纯 C)。见 eye_state.h 的立场说明。
 * 逻辑与 apps/web/src/lib/eyes.ts 同源同口径(十二态、同一优先级、同一阈值)。
 */
#include "eye_state.h"

#include "contract_dev.h"  // 契约 motion_state_t(单一真值源;勿在本文件另立枚举)

// 严格 -std=c11 下 math.h 不暴露 M_PI(它是 POSIX/X-Open 扩展)。自带定义,零依赖。
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// ── 小工具 ───────────────────────────────────────────────────────
static float clampf(float v, float lo, float hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

/** 伪随机但确定:同一 seed 恒定,便于测试;用于眨眼间隔抖动。 */
static float jitter(float seed) {
    float x = sinf(seed * 12.9898f) * 43758.5453f;
    return x - floorf(x);
}

// ── 姿态初值 ─────────────────────────────────────────────────────
static eye_pose_t make_pose(eye_state_t s, bool hot, float steam_phase) {
    eye_pose_t p;
    p.state = s;
    p.openness = 1.0f;
    p.gaze_x = 0.0f;
    p.gaze_y = 0.0f;
    p.pupil_scale = 1.0f;
    p.rotate = 0.0f;
    p.drop_y = 0.0f;
    p.arc = false;
    p.squint = 0.0f;
    p.hot = hot;
    p.steam_phase = steam_phase;
    return p;
}

eye_inputs_t eye_inputs_default(void) {
    eye_inputs_t i;
    i.owner = EYE_OWNER_LID;
    i.motion = EYE_MOTION_NONE;
    i.tilt_deg = 0.0f;
    i.tilt_dir = 0.0f;
    i.battery_pct = EYE_PCT_NONE;
    i.charging = false;
    i.level01 = 1.0f;
    i.temp_c = NAN;
    i.disposition = EYE_DISPO_NORMAL;
    i.idle_sec = 0.0f;
    i.forgot_sec = 0.0f;
    return i;
}

void eyes_init(eye_eyes_t *e) {
    e->clock = 0.0f;
    e->state = EYE_IDLE;
    e->blink_in = EYE_BLINK_MIN_S;
    e->blink_t = -1.0f;
    e->blink_dur = EYE_BLINK_S;
    e->startled_t = 0.0f;
    e->content_t = 0.0f;
    e->wobble = 0.0f;
    e->drift = 0.0f;
    e->was_shaking = false;
    e->seed = 1.0f;
    e->hot_state = false;
    e->steam_phase = 0.0f;
    e->handoff = 0.0f;
    e->weak_blinks = 0;
    e->weak_blink_in = EYE_WEAK_BLINK_GAP_S;
    e->weak_rest_t = 0.0f;
    e->expr_state = -1;
    e->expr_t = 0.0f;
    e->pose = make_pose(EYE_IDLE, false, 0.0f);
}

void eyes_note_drink(eye_eyes_t *e) {
    e->content_t = EYE_CONTENT_S;
}

void eyes_note_startled(eye_eyes_t *e) {
    e->startled_t = EYE_STARTLED_S;
    e->wobble = 0.0f;
}

void eyes_note_expression(eye_eyes_t *e, eye_state_t state, float seconds) {
    e->expr_state = (int)state;
    e->expr_t = seconds;
}

// ── 状态决议:按 §1.3 优先级自上而下第一个命中 ────────────────────
static eye_state_t resolve_state(const eye_eyes_t *e, const eye_inputs_t *inp, bool shaking) {
    // 1. 交接:前端有脸 → 盖子闭眼(最高)
    if (inp->owner == EYE_OWNER_SCREEN) return EYE_SLEEP;
    // 2. 本地物理
    if (shaking || e->startled_t > 0.0f) return EYE_STARTLED;
    // 手势语法的**一次性强制表情**(§5.1 #1):压过其余一切,但不越交接(上面已 return)
    if (e->expr_t > 0.0f && e->expr_state >= 0) return (eye_state_t)e->expr_state;
    if (inp->motion == MOTION_LIFTED) return EYE_LOOK;
    if (inp->motion == MOTION_TILT || inp->tilt_deg >= EYE_TILT_DEG) return EYE_TILT;
    // 3. 身体态:低电虚弱(充电时不算)
    if (inp->battery_pct != EYE_PCT_NONE && inp->battery_pct <= EYE_LOW_BATTERY_PCT && !inp->charging)
        return EYE_WEAK;
    // 4. 瞬时事件:喝一口满足(有时限)
    if (e->content_t > 0.0f) return EYE_CONTENT;
    // 5. 环境态:被遗忘(抗议)> 长期性格 > 打盹
    if (inp->forgot_sec >= EYE_FORGOT_AFTER_S) return EYE_FORGOTTEN;
    if (inp->disposition == EYE_DISPO_SULKY) return EYE_SULKY;
    if (inp->disposition == EYE_DISPO_SMUG) return EYE_SMUG;
    if (inp->idle_sec >= EYE_NAP_AFTER_S) return EYE_NAP;
    // 6. 待机:眨眼是叠加在 idle 上的瞬态
    if (e->blink_t >= 0.0f) return EYE_BLINK;
    return EYE_IDLE;
}

/** 低电虚弱:三次慢眨(间隔 WEAK_BLINK_GAP_S),一轮完静息 WEAK_CYCLE_REST_S 再起一轮。 */
static void run_weak_blink(eye_eyes_t *e, float dt) {
    if (e->weak_rest_t > 0.0f) {
        e->weak_rest_t -= dt;
        if (e->weak_rest_t <= 0.0f) {
            e->weak_blinks = 0;
            e->weak_blink_in = 0.0f;
        }
        return;
    }
    e->weak_blink_in -= dt;
    if (e->weak_blink_in <= 0.0f) {
        e->blink_t = 0.0f;
        e->blink_dur = EYE_WEAK_BLINK_S;
        e->weak_blinks += 1;
        if (e->weak_blinks >= EYE_WEAK_BLINK_COUNT) e->weak_rest_t = EYE_WEAK_CYCLE_REST_S;
        else e->weak_blink_in = EYE_WEAK_BLINK_GAP_S;
    }
}

/** 眨眼排程:倒计时到 0 开眨,眨完重掷 2–6s;正在眨则推进进度。 */
static void run_blink(eye_eyes_t *e, float dt, eye_state_t s) {
    if (e->blink_t >= 0.0f) {
        e->blink_t += dt;
        if (e->blink_t >= e->blink_dur) {
            e->blink_t = -1.0f;
            e->blink_dur = EYE_BLINK_S;
            e->seed += 1.0f;
        }
        return;
    }
    if (s == EYE_WEAK) {
        run_weak_blink(e, dt);
        return;
    }
    // 离开 weak 时复位三连进度
    e->weak_blinks = 0;
    e->weak_blink_in = EYE_WEAK_BLINK_GAP_S;
    e->weak_rest_t = 0.0f;
    if (s == EYE_SLEEP || s == EYE_NAP || s == EYE_SULKY) return;
    e->blink_in -= dt;
    if (e->blink_in <= 0.0f) {
        e->blink_t = 0.0f;
        float span = EYE_BLINK_MAX_S - EYE_BLINK_MIN_S;
        e->blink_in = EYE_BLINK_MIN_S + jitter(e->seed) * span;
    }
}

static eye_pose_t compute_pose(eye_eyes_t *e, eye_state_t s, const eye_inputs_t *inp, float dt) {
    // 倾斜 → 视线朝低处偏;屏幕水平轴上的投影决定左右
    float dir_rad = (inp->tilt_dir * (float)M_PI) / 180.0f;
    float look_x = clampf(cosf(dir_rad), -1.0f, 1.0f);
    float tilt_amt = clampf(inp->tilt_deg / 45.0f, 0.0f, 1.0f);
    // 待机轻微视线漂移(正弦,不走神过头)
    float drift_x = sinf(e->drift * 0.5f) * 0.12f;
    float drift_y = sinf(e->drift * 0.31f + 1.7f) * 0.08f;
    // 加分项:水烫 → 眯一眼(叠加在所有状态上)
    float hot_squint = e->hot_state ? EYE_HOT_SQUINT : 0.0f;

    eye_pose_t pose = make_pose(s, e->hot_state, e->steam_phase);
    pose.gaze_x = drift_x;
    pose.gaze_y = drift_y;

    switch (s) {
        case EYE_SLEEP:
            // 闭眼开度**交给交接包络**(末尾 ×(1-handoff)):备忘 §1.3 的"缓慢闭眼"由此而来
            pose.openness = 1.0f;
            pose.gaze_x = 0.0f; pose.gaze_y = 0.0f;
            pose.squint = hot_squint;
            break;
        case EYE_NAP: {
            // 打盹:极低开度 + 每 8s 极缓 1px 呼吸位移
            float breathe = sinf(e->clock * (float)(M_PI * 2.0) / 8.0f) * 0.015f;
            pose.openness = 0.05f; pose.drop_y = breathe;
            pose.gaze_x = 0.0f; pose.gaze_y = 0.0f;
            pose.squint = hot_squint;
            break;
        }
        case EYE_BLINK: {
            // 眨眼曲线:0→1→0 的半正弦;时长用 blink_dur(低电慢眨更长)
            float p = clampf(e->blink_t / e->blink_dur, 0.0f, 1.0f);
            pose.openness = fabsf(cosf(p * (float)M_PI));
            pose.squint = hot_squint;
            break;
        }
        case EYE_STARTLED: {
            // 受惊:瞳孔放大 + 反向摆动(带阻尼,越晃越小)
            e->wobble += dt * (float)M_PI * 2.0f * 6.0f;
            float damp = e->startled_t / EYE_STARTLED_S;
            pose.openness = 1.15f;
            pose.pupil_scale = 1.5f;
            pose.gaze_x = sinf(e->wobble) * 0.35f * damp;
            pose.gaze_y = 0.0f;
            pose.squint = hot_squint;
            break;
        }
        case EYE_LOOK:
            // 看主人:瞳孔上看(略偏"你"那侧)
            pose.gaze_y = -0.45f;
            pose.gaze_x = clampf(look_x * 0.3f + drift_x, -1.0f, 1.0f);
            pose.squint = hot_squint;
            break;
        case EYE_TILT:
            // 倾斜跟随:视线朝低处,整眼微转,慢一拍
            pose.gaze_x = clampf(look_x * 0.55f + drift_x * 0.4f, -1.0f, 1.0f);
            pose.gaze_y = 0.1f * tilt_amt;
            pose.rotate = -look_x * tilt_amt * 0.18f;
            pose.drop_y = 0.05f * tilt_amt;
            pose.squint = hot_squint;
            break;
        case EYE_CONTENT:
            // 满足:两眼弯成弧 + 微抬
            pose.arc = true;
            pose.openness = 0.92f;
            pose.gaze_y = -0.1f;
            pose.squint = hot_squint;
            break;
        case EYE_SULKY: {
            // 蔫:上眼睑下垂 60%,视线向下;水越低越耷拉(加分项)
            float droop = 0.4f - clampf(inp->level01 / 0.4f, 0.0f, 1.0f) * 0.06f;
            pose.openness = 1.0f - 0.6f;
            pose.squint = droop + hot_squint;
            pose.gaze_y = 0.4f;
            pose.gaze_x = drift_x * 0.5f;
            break;
        }
        case EYE_SMUG:
            // 得意:眼底平直、微眯
            pose.openness = 0.75f;
            pose.squint = 0.7f + hot_squint;
            pose.gaze_y = -0.12f;
            pose.gaze_x = drift_x * 0.5f;
            break;
        case EYE_WEAK: {
            // 低电:半闭 + 瞳孔缩小。§3 #11 的"三次慢眨"在此态内下压眼睑
            float blink = e->blink_t >= 0.0f
                ? fabsf(cosf(clampf(e->blink_t / e->blink_dur, 0.0f, 1.0f) * (float)M_PI))
                : 1.0f;
            pose.openness = 0.42f * blink;
            pose.pupil_scale = 0.68f;
            pose.drop_y = 0.15f;
            pose.squint = hot_squint;
            break;
        }
        case EYE_FORGOTTEN:
            // 抗议:视线坚决转开一侧,不看你
            pose.openness = 0.9f;
            pose.gaze_x = -0.72f;
            pose.gaze_y = 0.12f;
            pose.squint = hot_squint;
            break;
        case EYE_IDLE:
        default: {
            // 水位过低 → 眼神轻微耷拉(与 sulky 同向,较弱)
            float level_drop = clampf((EYE_LOW_LEVEL - inp->level01) / EYE_LOW_LEVEL, 0.0f, 1.0f) * 0.25f;
            pose.openness = 1.0f - level_drop;
            pose.gaze_y = drift_y + level_drop * 0.2f;
            pose.squint = hot_squint;
            break;
        }
    }

    // 交接包络:上眼睑按 handoff 下压(1 → 全闭)。sleep 分支已设 openness=1,
    // 由此变成"逐渐闭合";回 lid 侧则逐渐睁开 → 备忘 §1.3 的"缓慢闭眼/睁眼"签名时刻。
    if (e->handoff > 0.0f) pose.openness = pose.openness * (1.0f - e->handoff);
    pose.squint = fminf(1.0f, pose.squint + e->handoff);
    return pose;
}

const eye_pose_t *eyes_step(eye_eyes_t *e, float dt, const eye_inputs_t *inp) {
    e->clock += dt;
    e->drift += dt;

    // 加分项:水烫判定 + 蒸汽相位(与状态正交,叠加态)
    e->hot_state = !isnan(inp->temp_c) && inp->temp_c >= EYE_HOT_TEMP_C;
    if (e->hot_state) e->steam_phase += dt * 2.4f;

    // 边沿:起摇那一瞬直接受惊(即便调用方没喂事件,IMU 也在)
    bool shaking = (inp->motion == MOTION_SHAKE);
    if (shaking && !e->was_shaking) eyes_note_startled(e);
    e->was_shaking = shaking;

    if (e->startled_t > 0.0f) { e->startled_t -= dt; if (e->startled_t < 0.0f) e->startled_t = 0.0f; }
    if (e->content_t > 0.0f)  { e->content_t -= dt;  if (e->content_t < 0.0f)  e->content_t = 0.0f; }
    if (e->expr_t > 0.0f) {
        e->expr_t -= dt;
        if (e->expr_t <= 0.0f) { e->expr_t = 0.0f; e->expr_state = -1; }
    }

    // 交接闭合度缓动(备忘 §1.3):屏幕持脸 → 渐闭;盖持脸 → 渐睁
    float target = (inp->owner == EYE_OWNER_SCREEN) ? 1.0f : 0.0f;
    float step_n = dt / EYE_HANDOFF_S;
    if (e->handoff < target) { e->handoff += step_n; if (e->handoff > target) e->handoff = target; }
    else if (e->handoff > target) { e->handoff -= step_n; if (e->handoff < target) e->handoff = target; }

    // 眨眼计时(只在"看得见"的状态里走表)
    eye_state_t s = resolve_state(e, inp, shaking);
    run_blink(e, dt, s);

    e->state = s;
    e->pose = compute_pose(e, s, inp, dt);
    return &e->pose;
}

const char *eye_state_str(eye_state_t s) {
    switch (s) {
        case EYE_NAP:       return "nap";
        case EYE_SLEEP:     return "sleep";
        case EYE_IDLE:      return "idle";
        case EYE_BLINK:     return "blink";
        case EYE_LOOK:      return "look";
        case EYE_STARTLED:  return "startled";
        case EYE_TILT:      return "tilt";
        case EYE_CONTENT:   return "content";
        case EYE_SULKY:     return "sulky";
        case EYE_SMUG:      return "smug";
        case EYE_WEAK:      return "weak";
        case EYE_FORGOTTEN: return "forgotten";
    }
    return "?";
}
