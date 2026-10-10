/**
 * 宿主单测 —— 端侧判定(lid_logic.c)。零 IDF 依赖,mingw gcc 直接编译运行。
 * 覆盖:shake 能量/连续帧/400ms hold、tilt 35°/2s、lifted 低模长 200ms、
 * 温度与电量的滞回边界、motion 优先级。
 */
#include "lid_logic.h"

#include <math.h>
#include <stdio.h>

static int g_fail = 0, g_total = 0;
static void ok(int cond, const char *what) {
    g_total++;
    if (!cond) { g_fail++; printf("  ✗ %s\n", what); }
    else printf("  ✓ %s\n", what);
}

// 造一帧静止加速度(模长≈1g,竖直)。
static lid_logic_in_t still(float temp, int batt) {
    lid_logic_in_t in = {0};
    in.temp_c = temp; in.ax = 0.0f; in.ay = 1.0f; in.az = 0.0f;
    in.tilt_deg = 0.0f; in.battery_pct = batt;
    return in;
}
// 造一帧晃动(加速度模长远超 1g)。
static lid_logic_in_t shaken(float temp, int batt) {
    lid_logic_in_t in = still(temp, batt);
    in.ax = 1.2f; in.ay = 1.0f; in.az = 0.9f;  // 模长 > 1.35
    return in;
}
// 造一帧"被拿起"(平稳拿起:加速度模长 <0.8g 但落幅温和,晃动能量 <0.35 —— 干净的 lifted)。
static lid_logic_in_t lifted_sample(float temp, int batt) {
    lid_logic_in_t in = {0};
    in.temp_c = temp; in.ax = 0.0f; in.ay = 0.7f; in.az = 0.0f;  // 模长 0.7,能量 0.3 <0.35
    in.tilt_deg = 0.0f; in.battery_pct = batt;
    return in;
}

static void test_shake_energy(void) {
    printf("[shake 能量定义]\n");
    ok(fabsf(lid_shake_energy(0, 1, 0) - 0.0f) < 1e-4f, "静止(模长1g)能量≈0");
    ok(lid_shake_energy(1.2f, 1.0f, 0.9f) > IMU_SHAKE_ENERGY_G, "晃动能量超阈值");
    ok(lid_shake_energy(0.1f, 0.1f, 0.1f) > IMU_SHAKE_ENERGY_G, "轻碰(模长远小于1g)也判超阈值");
}

static void test_shake_frames_and_hold(void) {
    printf("[shake 连续帧 + 400ms hold]\n");
    lid_logic_t st; lid_logic_init(&st);
    lid_logic_in_t s = shaken(25.0f, 80);
    uint32_t t = 1000;

    // 头 7 帧:未达 8 帧,不应发 shake
    int emitted_early = 0;
    for (int i = 0; i < IMU_SHAKE_FRAMES - 1; i++) {
        emitted_early += lid_logic_step(&st, &s, t).emit_shake;
        t += 10;
    }
    ok(emitted_early == 0, "不足 8 帧不发 shake 事件");

    // 第 8 帧:达阈值,发一次,且 motion=shake
    lid_logic_out_t o8 = lid_logic_step(&st, &s, t);
    ok(o8.emit_shake == 1, "第 8 帧发 shake 事件(上升沿)");
    ok(o8.motion == MOTION_SHAKE, "第 8 帧 motion=shake");
    t += 10;

    // 继续晃:不再重复发事件
    ok(lid_logic_step(&st, &s, t).emit_shake == 0, "持续晃动不重复发事件");

    // 停手:hold 窗内(距最后晃动 <400ms)motion 仍是 shake
    lid_logic_in_t st8 = still(25.0f, 80);
    ok(lid_logic_step(&st, &st8, t + 100).motion == MOTION_SHAKE, "停手 100ms 内仍 shake(hold)");
    // 超过 400ms 落回 idle
    ok(lid_logic_step(&st, &st8, t + 399).motion == MOTION_SHAKE, "399ms 仍 shake");
    ok(lid_logic_step(&st, &st8, t + 500).motion == MOTION_IDLE, "超 400ms 落回 idle");

    // 落回后停手期间能量归零,再晃需重新攒 8 帧
    lid_logic_init(&st);
    int emit_first = 0;
    for (int i = 0; i < IMU_SHAKE_FRAMES + 5; i++) {
        emit_first += lid_logic_step(&st, &s, (uint32_t)(i * 10)).emit_shake;
    }
    ok(emit_first >= 1, "重新晃动能再次触发(复位后)");
}

static void test_tilt_alert(void) {
    printf("[tilt 35° 持续 2s]\n");
    lid_logic_t st; lid_logic_init(&st);
    lid_logic_in_t tilt = still(25.0f, 80);
    tilt.tilt_deg = 40.0f;  // > 35

    uint32_t t = 5000;
    ok(lid_logic_step(&st, &tilt, t).motion == MOTION_TILT, "倾倒姿态 motion=tilt");
    ok(lid_logic_step(&st, &tilt, t + 1999).emit_tilt_alert == 0, "持续 1999ms 尚未报警");
    lid_logic_out_t o = lid_logic_step(&st, &tilt, t + 2000);
    ok(o.emit_tilt_alert == 1, "持续满 2000ms 发 tilt_alert");
    ok(lid_logic_step(&st, &tilt, t + 3000).emit_tilt_alert == 0, "持续倾倒不重复报警");

    // 短暂倾倒(不到 2s)复位后不报警
    lid_logic_init(&st);
    lid_logic_in_t flat = still(25.0f, 80);
    lid_logic_step(&st, &tilt, 10000);
    lid_logic_step(&st, &flat, 11000);       // 1s 后放平
    ok(lid_logic_step(&st, &tilt, 12000).emit_tilt_alert == 0, "中断过的倾倒重新计时,不误报");

    // 低于 35° 不算倾倒
    lid_logic_init(&st);
    lid_logic_in_t mild = still(25.0f, 80); mild.tilt_deg = 34.9f;
    ok(lid_logic_step(&st, &mild, 20000).motion != MOTION_TILT, "34.9° 不算倾倒");
}

static void test_temp_hysteresis(void) {
    printf("[温度报警 滞回 3 度]\n");
    lid_logic_t st; lid_logic_init(&st);
    lid_logic_in_t v = still(30.0f, 80);
    ok(lid_logic_step(&st, &v, 0).emit_temp_alert == 0, "常温不报");
    v = still(65.0f, 80);
    ok(lid_logic_step(&st, &v, 100).emit_temp_alert == 1, "65° 报热");
    // 回落到 63°(仍 >= 65-3=62)→ 仍处报警锁存,不发新事件但也没复位
    v = still(63.0f, 80);
    ok(lid_logic_step(&st, &v, 200).emit_temp_alert == 0, "63° 不重复发");
    // 回落到 61°(<62)→ 复位;随后再到 65 应能再报
    v = still(61.0f, 80);
    lid_logic_step(&st, &v, 300);
    v = still(65.0f, 80);
    ok(lid_logic_step(&st, &v, 400).emit_temp_alert == 1, "复位后再越界能重报");
    // 冷端
    lid_logic_init(&st);
    v = still(5.0f, 80);
    ok(lid_logic_step(&st, &v, 0).emit_temp_alert == 1, "5° 报冷");
}

static void test_battery_hysteresis(void) {
    printf("[低电量 <=15 报 / >=20 复位]\n");
    lid_logic_t st; lid_logic_init(&st);
    lid_logic_in_t v = still(25.0f, 16);
    ok(lid_logic_step(&st, &v, 0).emit_low_battery == 0, "16% 不报");
    v = still(25.0f, 15);
    ok(lid_logic_step(&st, &v, 100).emit_low_battery == 1, "15% 报低电");
    v = still(25.0f, 18);
    ok(lid_logic_step(&st, &v, 200).emit_low_battery == 0, "18% 不重复");
    v = still(25.0f, 20);
    lid_logic_step(&st, &v, 300);  // 复位
    v = still(25.0f, 15);
    ok(lid_logic_step(&st, &v, 400).emit_low_battery == 1, "复位后再低能重报");
}

static void test_lifted(void) {
    printf("[lifted 低模长 200ms]\n");
    lid_logic_t st; lid_logic_init(&st);
    lid_logic_in_t up = lifted_sample(25.0f, 80);
    uint32_t t = 1000;

    // 1Hz 常规档:首帧(模长 0.5 <0.8)开始计时,未满 200ms 仍 idle
    ok(lid_logic_step(&st, &up, t).motion == MOTION_IDLE, "刚拿起(未满 200ms)暂 idle");

    // 满 200ms → lifted
    lid_logic_out_t o = lid_logic_step(&st, &up, t + 200);
    ok(o.motion == MOTION_LIFTED, "低模长持续 200ms → motion=lifted");
    ok(o.emit_shake == 0, "低模长不误发 shake 事件(能量 <0.35)");
    ok(lid_logic_step(&st, &up, t + 300).motion == MOTION_LIFTED, "持续拿起仍 lifted");

    // 放回(模长回到 ≈1g)→ 立即回落 idle
    lid_logic_in_t down = still(25.0f, 80);
    ok(lid_logic_step(&st, &down, t + 400).motion == MOTION_IDLE, "放回底座 → 落回 idle");

    // 拿起期间低模长中断(抖一下超过阈值)会重新计时
    lid_logic_init(&st);
    lid_logic_step(&st, &up, 5000);            // 起计时
    lid_logic_step(&st, &down, 5100);          // 中断
    ok(lid_logic_step(&st, &up, 5200).motion == MOTION_IDLE, "中断后重新计时,不误判 lifted");
    ok(lid_logic_step(&st, &up, 5400).motion == MOTION_LIFTED, "重新计满 200ms 才 lifted");

    // 40Hz 实时档:25ms 步长下同样按 200ms 计时
    lid_logic_init(&st);
    int lifted_at = -1;
    for (int i = 0; i < 12; i++) {
        lid_logic_out_t oo = lid_logic_step(&st, &up, (uint32_t)(i * 25));
        if (oo.motion == MOTION_LIFTED && lifted_at < 0) lifted_at = i * 25;
    }
    ok(lifted_at == 200, "40Hz 下也在 200ms 判到 lifted");
}

static void test_priority(void) {
    printf("[motion 优先级 shake>tilt>lifted>idle]\n");
    lid_logic_t st; lid_logic_init(&st);
    lid_logic_in_t both = shaken(25.0f, 80); both.tilt_deg = 50.0f;
    lid_logic_out_t o = {0};
    for (int i = 0; i < IMU_SHAKE_FRAMES; i++) { o = lid_logic_step(&st, &both, (uint32_t)(i * 10)); }
    ok(o.motion == MOTION_SHAKE, "又晃又倒 → 判 shake");

    // 低模长(拿起的特征)+ 高晃动能量:两判据同时满足 → shake 胜(优先级高)
    lid_logic_init(&st);
    lid_logic_in_t violent_lift = {0};
    violent_lift.temp_c = 25.0f; violent_lift.battery_pct = 80;
    violent_lift.ax = 0.5f; violent_lift.ay = 0.3f; violent_lift.az = 0.2f;  // 模长 0.616 <0.8 且 |0.616-1|=0.384>0.35
    o = (lid_logic_out_t){0};
    for (int i = 0; i < IMU_SHAKE_FRAMES; i++) { o = lid_logic_step(&st, &violent_lift, (uint32_t)(i * 10 + 1000)); }
    ok(o.motion == MOTION_SHAKE, "低模长但晃动能量足 → 判 shake(lifted 不抢先)");

    // 平稳低模长(无晃动能量)持续够久 → lifted
    lid_logic_init(&st);
    lid_logic_in_t calm_lift = lifted_sample(25.0f, 80);
    lid_logic_step(&st, &calm_lift, 2000);
    o = lid_logic_step(&st, &calm_lift, 2200);
    ok(o.motion == MOTION_LIFTED, "平稳拿起 → 判 lifted");
}


int main(void) {
    printf("== lid_logic 宿主单测 ==\n");
    test_shake_energy();
    test_shake_frames_and_hold();
    test_tilt_alert();
    test_temp_hysteresis();
    test_battery_hysteresis();
    test_lifted();
    test_priority();
    printf("\n== %d/%d 通过,%d 失败 ==\n", g_total - g_fail, g_total, g_fail);
    return g_fail == 0 ? 0 : 1;
}
