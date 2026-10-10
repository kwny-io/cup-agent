/**
 * BLE 配网实现(ESP-IDF wifi_prov_mgr 薄封装)。
 * 只做"查是否已配网 / 起 BLE 等凭据 / 释放"三件事;连 STA 仍归 wifi_sta。
 *
 * 版本敏感:只用 wifi_prov_mgr_* 的稳定接口 + app_event_handler 字段(不碰
 * scheme_event_handler 那套版本间改过名的宏),且 `= {0}` 零初始化,以免不同 IDF
 * 版本字段差异导致编译失败。本机无 IDF,仅 shim 语法检查;真编译见 README §二。
 */
#include "prov.h"

#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_wifi.h"
#include "nvs_flash.h"
#include "sdkconfig.h"
#include "wifi_provisioning/manager.h"
#include "wifi_provisioning/scheme_ble.h"

static const char *TAG = "prov";

static bool s_inited = false;

/** wifi_prov_mgr 的事件回调:只记日志(凭据的落地由 mgr 自己完成)。 */
static void prov_event_handler(void *user_data, wifi_prov_cb_event_t event, void *event_data) {
    (void)user_data; (void)event_data;
    switch (event) {
        case WIFI_PROV_START:
            ESP_LOGI(TAG, "BLE 配网已启动(设备名 \"%s\"),用手机 App 连接", CUP_PROV_DEVICE_NAME);
            break;
        case WIFI_PROV_CRED_RECV:
            ESP_LOGI(TAG, "收到 Wi-Fi 凭据,尝试连接…");
            break;
        case WIFI_PROV_CRED_FAIL:
            ESP_LOGE(TAG, "凭据连接失败(SSID/密码错?),重新配网");
            break;
        case WIFI_PROV_CRED_SUCCESS:
            ESP_LOGI(TAG, "Wi-Fi 凭据验证成功");
            break;
        case WIFI_PROV_END:
            ESP_LOGI(TAG, "配网流程结束");
            break;
        default:
            break;
    }
}

bool prov_is_provisioned(void) {
    // 只设 scheme 与 app 回调,其余零初始化 —— 少依赖版本相关的宏(见文件头"版本敏感")。
    wifi_prov_mgr_config_t cfg = {0};
    cfg.scheme = wifi_prov_scheme_ble;
    cfg.app_event_handler.event_cb = prov_event_handler;
    cfg.app_event_handler.user_data = NULL;
    if (wifi_prov_mgr_init(cfg) != ESP_OK) {
        ESP_LOGE(TAG, "wifi_prov_mgr_init 失败");
        return false;
    }
    s_inited = true;
    bool provisioned = false;
    wifi_prov_mgr_is_provisioned(&provisioned);
    ESP_LOGI(TAG, "配网状态:%s", provisioned ? "已配网" : "未配网");
    return provisioned;
}

bool prov_start_ble(void) {
    if (!s_inited) {
        ESP_LOGE(TAG, "prov_is_provisioned 未先调用");
        return false;
    }
    // Security 1,POP 空(生产换 Security 2 + POP,见 prov.h 注释 / 风险 R13)。
    esp_err_t err = wifi_prov_mgr_start_provisioning(
        WIFI_PROV_SECURITY_1, NULL /* pop */, CUP_PROV_DEVICE_NAME, NULL /* service_key */);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "start_provisioning 失败:%s", esp_err_to_name(err));
        return false;
    }
    wifi_prov_mgr_wait();  // 阻塞直到 App 发来凭据并验证成功
    ESP_LOGI(TAG, "BLE 配网完成,凭据已落 NVS");
    return true;
}

void prov_deinit(void) {
    if (s_inited) {
        wifi_prov_mgr_deinit();
        s_inited = false;
    }
}
