/**
 * BLE 配网 provisioning(ESP-IDF 薄壳)—— 第一次把 Wi-Fi 密码告诉杯子。
 *
 * 为什么需要:杯子没有屏幕键盘(架构 §3.5 / 术语表"配网")。用户手机 App 通过
 * **BLE** 把 SSID/密码发进来,设备落 NVS;之后每次开机直接读 NVS 连。ESP-IDF 自带
 * `wifi_prov_mgr`,scheme 用 `WIFI_PROV_SCHEME_BLE` —— 于是这段是标准骨架的薄封装,
 * 不自己造协议(风险:安全/配对坑多)。
 *
 * 与 `wifi_sta` 的关系:
 *   - **已配网** → 走 `wifi_sta_connect()`(读 Kconfig/或 NVS 里的凭据连 STA,轻量);
 *   - **未配网且开了 BLE 配网** → 本模块起 BLE,等 App 发凭据;成功后 wifi_sta 连。
 * 本模块**不替代** wifi_sta,只在"还没凭据"时补上获取凭据这一步。
 *
 * 安全:用 Security 1(POP 为空)。生产应上 Security 2(证书)+ 自定义 POP(风险 R13),
 * 属独立里程碑 —— 本刀先打通"能配网"这条链路。
 *
 * 本机无 IDF,只做 shim 语法检查;真编译由用户侧完成(见 firmware/README.md §二)。
 */
#pragma once

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/** BLE 设备名(手机 App 扫描时看到的)。 */
#define CUP_PROV_DEVICE_NAME "cup-agent"

/**
 * 查询是否已配网(NVS 里已有 Wi-Fi 凭据)。
 * @return true = 已配网,可直接 wifi_sta_connect;false = 需要走 BLE 配网。
 */
bool prov_is_provisioned(void);

/**
 * 起 BLE 配网并**阻塞**等待配网完成(手机 App 发来凭据)。
 * 仅在 `prov_is_provisioned()` 为 false 时调用。
 * @return true = 配网成功(凭据已落 NVS);false = 初始化/配网失败。
 */
bool prov_start_ble(void);

/** 配网管理资源释放(配网完成后调,把 BLE 占的射频/内存还给 WiFi)。 */
void prov_deinit(void);

#ifdef __cplusplus
}
#endif
