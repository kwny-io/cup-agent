/**
 * 宿主单测 —— 合成传感源(sensor_source.c 的 synth 路径)。
 * 断言:在长时间扫描下,合成读数**恒落在契约 §2 的合法区间**。
 * 理由:合成器吐出越界值(如 temp>120 / level_pct>100)会让后端 zod 拒收 ——
 * 那是"链路看着通、数据进不去"里最难查的一类,值得用单测钉死。
 */
#include "sensor_source.h"

#include <stdio.h>

static int g_fail = 0, g_total = 0;
static void ok(int cond, const char *what) {
    g_total++;
    if (!cond) { g_fail++; printf("  ✗ %s\n", what); }
    else printf("  ✓ %s\n", what);
}

static void test_ranges_over_time(void) {
    printf("[合成源 · 长时间扫描恒在契约区间]\n");
    sensor_sample_t s;
    int ok_temp = 1, ok_level = 1, ok_batt = 1, ok_tilt = 1, ok_imu_shake_free = 1;
    // 扫 24 小时(每小时 1 帧)+ 细扫前 60 秒
    for (uint32_t i = 0; i < 24 * 3600; i += 60) {
        uint32_t ms = i * 1000u;
        sensor_synth_read(&s, ms);
        if (s.has_temp && (s.temp_c < -10.0f || s.temp_c > 120.0f)) ok_temp = 0;
        if (s.has_level && (s.level_mm < 0.0f || s.level_mm > 130.0f)) ok_level = 0;
        if (s.has_battery && (s.battery_pct < 0 || s.battery_pct > 100)) ok_batt = 0;
        if (s.has_tilt && (s.tilt_deg < 0.0f || s.tilt_deg > 180.0f)) ok_tilt = 0;
        // 合成源静止:模长必须≈1g,绝不能越过 shake 阈值(否则裸板会自己"晃"出事件)
        float mag = s.ax * s.ax + s.ay * s.ay + s.az * s.az;
        float energy = mag > 1.0f ? (mag - 1.0f) : (1.0f - mag);
        if (energy > 0.35f) ok_imu_shake_free = 0;
    }
    ok(ok_temp, "temp_c 恒在 [-10,120]");
    ok(ok_level, "level_mm 恒在 [0,130]");
    ok(ok_batt, "battery_pct 恒在 [0,100]");
    ok(ok_tilt, "tilt_deg 恒在 [0,180]");
    ok(ok_imu_shake_free, "静止模长恒≈1g,不触发 shake");
}

static void test_no_overrange_extremes(void) {
    printf("[合成源 · 极早/极晚时刻不越界]\n");
    sensor_sample_t s;
    sensor_synth_read(&s, 0);
    ok(s.battery_pct == 88, "t=0 电量 88%");
    ok(s.temp_c > 20.0f && s.temp_c < 30.0f, "t=0 温度在常温带");
    sensor_synth_read(&s, 0xFFFFFFFFu);  // 约 49.7 天(UINT32_MAX ms)
    ok(s.battery_pct >= 0 && s.battery_pct <= 100, "极晚时刻电量仍合法(下限夹住)");
    ok(s.level_mm >= 0.0f && s.level_mm <= 130.0f, "极晚时刻液位仍合法");
}

int main(void) {
    printf("== sensor_source 宿主单测 ==\n");
    test_ranges_over_time();
    test_no_overrange_extremes();
    printf("\n== %d/%d 通过,%d 失败 ==\n", g_total - g_fail, g_total, g_fail);
    return g_fail == 0 ? 0 : 1;
}
