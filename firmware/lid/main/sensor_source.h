/**
 * 传感源抽象 —— 主循环只认这个接口,**不认具体芯片**。
 *
 * 为什么要这层:M5 验收 #1 是"真盖子的数据,后端一行不改就能收"。为了让固件
 * 在**没有任何传感器**的裸板上也能先跑通整条链路(联网→上报→收指令),默认走
 * **合成源**:按时间生成缓慢变化的合法读数。真传感器驱动(BMI160 六轴 / DS18B20
 * 水温 / VL53L0X 液位)是**可选**的,哪个没接,对应 has_* 就 false,主循环照常。
 *
 * 于是 bring-up 分两步走:先在裸板上把通信链路跑绿(合成源),再逐颗焊传感器把
 * 对应驱动填进来 —— 每步都能独立看到进展。
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** 一帧原始读数。缺哪个传感器,对应 has_* 即 false(数值忽略)。 */
typedef struct {
    bool has_temp;
    float temp_c;          // 水温 ℃

    bool has_imu;
    float ax, ay, az;      // 加速度 g —— 判定 shake 用
    float gx, gy, gz;      // 角速度 °/s(实时档才带)

    bool has_tilt;
    float tilt_deg;        // 倾角 0..180
    int tilt_dir;          // 倾倒方位 0..359

    bool has_battery;
    int battery_pct;       // 0..100
    bool charging;

    bool has_level;
    float level_mm;        // 液位高度 mm(ToF 测)

    bool has_press;        // 盖顶压力传感器(手势用;未接则 false)
    float press_g;         // 盖顶压力(g);0 = 无接触
} sensor_sample_t;

/** 初始化所选传感源(默认合成)。 */
void sensor_source_init(void);

/** 读一帧。`now_ms` 用于合成源生成随时间变化的波形。 */
void sensor_source_read(sensor_sample_t *out, uint32_t now_ms);

/** 当前源的名字,仅用于启动日志(排障时一眼看出跑的是哪条路)。 */
const char *sensor_source_name(void);

/**
 * 合成源单帧生成(纯函数:只依赖 now_ms,零硬件/零 IDF)。
 * 公开出来是为了让宿主单测能直接扫描它的输出区间 —— 见 host_test/test_sensor_source.c。
 */
void sensor_synth_read(sensor_sample_t *out, uint32_t now_ms);

#ifdef __cplusplus
}
#endif
