/**
 * 宿主单测 —— 硬件脸眼睛状态机(eye_state.c)。零 IDF,mingw gcc 直接编译。
 *
 * 覆盖:默认输入、十二态优先级(交接 > 受惊 > 强制表情 > 物理 > 低电 > 瞬时 > 环境 > 待机)、
 * 交接闭眼包络(§1.3 签名时刻)、水烫叠加态(§3 加分项)、低电三次慢眨(§3 #11)、
 * 一次性强制表情(§5.1 #1)、眨眼瞬态、字符串安全。
 * 与 apps/web/src/lib/eyes.ts 同口径 —— 这里钉的就是"两具身体同一套词汇表"。
 */
#include "eye_state.h"

#include <stdio.h>
#include <math.h>

static int g_fail = 0, g_total = 0;
static void ok(int cond, const char *what) {
    g_total++;
    if (!cond) { g_fail++; printf("  ✗ %s\n", what); }
    else printf("  ✓ %s\n", what);
}

#define DT (1.0f / 60.0f)
/** 契约 motion 枚举 —— 直接用契约头,杜绝"测试另立一套"再对上错序。 */
#include "contract_dev.h"

/** 以给定输入推进 n 帧,返回最后一帧姿态指针。 */
static const eye_pose_t *run(eye_eyes_t *e, const eye_inputs_t *inp, int frames) {
    const eye_pose_t *p = NULL;
    for (int i = 0; i < frames; i++) p = eyes_step(e, DT, inp);
    return p;
}

static void test_defaults(void) {
    printf("[默认输入:未知值 = 不触发任何加分项]\n");
    eye_inputs_t i = eye_inputs_default();
    ok(i.owner == EYE_OWNER_LID, "owner 默认 lid");
    ok(i.motion == EYE_MOTION_NONE, "motion 默认未知");
    ok(i.battery_pct == EYE_PCT_NONE, "battery 默认未知");
    ok(isnan(i.temp_c), "temp 默认 NaN(不判烫)");
    ok(i.disposition == EYE_DISPO_NORMAL, "性格默认 NORMAL");
    // 钉死契约 motion 枚举**顺序**(契约 MOTION_STATES = idle,tilt,shake,lifted):
    // 曾把 eye_state.c 里硬编码成 idle,lifted,tilt,shake —— 测试另立一套同错序而假绿,
    // 真机喂 motion_state_t 时 shake 会被当成 tilt。这里直接断言契约序,杜绝再漂。
    ok(MOTION_IDLE == 0 && MOTION_TILT == 1 && MOTION_SHAKE == 2 && MOTION_LIFTED == 3,
       "契约 motion 序 = idle,tilt,shake,lifted");
}

static void test_init_idle(void) {
    printf("[起手:idle、睁眼、无烫]\n");
    eye_eyes_t e; eyes_init(&e);
    eye_inputs_t in = eye_inputs_default();
    const eye_pose_t *p = run(&e, &in, 1);
    ok(p->state == EYE_IDLE, "初始 idle");
    ok(p->openness > 0.9f, "初始睁眼");
    ok(!p->hot, "初始无烫");
    ok(e.state == EYE_IDLE, "结构性状态同姿态");
}

static void test_priority_handoff_top(void) {
    printf("[优先级:交接最高 —— 屏持脸 → 立即 sleep]\n");
    eye_eyes_t e; eyes_init(&e);
    eye_inputs_t in = eye_inputs_default();
    // 即便同时摇杯 + 低电,交接也压过一切
    in.owner = EYE_OWNER_SCREEN;
    in.motion = MOTION_SHAKE;
    in.battery_pct = 5;
    const eye_pose_t *p = run(&e, &in, 1);
    ok(p->state == EYE_SLEEP, "屏持脸 → sleep(压过 shake/低电)");
}

static void test_priority_physical(void) {
    printf("[优先级:本地物理(shake/lifted/tilt)]\n");
    eye_eyes_t e; eyes_init(&e);
    eye_inputs_t in = eye_inputs_default();

    // 起摇那一瞬 → 受惊
    in.motion = MOTION_SHAKE;
    ok(run(&e, &in, 1)->state == EYE_STARTLED, "motion=shake 起摇 → startled");

    // 静默一会(受惊包络落),再看 lifted
    in.motion = MOTION_IDLE;
    run(&e, &in, 120); // 2s > STARTLED_S
    in.motion = MOTION_LIFTED;
    ok(run(&e, &in, 1)->state == EYE_LOOK, "motion=lifted → look");

    // tilt:即使 motion 不是 tilt,倾角超阈值也算
    in.motion = MOTION_IDLE; in.tilt_deg = 25.0f;
    ok(run(&e, &in, 1)->state == EYE_TILT, "tilt_deg≥20 → tilt");
    in.tilt_deg = 0.0f;
}

static void test_priority_battery(void) {
    printf("[优先级:低电虚弱(充电时不算)]\n");
    eye_eyes_t e; eyes_init(&e);
    eye_inputs_t in = eye_inputs_default();
    in.battery_pct = 10;
    ok(run(&e, &in, 1)->state == EYE_WEAK, "低电 → weak");
    in.charging = true;
    ok(run(&e, &in, 1)->state != EYE_WEAK, "充电时不显弱");
    in.charging = false; in.battery_pct = 80;
    ok(run(&e, &in, 1)->state != EYE_WEAK, "电量足 → 不 weak");
}

static void test_content_timed(void) {
    printf("[优先级:喝一口满足,自收自散]\n");
    eye_eyes_t e; eyes_init(&e);
    eye_inputs_t in = eye_inputs_default();
    eyes_note_drink(&e);
    ok(run(&e, &in, 1)->state == EYE_CONTENT, "drink → content(弧眼)");
    ok(run(&e, &in, 1)->arc, "content 时 arc=true(笑眼)");
    // 3.5s 后自落
    run(&e, &in, (int)(4.0f / DT));
    ok(e.state != EYE_CONTENT, "4s 后不再 content");
}

static void test_environment(void) {
    printf("[优先级:被遗忘 > 长期性格 > 打盹]\n");
    eye_eyes_t e; eyes_init(&e);
    eye_inputs_t in = eye_inputs_default();

    in.forgot_sec = EYE_FORGOT_AFTER_S + 1.0f;
    in.disposition = EYE_DISPO_SULKY; // 两个都成立 → 被遗忘胜
    ok(run(&e, &in, 1)->state == EYE_FORGOTTEN, "被遗忘压过性格");
    in.forgot_sec = 0.0f;
    ok(run(&e, &in, 1)->state == EYE_SULKY, "sulky 性格 → sulky");
    in.disposition = EYE_DISPO_SMUG;
    ok(run(&e, &in, 1)->state == EYE_SMUG, "smug 性格 → smug");
    in.disposition = EYE_DISPO_NORMAL;
    in.idle_sec = EYE_NAP_AFTER_S + 1.0f;
    ok(run(&e, &in, 1)->state == EYE_NAP, "久无事件 → nap");
}

static void test_blink_transient(void) {
    printf("[待机:眨眼是叠加在 idle 上的瞬态]\n");
    eye_eyes_t e; eyes_init(&e);
    eye_inputs_t in = eye_inputs_default();
    int saw_blink = 0;
    for (int i = 0; i < (int)(6.5f / DT); i++) {
        const eye_pose_t *p = eyes_step(&e, DT, &in);
        if (p->state == EYE_BLINK) saw_blink = 1;
    }
    ok(saw_blink, "6.5s 待机内至少眨一次(活着的第一要素)");
}

static void test_hot_overlay(void) {
    printf("[加分项:水烫是叠加态,不是第 13 态]\n");
    eye_eyes_t e; eyes_init(&e);
    eye_inputs_t in = eye_inputs_default();

    in.temp_c = 30.0f;
    const eye_pose_t *p = run(&e, &in, 1);
    ok(!p->hot, "30℃ → 不烫");
    ok(p->state == EYE_IDLE, "烫不改状态名");

    in.temp_c = 60.0f;
    p = run(&e, &in, 1);
    ok(p->hot, "60℃ → hot=true");
    ok(p->state == EYE_IDLE, "烫时状态名仍是 idle(叠加,非新态)");
    float phase0 = p->steam_phase;
    p = run(&e, &in, 60);
    ok(p->steam_phase > phase0, "烫时蒸汽相位随时间推进");
    ok(p->squint >= EYE_HOT_SQUINT - 1e-5f, "烫叠了眯眼");

    in.temp_c = NAN;
    ok(!run(&e, &in, 1)->hot, "NaN → 不烫(未知安全)");
}

static void test_handoff_envelope(void) {
    printf("[§1.3 交接:状态名当帧切,开度平滑(签名时刻)]\n");
    eye_eyes_t e; eyes_init(&e);
    eye_inputs_t in = eye_inputs_default();
    run(&e, &in, 1);
    ok(e.handoff < 0.05f, "lid 侧 handoff≈0");

    in.owner = EYE_OWNER_SCREEN;
    const eye_pose_t *p = eyes_step(&e, DT, &in);
    ok(p->state == EYE_SLEEP, "首帧状态名立刻 sleep");
    ok(p->openness > 0.8f, "但开度只降一点(不是直接灭屏)");
    // 0.4s 后应闭到 0
    p = run(&e, &in, (int)(0.5f / DT));
    ok(p->openness < 0.05f, "0.5s 后闭到 0");

    // 回 lid 侧 → 逐渐睁开
    in.owner = EYE_OWNER_LID;
    p = eyes_step(&e, DT, &in);
    ok(p->openness > 0.0f && p->openness < 0.9f, "回程首帧半开(逐渐睁)");
    p = run(&e, &in, (int)(0.6f / DT));
    ok(p->openness > 0.8f, "0.6s 后睁开");
}

static void test_expression_override(void) {
    printf("[§5.1 #1 强制表情:压过其余,但不越交接]\n");
    eye_eyes_t e; eyes_init(&e);
    eye_inputs_t in = eye_inputs_default();
    eyes_note_expression(&e, EYE_SMUG, 1.0f);
    ok(run(&e, &in, 1)->state == EYE_SMUG, "强制表情生效");
    // 1s 后自落
    run(&e, &in, (int)(1.2f / DT));
    ok(e.state != EYE_SMUG, "1.2s 后回落");
    // 再强制一次,但屏持脸 → 交接仍胜
    eyes_note_expression(&e, EYE_SMUG, 1.0f);
    in.owner = EYE_OWNER_SCREEN;
    ok(run(&e, &in, 1)->state == EYE_SLEEP, "交接铁律不可越");
}

static void test_weak_slow_blink(void) {
    printf("[§3 #11 低电:三次慢眨]\n");
    eye_eyes_t e; eyes_init(&e);
    eye_inputs_t in = eye_inputs_default();
    in.battery_pct = 8;
    int closes = 0, was_open = 1;
    for (int i = 0; i < (int)(6.0f / DT); i++) {
        const eye_pose_t *p = eyes_step(&e, DT, &in);
        int now_closed = (p->openness < 0.05f);
        if (was_open && now_closed) closes++;
        was_open = !now_closed;
    }
    ok(closes >= EYE_WEAK_BLINK_COUNT, "6s 内至少三次慢眨");
    ok(e.state == EYE_WEAK, "状态名恒为 weak(半闭是常驻)");
}

static void test_sulky_droop(void) {
    printf("[加分项:水越低越耷拉 / 情绪名不变]\n");
    eye_eyes_t e; eyes_init(&e);
    eye_inputs_t in = eye_inputs_default();
    in.disposition = EYE_DISPO_SULKY;
    in.level01 = 1.0f;
    float hi = run(&e, &in, 1)->squint;
    in.level01 = 0.05f; // 很低
    float lo = run(&e, &in, 1)->squint;
    ok(lo > hi, "水低 → 更耷拉(眯得更多)");
}

static void test_str_safe(void) {
    printf("[状态名永不 NULL]\n");
    for (int s = 0; s <= EYE_FORGOTTEN; s++) ok(eye_state_str((eye_state_t)s) != NULL, "已知态");
    ok(eye_state_str((eye_state_t)999) != NULL, "未知枚举也非 NULL");
}

int main(void) {
    printf("== eye_state 硬件脸状态机 宿主单测 ==\n");
    test_defaults();
    test_init_idle();
    test_priority_handoff_top();
    test_priority_physical();
    test_priority_battery();
    test_content_timed();
    test_environment();
    test_blink_transient();
    test_hot_overlay();
    test_handoff_envelope();
    test_expression_override();
    test_weak_slow_blink();
    test_sulky_droop();
    test_str_safe();
    printf("\n== %d/%d 通过,%d 失败 ==\n", g_total - g_fail, g_total, g_fail);
    return g_fail == 0 ? 0 : 1;
}
