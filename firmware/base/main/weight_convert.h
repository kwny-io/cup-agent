/**
 * 底座 · 称重换算层(纯 C,零 IDF 依赖)。
 *
 * 与杯盖的 sensor_convert 同一个思路:HX711 的驱动分两半 —— **① 读原始 24 位计数**
 * (GPIO 翻转时序,要 IDF、要真板),**② 计数 → 克**(纯算术 + 两个单元常数)。
 * ② 抽在这里,真板到了 ① 只管读计数。
 *
 * 两个单元常数**不是芯片特性,而是这组"传感器+机械结构"的标定值**:
 *   - `zero_count`:空载时的原始计数(零点)。
 *   - `counts_per_g`:每克对应多少个计数(灵敏度)。
 * 它们随每台底座不同,故**存 NVS、开机标定/或出厂写入**,本层只做算术 —— 由调用方传入。
 * (与 weight_comp 的温漂系数同理:固件不猜系数,只在拿到系数后计算。)
 *
 * 24 位补码:计数范围 ±2^23,HX711 手册规定:
 *   0x800000 = 上电/复位、0x7FFFFF = 掉电 —— 用 hx711_power_status 识别。
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** 24 位原始计数的特殊值(手册):上电/复位 与 掉电。 */
#define HX711_RAW_POWER_ON  0x800000u
#define HX711_RAW_POWER_OFF 0x7FFFFFu

/** 传感器上电/掉电状态。 */
typedef enum {
    HX711_OK = 0,         // 正常读数
    HX711_POWER_ON,       // 0x800000 上电/复位
    HX711_POWER_OFF,      // 0x7FFFFF 掉电
} hx711_status_t;

/** 24 位原始计数 → 有符号 32 位(补码符号扩展)。 */
int32_t hx711_signed_24(uint32_t raw24);

/** 识别上电/掉电哨兵(其余归 HX711_OK)。 */
hx711_status_t hx711_power_status(uint32_t raw24);

/**
 * 原始计数 → 净重克:`(count − zero_count) / counts_per_g`。
 * counts_per_g ≤ 0(未标定)→ 返回 0(不猜,宁可显示 0 也不显示离谱值)。
 */
float hx711_apply_scale(int32_t count, int32_t zero_count, float counts_per_g);

#ifdef __cplusplus
}
#endif
