/**
 * 宿主单测 —— 杯盖传感器换算层(sensor_convert.c)。零 IDF,mingw gcc 直接编译运行。
 * 断言对着各芯片手册的算例:raw↔物理量对照点(灵敏度写错一个数最难肉眼发现)。
 * 覆盖:BMI160 加速度/角速度灵敏度与符号、倾角几何(竖直/平放/倒置/方位)、
 *       DS18B20 补码正负温与"没接"启发式、VL53L0X 哨兵、INA219 电压/电流/电量、空指针。
 */
#include "sensor_convert.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

static int g_fail = 0, g_total = 0;
static void ok(int cond, const char *what) {
    g_total++;
    if (!cond) { g_fail++; printf("  ✗ %s\n", what); }
    else printf("  ✓ %s\n", what);
}
static int near(float a, float b, float eps) { return fabsf(a - b) <= eps; }

// ── BMI160 ─────────────────────────────────────────────────────
static void test_bmi160(void) {
    printf("[BMI160:加速度/角速度灵敏度]\n");
    // 手册 ±2g 档 16384 LSB/g → 满量程 32767 ≈ 2.0g
    ok(near(bmi160_accel_i16(16384), 1.0f, 1e-4f), "16384 LSB = 1.000 g");
    ok(near(bmi160_accel_i16(-16384), -1.0f, 1e-4f), "-16384 LSB = -1.000 g(补码可负)");
    ok(near(bmi160_accel_i16(0), 0.0f, 1e-6f), "0 LSB = 0 g");
    ok(near(bmi160_accel_i16(32767), 1.9999f, 1e-3f), "满量程 32767 ≈ 2 g");

    // ±2000°/s 档 16.4 LSB/(°/s)
    ok(near(bmi160_gyro_i16(16), 16.0f / 16.4f, 1e-3f), "16 LSB ≈ 0.9756 °/s");
    ok(near(bmi160_gyro_i16(16400), 1000.0f, 1e-2f), "16400 LSB = 1000 °/s");

    sensor_sample_t s;
    memset(&s, 0, sizeof(s));
    bmi160_fill_imu(&s, 0, 16384, 0, 164, 0, 0);
    ok(s.has_imu == true, "fill_imu 置 has_imu");
    ok(near(s.ay, 1.0f, 1e-4f), "fill_imu:ay = 1.000 g");
    ok(near(s.gx, 10.0f, 1e-2f), "fill_imu:gx = 10 °/s");
}

static void test_bmi160_tilt(void) {
    printf("[BMI160:倾角几何]\n");
    sensor_sample_t s;

    // 竖直:+Y 朝上 → 0°
    memset(&s, 0, sizeof(s));
    bmi160_fill_tilt(&s, 0, 16384, 0);
    ok(s.has_tilt == true, "fill_tilt 置 has_tilt");
    ok(near(s.tilt_deg, 0.0f, 0.5f), "竖直(ay=1g) → 倾角≈0°");
    ok(s.tilt_dir == 0, "竖直 → 方位取 0");

    // 平放:+Z 朝上 → 90°
    memset(&s, 0, sizeof(s));
    bmi160_fill_tilt(&s, 0, 0, 16384);
    ok(near(s.tilt_deg, 90.0f, 0.5f), "平放(az=1g) → 倾角≈90°");

    // 倒置:+Y 朝下 → 180°
    memset(&s, 0, sizeof(s));
    bmi160_fill_tilt(&s, 0, -16384, 0);
    ok(near(s.tilt_deg, 180.0f, 0.5f), "倒置(ay=-1g) → 倾角≈180°");

    // 45° 倾斜:+Y 与 +Z 各 0.707g → 45°
    memset(&s, 0, sizeof(s));
    bmi160_fill_tilt(&s, 0, 11585, 11585);
    ok(near(s.tilt_deg, 45.0f, 1.0f), "ay=az=0.707g → 倾角≈45°");

    // 方位:+X 为主 → atan2(ax,az)=90°
    memset(&s, 0, sizeof(s));
    bmi160_fill_tilt(&s, 16384, 0, 0);
    ok(s.tilt_dir == 90 || s.tilt_dir == 270, "水平朝 +X → 方位为 90/270(±)");

    // 全零加速度:mag≈0,不除零,倾角取 0
    memset(&s, 0, sizeof(s));
    bmi160_fill_tilt(&s, 0, 0, 0);
    ok(near(s.tilt_deg, 0.0f, 1e-3f), "全零加速度 → 不下溢/不 NaN,倾角 0");
}

// ── DS18B20 ────────────────────────────────────────────────────
static void test_ds18b20(void) {
    printf("[DS18B20:温度码]\n");
    // 手册算例:25.0625 ℃ = 0x0191 → lsb=0x91 msb=0x01
    ok(near(ds18b20_temp_c(0x91, 0x01), 25.0625f, 1e-3f), "0x0191 = +25.0625 ℃");
    // −25.0625 ℃ = 0xFE6F → lsb=0x6F msb=0xFE
    ok(near(ds18b20_temp_c(0x6F, 0xFE), -25.0625f, 1e-3f), "0xFE6F = −25.0625 ℃(补码)");
    // +125 ℃ = 0x07D0
    ok(near(ds18b20_temp_c(0xD0, 0x07), 125.0f, 1e-3f), "0x07D0 = +125 ℃");
    ok(near(ds18b20_temp_c(0x00, 0x00), 0.0f, 1e-6f), "0x0000 = 0 ℃");
    // −0.0625 ℃ = 0xFFFF
    ok(near(ds18b20_temp_c(0xFF, 0xFF), -0.0625f, 1e-3f), "0xFFFF = −0.0625 ℃");

    printf("[DS18B20:没接器件启发式]\n");
    ok(ds18b20_no_device(0xFFFF) == true, "全 1 → 疑似没接(上拉)");
    ok(ds18b20_no_device(0x0000) == true, "全 0 → 疑似短路/没接");
    ok(ds18b20_no_device(0x0191) == false, "正常读数 0x0191 → 有器件");
}

// ── VL53L0X ────────────────────────────────────────────────────
static void test_vl53l0x(void) {
    printf("[VL53L0X:测距哨兵]\n");
    ok(near(vl53l0x_range_mm(120), 120.0f, 1e-3f), "120mm 原样");
    ok(near(vl53l0x_range_mm(0), 0.0f, 1e-3f), "0mm 原样(贴住目标)");
    ok(vl53l0x_valid(120) == true, "120mm 有效");
    ok(vl53l0x_valid(8190) == false, "8190 = 超量程哨兵 → 无效");
    ok(near(vl53l0x_range_mm(8190), 8190.0f, 1e-3f), "哨兵截到上限");
    ok(vl53l0x_valid(65535) == false, "65535 无效");
}

// ── INA219 ─────────────────────────────────────────────────────
static void test_ina219(void) {
    printf("[INA219:电压/电流/电量]\n");
    ok(near(ina219_bus_mv(1000), 4000.0f, 1e-2f), "总线 1000 LSB = 4000 mV");
    ok(near(ina219_shunt_mv(100), 1.0f, 1e-4f), "分流 100 LSB = 1.0 mV");
    ok(near(ina219_shunt_mv(-100), -1.0f, 1e-4f), "分流 -100 LSB = -1.0 mV(反向)");
    // 0.1Ω 分流:10mV / 0.1Ω = 100mA
    ok(near(ina219_current_ma(1000, 0.1f), 100.0f, 1e-2f), "10mV / 0.1Ω = 100 mA");
    ok(near(ina219_current_ma(100, 0.0f), 0.0f, 1e-6f), "分流电阻 0 → 0(不除零)");
    ok(near(ina219_power_mw(4000.0f, 100.0f), 400.0f, 1e-2f), "4V × 100mA = 400 mW");

    printf("[INA219:电量百分比]\n");
    ok(ina219_battery_pct(4.2f) == 100, "4.2V → 100%");
    ok(ina219_battery_pct(3.0f) == 0, "3.0V → 0%");
    ok(ina219_battery_pct(2.0f) == 0, "2.0V → clamp 0%");
    ok(ina219_battery_pct(5.0f) == 100, "5.0V → clamp 100%");
    ok(ina219_battery_pct(3.6f) == 50, "3.6V → 50%");
}

static void test_null_safe(void) {
    printf("[空指针安全]\n");
    bmi160_fill_imu(NULL, 1, 2, 3, 4, 5, 6);   // 不应崩
    bmi160_fill_tilt(NULL, 1, 2, 3);
    ok(1, "fill_imu/fill_tilt 传 NULL 不崩");
}

int main(void) {
    test_bmi160();
    test_bmi160_tilt();
    test_ds18b20();
    test_vl53l0x();
    test_ina219();
    test_null_safe();
    printf("\n== %d/%d 通过,%d 失败 ==\n", g_total - g_fail, g_total, g_fail);
    return g_fail ? 1 : 0;
}
