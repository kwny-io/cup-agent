/**
 * 传感源实现。
 *
 * 合成源(sensor_synth_read)是**纯函数、零依赖**,既供裸板 bring-up,也可宿主单测
 * (断言它产出的读数恒在契约合法区间内 —— 合成器吐出越界值会让后端 zod 拒收,
 * 那正是最难查的一类"链路看着通、数据进不去")。
 *
 * 真传感器驱动按需打开:未接的传感器对应 has_* 为 false,主循环与会话照常。
 */
#include "sensor_source.h"

#include <math.h>
#include <string.h>

// ── 合成源(默认;裸板无传感器时用它把链路先跑通)──────────────────

/**
 * 生成一帧缓慢变化的**契约合法**读数。波形靠 now_ms 驱动,故确定性、可复现:
 *   - 温度:25℃ 附近 ±1.5℃ 慢正弦
 *   - 液位:50% 附近游走(0..400ml)
 *   - 电量:88% → 缓慢下降(每约 1 小时掉 1 个百分点),不会跳崖
 *   - IMU:静止 ≈1g(竖直),叠加极小幅噪声;tilt 取 0
 * 目的是"像真的",而不是"制造事件" —— 事件由 lid_logic 从这些读数推。
 */
void sensor_synth_read(sensor_sample_t *out, uint32_t now_ms) {
    if (!out) return;
    memset(out, 0, sizeof(*out));

    float t_s = (float)now_ms / 1000.0f;

    out->has_temp = true;
    out->temp_c = 25.0f + 1.5f * sinf(t_s * 0.05f);          // ≈[23.5, 26.5]

    // 液位:在 200ml 附近以很慢的三角/正弦游走,clamp 到 [0,400]
    float ml = 200.0f + 120.0f * sinf(t_s * 0.01f);          // ≈[80, 320]
    if (ml < 0.0f) ml = 0.0f;
    if (ml > 400.0f) ml = 400.0f;
    out->has_level = true;
    out->level_mm = ml * (130.0f / 400.0f);                  // 复用几何:400ml=130mm

    out->has_battery = true;
    int drop = (int)(t_s / 3600.0f);                         // 每小时 -1%
    out->battery_pct = 88 - drop;
    if (out->battery_pct < 0) out->battery_pct = 0;
    out->charging = false;

    out->has_imu = true;
    // 静止:竖直 ≈1g;叠加极小噪声(远低于 shake 阈值 0.35g,不会误判)
    out->ax = 0.01f * sinf(t_s * 3.0f);
    out->ay = 1.0f + 0.01f * cosf(t_s * 2.7f);
    out->az = 0.01f * sinf(t_s * 3.3f);
    out->gx = 0.2f * sinf(t_s * 1.1f);
    out->gy = 0.2f * cosf(t_s * 1.3f);
    out->gz = 0.0f;

    out->has_tilt = true;
    out->tilt_deg = 0.0f;   // 合成源默认平放;倾倒场景由宿主单测的注入构造
    out->tilt_dir = 0;
}

// ── 真实驱动(按需打开;未接的传感器 has_* 为 false)──────────────

// 选路:bring-up 阶段默认合成源。接真传感器时把对应分支填进 sensor_real_*。
#ifndef CUP_SENSOR_USE_SYNTH
#define CUP_SENSOR_USE_SYNTH 1
#endif

#if CUP_SENSOR_USE_SYNTH

void sensor_source_init(void) {}
void sensor_source_read(sensor_sample_t *out, uint32_t now_ms) {
    sensor_synth_read(out, now_ms);
}
const char *sensor_source_name(void) { return "synthetic"; }

#else
// ── 真传感器路径(占位:接线上真芯片后在此实现)────────────────────
// BMI160(六轴, I2C):has_imu/has_tilt
// DS18B20 (1-Wire)   :has_temp
// VL53L0X (I2C ToF)  :has_level
// INA219 (I2C)       :has_battery
//
// 引脚只作**示例**,接线时按自己板子的实际走线定,再改这里:
//   I2C   SDA=GPIO8  SCL=GPIO9   (BMI160 / VL53L0X / INA219 共总线,注意地址不撞:
//                                 BMI160=0x68/0x69, VL53L0X=0x29, INA219=0x40)
//   1-Wire DQ=GPIO4              (DS18B20,需 4.7k 上拉到 3V3)
// 注意:每个传感器独立可选 —— 没接的把对应 has_* 留 false,主循环照常上报其余字段。
#error "真传感器路径尚未实现;先用合成源(CUP_SENSOR_USE_SYNTH=1)把链路跑通。"
#endif
