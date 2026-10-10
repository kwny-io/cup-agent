/**
 * 下行 config 的持久化(NVS)—— 掉电续存上报间隔。
 *
 * 为什么单列一个薄壳,而不塞进 wifi_sta:Wi-Fi 的 NVS 初始化在 `wifi_sta_connect`
 * 里,**SSID 为空时那个函数提前 return**(见 wifi_sta.c),于是"没配 Wi-Fi 的裸板"
 * 就没有初始化 NVS。config 要落盘不能假设它已初始化 —— 故本模块自带**幂等**的
 * nvs_flash_init(重复调用返回 ESP_OK,安全)。
 *
 * 只做"初始化 / 读 / 写"三件事,零业务判断(裁定在纯 C 的 cmd_exec)。
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** 幂等初始化 NVS。启动时调一次(与 wifi_sta 各自初始化,互不依赖)。 */
bool cmd_store_init(void);

/** 读上次存的上报间隔(ms)。@return true = 命中;false = 没存过(NVS 空/未写)。 */
bool cmd_store_load_report_ms(int32_t *out);

/** 存上报间隔(ms)。@return true = 写成功。 */
bool cmd_store_save_report_ms(int32_t v);

#ifdef __cplusplus
}
#endif
