/**
 * 底座 · 称重换算层实现 —— 常量与约定见 weight_convert.h。
 * 24 位补码扩展 + 零点/灵敏度换算,零 IDF,故可宿主单测。
 */
#include "weight_convert.h"

int32_t hx711_signed_24(uint32_t raw24) {
    raw24 &= 0xFFFFFFu;                 // 只取低 24 位
    if (raw24 & 0x800000u) {            // 最高位为 1 → 负数,补高位
        return (int32_t)(raw24 | 0xFF000000u);
    }
    return (int32_t)raw24;
}

hx711_status_t hx711_power_status(uint32_t raw24) {
    raw24 &= 0xFFFFFFu;
    if (raw24 == HX711_RAW_POWER_ON) return HX711_POWER_ON;
    if (raw24 == HX711_RAW_POWER_OFF) return HX711_POWER_OFF;
    return HX711_OK;
}

float hx711_apply_scale(int32_t count, int32_t zero_count, float counts_per_g) {
    if (counts_per_g <= 0.0f) return 0.0f;   // 未标定:不猜
    return (float)(count - zero_count) / counts_per_g;
}
