/**
 * Wi-Fi STA 实现(ESP-IDF)。事件组等 IP;连上后返回。
 */
#include "wifi_sta.h"

#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

#include "cmd_store.h"
#include "prov.h"

static const char *TAG = "wifi";

#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAIL_BIT      BIT1
#define WIFI_MAX_RETRY     5

static EventGroupHandle_t s_events;
static int s_retry = 0;
static volatile bool s_connected = false;

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg; (void)data;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        s_connected = false;
        if (s_retry < WIFI_MAX_RETRY) {
            s_retry++;
            ESP_LOGW(TAG, "断开,重连中(%d/%d)", s_retry, WIFI_MAX_RETRY);
            esp_wifi_connect();
        } else {
            xEventGroupSetBits(s_events, WIFI_FAIL_BIT);
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *ev = (ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "拿到 IP:" IPSTR, IP2STR(&ev->ip_info.ip));
        s_retry = 0;
        s_connected = true;
        xEventGroupSetBits(s_events, WIFI_CONNECTED_BIT);
    }
}

bool wifi_bringup(void) {
#if CONFIG_CUP_USE_BLE_PROV
    // 先确保 NVS 可用(凭据与 WiFi 校准都落在 NVS);prov/wifi_sta 都自己做,幂等。
    if (cmd_store_init()) {  // 复用同一套"NVS 幂等初始化"(NO_FREE_PAGES/版本变更 → 擦除)
        if (prov_is_provisioned()) {
            ESP_LOGI(TAG, "NVS 已有 Wi-Fi 凭据,跳过 BLE 配网");
        } else {
            ESP_LOGW(TAG, "未配网 —— 起 BLE 配网,请用手机 App 连接设备 \"%s\"",
                     CUP_PROV_DEVICE_NAME);
            if (!prov_start_ble()) {
                ESP_LOGE(TAG, "BLE 配网失败,退回已写死的 SSID(若 menuconfig 里配了)");
            }
        }
        prov_deinit();  // 配网结束:把 BLE 占用的射频/内存还给 WiFi
    }
#endif
    return wifi_sta_connect();
}

bool wifi_sta_connect(void) {
    if (CONFIG_CUP_WIFI_SSID[0] == '\0') {
        ESP_LOGE(TAG, "CUP_WIFI_SSID 为空 —— 用 idf.py menuconfig 配 Wi-Fi");
        return false;
    }
    // NVS(存 WiFi 校准数据)必须先初始化
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    // 幂等:开了 BLE 配网(prov)时,它已建过默认事件循环与 netif;重复建返回
    // ESP_ERR_INVALID_STATE,用 ESP_ERROR_CHECK 会直接 abort。故这两步容错。
    esp_err_t nerr = esp_netif_init();
    if (nerr != ESP_OK && nerr != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "esp_netif_init 失败:%s", esp_err_to_name(nerr));
        return false;
    }
    esp_err_t lerr = esp_event_loop_create_default();
    if (lerr != ESP_OK && lerr != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "事件循环创建失败:%s", esp_err_to_name(lerr));
        return false;
    }
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    s_events = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &on_wifi_event, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &on_wifi_event, NULL, NULL));

    wifi_config_t wc = {0};
    strncpy((char *)wc.sta.ssid, CONFIG_CUP_WIFI_SSID, sizeof(wc.sta.ssid) - 1);
    strncpy((char *)wc.sta.password, CONFIG_CUP_WIFI_PASSWORD, sizeof(wc.sta.password) - 1);
    // 无密码 = 开放网络;有密码按 WPA2。阈值设太严会让开放网连不上。
    wc.sta.threshold.authmode =
        (CONFIG_CUP_WIFI_PASSWORD[0] == '\0') ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    ESP_ERROR_CHECK(esp_wifi_start());

    ESP_LOGI(TAG, "连接 SSID \"%s\" …", CONFIG_CUP_WIFI_SSID);
    EventBits_t bits = xEventGroupWaitBits(
        s_events, WIFI_CONNECTED_BIT | WIFI_FAIL_BIT, pdFALSE, pdFALSE,
        pdMS_TO_TICKS(20000));
    if (bits & WIFI_CONNECTED_BIT) return true;
    ESP_LOGE(TAG, "Wi-Fi 连接失败");
    return false;
}

bool wifi_sta_connected(void) { return s_connected; }

int wifi_sta_rssi(void) {
    if (!s_connected) return 0;
    wifi_ap_record_t ap;
    if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) return ap.rssi;
    return 0;
}
