/**
 * 杯盖 · 传感器换算层(纯 C,零 IDF 依赖)。
 *
 * 为什么要这层:真驱动分两半 —— **① 从芯片读原始字节**(I2C/1-Wire,要 IDF、要真板),
 * **② 把字节按芯片手册换算成物理量**(纯算术,零依赖)。②占了大头,也最容易错(灵敏度、
 * 补码、缩放),却完全不必等板子。把它单独抽出来,真板一到,①那半截只管"读字节 → 交给这里"。
 *
 * 于是宿主单测能把这些换算对着**芯片手册的算例**逐条钉死(见 host_test/test_sensor_convert.c):
 * 手册给的 raw↔物理量对照点,正是最难靠肉眼发现错的一类(灵敏度写错一个数,链路照样通、
 * 数据也能进后端,只是全是错的)。
 *
 * 单位与符号约定**必须与契约/合成源一致**,否则同一个杯子在真板与模拟器上表现不同:
 *   - 加速度 g、角速度 °/s、温度 ℃、距离 mm、电压 mV / V —— 与 sensor_source.h 的字段同单位。
 *   - **竖直(=)后 +Y 轴朝上**:静止时读数 ≈ (0, 1g, 0),倾角 0°。故 tilt_deg = acos(ay/|a|),
 *     与合成源"竖直 ≈1g 落在 ay"一致(见 sensor_source.c:50)。芯片贴装方向不同时,只在
 *     驱动里重排三轴,不动本层。
 *
 * 本层的常量是**芯片特性**(取自各自 datasheet 的默认满量程档),属设备内部实现,不进契约 ——
 * 与 weight_comp 的漂移系数同理。
 */
#pragma once

#include "sensor_source.h"   // sensor_sample_t(填结构用)

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// ── BMI160(六轴 IMU,I2C)────────────────────────────────────────
// 灵敏度取决于量程档 register 0x41/0x42 的选择;这里取两个常用默认档,须与驱动配置一致。
/** 加速度 ±2g 档:2^15 / 2g = 16384 LSB/g。 */
#define BMI160_ACCEL_LSB_PER_G 16384.0f
/** 角速度 ±2000 °/s 档:16.4 LSB/(°/s)。 */
#define BMI160_GYRO_LSB_PER_DPS 16.4f

/** 加速度原始 16 位（补码）→ g。 */
float bmi160_accel_i16(int16_t raw);
/** 角速度原始 16 位（补码）→ °/s。 */
float bmi160_gyro_i16(int16_t raw);

/**
 * 用三轴加速度原始值填 out 的 IMU 字段(has_imu + ax/ay/az + gx/gy/gz)。
 * 角速度传 0 表示本帧不带(常规档省电;实时档才带)。
 */
void bmi160_fill_imu(sensor_sample_t *out,
                     int16_t ax, int16_t ay, int16_t az,
                     int16_t gx, int16_t gy, int16_t gz);

/**
 * 用三轴加速度原始值填 out 的倾角字段(has_tilt + tilt_deg + tilt_dir)。
 * tilt_deg = acos(ay / |a|) ∈ [0,180]（竖直=0,平放=90,倒置=180）。
 * tilt_dir = 倾倒方位,atan2(ax, az) 映射到 [0,360);竖直时水平分量近零 → 取 0。
 */
void bmi160_fill_tilt(sensor_sample_t *out, int16_t ax, int16_t ay, int16_t az);

// ── DS18B20(水温,1-Wire)────────────────────────────────────────
// 12 位输出:16 位补码原始值 = (msb<<8)|lsb,物理温度 = raw16 / 16.0(每 LSB = 1/16 ℃)。
/**
 * 原始 16 位 → ℃。含补码符号处理(负温如 −25.0625 ℃ = 0xFE6F)。
 */
float ds18b20_temp_c(uint8_t lsb, uint8_t msb);

/**
 * 总线"疑似没接器件"的启发式判断:全 1(0xFFFF,总线上拉 → 主机读回全 1)或全 0
 * (0x0000,总线被拉到地)。**不是权威判据** —— 0x0000 恰是合法的 0.0000 ℃。
 * 驱动用它过滤明显的"没接/短路",真值仍以 decode 结果为准。
 */
bool ds18b20_no_device(uint16_t raw16);

// ── VL53L0X(液位 ToF,I2C)───────────────────────────────────────
/** 手册的"无有效目标"哨兵值:≥ 此值视为超量程(杯内 130mm,正常远小于此)。 */
#define VL53L0X_RANGE_MAX_MM 8190

/**
 * 原始测距(mm)→ 有效液位距离(mm)。≥ VL53L0X_RANGE_MAX_MM 的哨兵/超量程值截到上限,
 * 避免把"无目标"当成一个很近或很远的假距离。
 */
float vl53l0x_range_mm(uint16_t raw_mm);

/** 原始值是否为有效测距(未超量程)。 */
bool vl53l0x_valid(uint16_t raw_mm);

// ── INA219(电量,I2C)───────────────────────────────────────────
/** 总线电压:LBS = 4 mV → mV。 */
float ina219_bus_mv(uint16_t raw);
/** 分流电压:LBS = 10 µV = 0.01 mV → mV(补码,可负=反向电流)。 */
float ina219_shunt_mv(int16_t raw);
/** 电流(mA)= 分流电压(mV) / 分流电阻(Ω)。 */
float ina219_current_ma(int16_t raw_shunt, float shunt_ohm);
/** 功率(mW)= 总线电压(mV) × 电流(mA) / 1000。 */
float ina219_power_mw(float bus_mv, float current_ma);

/**
 * 电池电压 → 电量百分比(0..100,整数,clamp)。按**单节锂电**线性近似:
 * v_empty=3.0V → 0%,v_full=4.2V → 100%。锂电放电曲线非线性的,故这是粗估;
 * 要精确需按放电曲线查表(留待有实测数据后再说)。
 */
int ina219_battery_pct(float bus_v);

#ifdef __cplusplus
}
#endif
