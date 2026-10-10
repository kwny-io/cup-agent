/**
 * 杯盖 · 板载 LED 驱动(IDF 薄壳,LEDC/PWM)。
 *
 * 板载一颗**单色数字 LED**(BOM 预留 GPIO10),故驱动只做"亮/灭 + 占空比":
 *   · SOLID  → 满占空常亮
 *   · BLINK  → 每半周期翻转,闪 count 下后自动灭
 *   · BREATH → 占空比三角波(0→满→0),呼吸 count 个周期后自动灭
 * 颜色分量来自 led_pattern.color,**单色 LED 不吃**(仅日志;换 RGB 时在这里扩)。
 *
 * 为什么用 LEDC 而不是 GPIO 电平:PWM 才能呼吸;而且 LEDC 是硬件定时器,不占 CPU。
 * 为什么是"tick 式"而非独立任务:主循环本来就在跑,led_driver_tick 顺手推进即可 ——
 * 少一个任务就少一类竞态(与 bring-up 阶段"采样/上报同一任务"同一取舍)。
 *
 * 本机无 ESP-IDF,本文件仅做 shim 语法检查(见 README),非真编译。
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "led_pattern.h"

#ifdef __cplusplus
extern "C" {
#endif

/** 板载单色 LED 的 GPIO(BOM 预留 GPIO10;换板改这里)。 */
#ifndef CUP_LED_GPIO
#define CUP_LED_GPIO 10
#endif

/** LEDC 分辨率(bit):10 位 → 占空比 0..1023,呼吸够平滑。 */
#define LED_DRIVER_RES_BITS 10
/** LEDC PWM 频率(Hz):够高不闪、够低占空比分辨率足。 */
#define LED_DRIVER_PWM_HZ 5000

/**
 * 初始化 LEDC + 绑 GPIO。启动时调一次。
 * @return true = 成功
 */
bool led_driver_init(void);

/**
 * 开始播一条灯效(非阻塞)。会覆盖上一条。
 * OFF → 等价于 led_driver_off()。
 */
void led_driver_play(const led_pattern_t *p);

/** 立即灭灯,停掉当前灯效。 */
void led_driver_off(void);

/**
 * 主循环每轮调一次,推进当前灯效(闪烁翻转 / 呼吸调占空 / 一次性灯效跑完自灭)。
 * @param now_ms 单调毫秒(xTaskGetTickCount*portTICK_PERIOD_MS 之类)
 */
void led_driver_tick(uint32_t now_ms);

/** 当前是否还有灯效在播(OFF/播完 → false)。 */
bool led_driver_active(void);

#ifdef __cplusplus
}
#endif
