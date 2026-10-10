/**
 * Wi-Fi STA 连接 —— 杯盖联 broker 的前置。
 *
 * 这是**唯一**用到 ESP-IDF 的联网薄壳:连上(拿到 IP)就返回,不掺任何业务。
 * SSID/密码来自 menuconfig(Kconfig.projbuild),不硬编码。
 *
 * 为什么用 nvs_flash + esp_wifi 事件组这套"官方骨架":ESP-IDF 里它最稳,
 * 断线自愈交给 esp_wifi 自己(设了 reconnect);我们只等 IP。
 */
#pragma once

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * 初始化 NVS(若未初始化)并阻塞连接到 SSID。
 * @return true = 已拿到 IP;false = 超时/失败(调用方可重试或降级)。
 */
bool wifi_sta_connect(void);

/**
 * 联网上线(两个主循环应调这个,而不是 wifi_sta_connect)。
 *
 * 关了 `CUP_USE_BLE_PROV`(默认)→ 等价于 wifi_sta_connect()。
 * 开了 → 先查 NVS 有无 Wi-Fi 凭据:没有则起 BLE 配网**阻塞**等手机 App 发凭据
 * (见 prov.h),拿到后照常连 STA;有则直接连,不再打扰用户。
 * 无论哪条路,返回前都会把配网管理器释放掉,把射频/内存还给 WiFi。
 *
 * @return true = 已拿到 IP;false = 失败(调用方可重试或降级为空跑)。
 */
bool wifi_bringup(void);

/** 是否已连上(拿到 IP)。 */
bool wifi_sta_connected(void);

/** 当前连接的 AP 的信号强度(dBm);未连上返回 0。供遥测 rssi 字段用。 */
int wifi_sta_rssi(void);

#ifdef __cplusplus
}
#endif
