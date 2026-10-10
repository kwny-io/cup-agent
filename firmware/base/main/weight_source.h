/**
 * 称重源抽象 —— 主循环只认这个接口,不认具体 ADC/芯片。
 *
 * 与杯盖的 sensor_source 同理:M6 验收要在**没有称重传感器**的裸板上先把整条链路
 * (联网→上报→收指令)跑通,默认走**合成源**;真称重(HX711 + 应变片)是可选驱动。
 *
 * 为什么单列一个源、而不复用杯盖的 sensor_source:底座**没有 IMU/液位/倾角**,
 * 契约 §3 的 BaseTelemetrySchema 也不含 imu/rssi —— 强行共用一个"全字段"结构只会
 * 让底座多出一堆永远 false 的字段,反而更容易把契约写错。故底座独立一个窄接口。
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** 一帧原始称重读数。缺哪个传感器,对应 has_* 即 false(数值忽略)。 */
typedef struct {
    bool has_weight;
    float weight_g;      // 总重(含皮重)克

    bool has_temp;
    float temp_c;        // 环境/底温 ℃(热水注入温补用)

    bool has_battery;
    int battery_pct;     // 0..100
    bool charging;
} weight_sample_t;

/** 初始化所选称重源(默认合成)。 */
void weight_source_init(void);

/** 读一帧。`now_ms` 供合成源生成随时间变化的波形。 */
void weight_source_read(weight_sample_t *out, uint32_t now_ms);

/** 当前源名字,仅用于启动日志。 */
const char *weight_source_name(void);

/**
 * 合成源单帧生成(纯函数:只依赖 now_ms,零硬件/零 IDF)。
 * 公开出来是为了让宿主单测能扫描输出恒在契约 §3 的合法区间。
 */
void weight_synth_read(weight_sample_t *out, uint32_t now_ms);

/**
 * 合成**单元**特性:给定真值重量与温度,按应变片的*真实*漂移系数与噪声生成一帧读数。
 *   raw = true_w_g + K_CELL·(temp_c − T_REF) + noise(now_ms)
 * K_CELL / T_REF 是单元的固有特性(固件不知道,靠 weight_comp 自标定),故这里给的是
 * **未补偿**原始读数。
 *
 * 公开出来是为了让宿主单测能**编排任意场景**(自由改真值/温度)走完整条链(温补 → 判定),
 * 而不必在测试里复写单元的系数与噪声模型 —— 否则两处会慢慢漂开,断言就守不住真行为。
 */
float weight_synth_unit_raw(float true_w_g, float temp_c, uint32_t now_ms);

#ifdef __cplusplus
}
#endif
