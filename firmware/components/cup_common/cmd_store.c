/**
 * 下行 config 持久化实现(NVS)。见 cmd_store.h 的说明。
 */
#include "cmd_store.h"

#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "cmd_store";

#define NS_NAME "cup_cfg"
#define KEY_REPORT_MS "report_ms"

bool cmd_store_init(void) {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        // 与 wifi_sta 同样的处理:分区损坏/版本变更 → 擦除重建
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_flash_init 失败:%s", esp_err_to_name(err));
        return false;
    }
    return true;
}

bool cmd_store_load_report_ms(int32_t *out) {
    if (!out) return false;
    nvs_handle_t h;
    if (nvs_open(NS_NAME, NVS_READONLY, &h) != ESP_OK) return false;  // 命名空间还不存在
    int32_t v = 0;
    esp_err_t err = nvs_get_i32(h, KEY_REPORT_MS, &v);
    nvs_close(h);
    if (err != ESP_OK) return false;
    *out = v;
    return true;
}

bool cmd_store_save_report_ms(int32_t v) {
    nvs_handle_t h;
    if (nvs_open(NS_NAME, NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGE(TAG, "nvs_open 失败");
        return false;
    }
    esp_err_t err = nvs_set_i32(h, KEY_REPORT_MS, v);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "保存 report_ms 失败:%s", esp_err_to_name(err));
        return false;
    }
    return true;
}
