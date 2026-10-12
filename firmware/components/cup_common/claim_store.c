/**
 * claim code 持久化实现(NVS)。见 claim_store.h 的说明。
 *
 * 存三样:码本身(str)、签发时刻(u64)、是否已用(u8)。is_used 单独一个键而非删码:
 * 保留"这枚已作废"的事实,便于排查"用户说码没用啊"这类问题。
 */
#include "claim_store.h"

#include "claim_code.h"

#include "esp_log.h"
#include "esp_random.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "claim_store";

#define NS_NAME "cup_claim"
#define KEY_CODE "code"
#define KEY_ISSUED "issued"
#define KEY_USED "used"

bool claim_store_init(void) {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_flash_init 失败:%s", esp_err_to_name(err));
        return false;
    }
    return true;
}

bool claim_store_load(char *out_code, uint64_t *out_issued, bool *out_used) {
    nvs_handle_t h;
    if (nvs_open(NS_NAME, NVS_READONLY, &h) != ESP_OK) return false;  // 还没发过
    char code[CUP_CLAIM_BUF] = {0};
    size_t len = sizeof(code);
    esp_err_t err = nvs_get_str(h, KEY_CODE, code, &len);
    if (err == ESP_OK) {
        if (out_code) {
            // nvs_get_str 已写 NUL;防越界拷进调用方缓冲。
            for (size_t i = 0; i < CUP_CLAIM_BUF; i++) {
                out_code[i] = code[i];
                if (code[i] == '\0') break;
            }
        }
        if (out_issued) {
            uint64_t v = 0;
            nvs_get_u64(h, KEY_ISSUED, &v);
            *out_issued = v;
        }
        if (out_used) {
            uint8_t u = 0;
            nvs_get_u8(h, KEY_USED, &u);
            *out_used = (u != 0);
        }
    }
    nvs_close(h);
    return err == ESP_OK;
}

/** 写码 + 签发时刻,并清 used 标志(新码自然是未用)。 */
static bool save_new(const char *code, uint64_t issued) {
    nvs_handle_t h;
    if (nvs_open(NS_NAME, NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGE(TAG, "nvs_open 失败");
        return false;
    }
    esp_err_t err = nvs_set_str(h, KEY_CODE, code);
    if (err == ESP_OK) err = nvs_set_u64(h, KEY_ISSUED, issued);
    if (err == ESP_OK) err = nvs_set_u8(h, KEY_USED, 0);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "保存 claim code 失败:%s", esp_err_to_name(err));
        return false;
    }
    return true;
}

bool claim_store_ensure(uint64_t seed, uint64_t now_ms, char *out) {
    char cur[CUP_CLAIM_BUF] = {0};
    uint64_t issued = 0;
    bool used = false;
    if (claim_store_load(cur, &issued, &used)) {
        // 旧码还有效 → 原样保留(用户可能刚抄下,别换掉)。
        if (!used && claim_code_fresh(issued, now_ms)) {
            if (out) {
                for (size_t i = 0; i < CUP_CLAIM_BUF; i++) {
                    out[i] = cur[i];
                    if (cur[i] == '\0') break;
                }
            }
            return false;
        }
    }
    char fresh_code[CUP_CLAIM_BUF];
    if (!claim_code_generate(seed, fresh_code, sizeof(fresh_code))) return false;
    if (!save_new(fresh_code, now_ms)) return false;
    if (out) {
        for (size_t i = 0; i < CUP_CLAIM_BUF; i++) {
            out[i] = fresh_code[i];
            if (fresh_code[i] == '\0') break;
        }
    }
    ESP_LOGI(TAG, "新发 claim code(24h 内有效,一次性)");
    return true;
}

bool claim_store_mark_used(void) {
    nvs_handle_t h;
    if (nvs_open(NS_NAME, NVS_READWRITE, &h) != ESP_OK) return false;
    esp_err_t err = nvs_set_u8(h, KEY_USED, 1);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "标记 claim code 已用失败:%s", esp_err_to_name(err));
        return false;
    }
    ESP_LOGI(TAG, "claim code 已标记为用过(不再接受)");
    return true;
}

void claim_bringup(uint64_t now_ms) {
    if (!claim_store_init()) {
        ESP_LOGW(TAG, "NVS 不可用,claim code 本次不可持久化");
        return;
    }
    // 种子拼两次 esp_random():RNG 给 32 位,凑 64 位减冲突。
    uint64_t seed = ((uint64_t)esp_random() << 32) | (uint64_t)esp_random();
    char code[CUP_CLAIM_BUF] = {0};
    bool fresh = claim_store_ensure(seed, now_ms, code);
    if (fresh) {
        // 首次配网/旧码作废 → 新发。用户看串口或 App 抄给绑定接口。
        ESP_LOGW(TAG, "设备绑定码(24h 内有效,一次性):%s —— 在 App 里输入以完成绑定", code);
    } else {
        ESP_LOGI(TAG, "沿用已有设备绑定码(未用且未过期),不重发");
    }
}
