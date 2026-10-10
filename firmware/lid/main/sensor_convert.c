/**
 * 杯盖 · 传感器换算层实现 —— 常量与符号约定见 sensor_convert.h。
 * 全是寄存器字节 → 物理量的算术,零 IDF、零硬件,故可宿主单测(对着 datasheet 算例)。
 */
#include "sensor_convert.h"

#include <math.h>

// ── BMI160 ─────────────────────────────────────────────────────
float bmi160_accel_i16(int16_t raw) {
    return (float)raw / BMI160_ACCEL_LSB_PER_G;
}

float bmi160_gyro_i16(int16_t raw) {
    return (float)raw / BMI160_GYRO_LSB_PER_DPS;
}

void bmi160_fill_imu(sensor_sample_t *out,
                     int16_t ax, int16_t ay, int16_t az,
                     int16_t gx, int16_t gy, int16_t gz) {
    if (!out) return;
    out->has_imu = true;
    out->ax = bmi160_accel_i16(ax);
    out->ay = bmi160_accel_i16(ay);
    out->az = bmi160_accel_i16(az);
    out->gx = bmi160_gyro_i16(gx);
    out->gy = bmi160_gyro_i16(gy);
    out->gz = bmi160_gyro_i16(gz);
}

void bmi160_fill_tilt(sensor_sample_t *out, int16_t ax, int16_t ay, int16_t az) {
    if (!out) return;

    float fx = bmi160_accel_i16(ax);
    float fy = bmi160_accel_i16(ay);
    float fz = bmi160_accel_i16(az);
    float mag = sqrtf(fx * fx + fy * fy + fz * fz);

    // 竖直 = +Y 朝上:倾角 = ay 与全模长的夹角。
    float deg = 0.0f;
    if (mag > 1e-3f) {
        float c = fy / mag;
        if (c > 1.0f) c = 1.0f;
        if (c < -1.0f) c = -1.0f;
        deg = acosf(c) * (180.0f / 3.14159265358979323846f);
    }

    int dir = 0;
    if (deg < 1.0f) {
        // 竖直:水平分量近零,方位无意义,取 0。
        dir = 0;
    } else {
        // 倾倒方位:水平分量 (ax, az) 的极角,映射到 [0,360)。
        float ang = atan2f(fx, fz) * (180.0f / 3.14159265358979323846f);
        if (ang < 0.0f) ang += 360.0f;
        dir = (int)(ang + 0.5f);
        if (dir >= 360) dir -= 360;
    }

    out->has_tilt = true;
    out->tilt_deg = deg;
    out->tilt_dir = dir;
}

// ── DS18B20 ────────────────────────────────────────────────────
float ds18b20_temp_c(uint8_t lsb, uint8_t msb) {
    int16_t raw = (int16_t)(((uint16_t)msb << 8) | (uint16_t)lsb);
    return (float)raw / 16.0f;
}

bool ds18b20_no_device(uint16_t raw16) {
    return raw16 == 0xFFFFu || raw16 == 0x0000u;
}

// ── VL53L0X ────────────────────────────────────────────────────
float vl53l0x_range_mm(uint16_t raw_mm) {
    if (raw_mm >= VL53L0X_RANGE_MAX_MM) return (float)VL53L0X_RANGE_MAX_MM;
    return (float)raw_mm;
}

bool vl53l0x_valid(uint16_t raw_mm) {
    return raw_mm < VL53L0X_RANGE_MAX_MM;
}

// ── INA219 ─────────────────────────────────────────────────────
float ina219_bus_mv(uint16_t raw) {
    return (float)raw * 4.0f;
}

float ina219_shunt_mv(int16_t raw) {
    return (float)raw * 0.01f;
}

float ina219_current_ma(int16_t raw_shunt, float shunt_ohm) {
    if (shunt_ohm <= 0.0f) return 0.0f;
    return ina219_shunt_mv(raw_shunt) / shunt_ohm;
}

float ina219_power_mw(float bus_mv, float current_ma) {
    return bus_mv * current_ma / 1000.0f;
}

int ina219_battery_pct(float bus_v) {
    const float v_empty = 3.0f, v_full = 4.2f;
    float f = (bus_v - v_empty) / (v_full - v_empty);
    if (f < 0.0f) f = 0.0f;
    if (f > 1.0f) f = 1.0f;
    return (int)(f * 100.0f + 0.5f);
}
