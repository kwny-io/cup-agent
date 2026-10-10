/**
 * 杯盖 · 板载 LED 驱动实现(IDF 薄壳)。见 led_driver.h。
 */
#include "led_driver.h"

#include <inttypes.h>

#include "driver/ledc.h"
#include "esp_log.h"

static const char *TAG = "led_driver";

// LEDC 通道/定时器(单灯,用 0 号即可)。
#define LEDC_CH LEDC_CHANNEL_0
#define LEDC_TMR LEDC_TIMER_0
#define LEDC_MODE LEDC_LOW_SPEED_MODE
#define DUTY_MAX ((1 << LED_DRIVER_RES_BITS) - 1)

// 当前灯效状态(单灯,单实例 → 静态即可)。
static led_pattern_t s_pat;
static bool s_active;
static uint32_t s_start_ms;   // 本条灯效开始时刻
static bool s_on;             // 闪烁当前相位(亮=1)

static void set_duty(uint32_t duty) {
    ledc_set_duty(LEDC_MODE, LEDC_CH, duty);
    ledc_update_duty(LEDC_MODE, LEDC_CH);
}

bool led_driver_init(void) {
    ledc_timer_config_t tcfg = {
        .speed_mode = LEDC_MODE,
        .timer_num = LEDC_TMR,
        .duty_resolution = LED_DRIVER_RES_BITS,
        .freq_hz = LED_DRIVER_PWM_HZ,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    if (ledc_timer_config(&tcfg) != ESP_OK) {
        ESP_LOGE(TAG, "ledc_timer_config 失败");
        return false;
    }
    ledc_channel_config_t ccfg = {
        .gpio_num = CUP_LED_GPIO,
        .speed_mode = LEDC_MODE,
        .channel = LEDC_CH,
        .timer_sel = LEDC_TMR,
        .duty = 0,
        .hpoint = 0,
    };
    if (ledc_channel_config(&ccfg) != ESP_OK) {
        ESP_LOGE(TAG, "ledc_channel_config 失败");
        return false;
    }
    s_active = false;
    return true;
}

void led_driver_off(void) {
    s_active = false;
    s_on = false;
    set_duty(0);
}

void led_driver_play(const led_pattern_t *p) {
    if (!p || p->effect == LED_OFF) {
        led_driver_off();
        return;
    }
    s_pat = *p;
    s_active = true;
    s_start_ms = 0;   // tick 第一次进来时用其 now_ms 起算
    s_on = true;
    // 常亮直接满占空;其余首帧由 tick 定。
    if (p->effect == LED_SOLID) set_duty(DUTY_MAX);
    ESP_LOGI(TAG, "play %s (color=%s period=%" PRIu32 "ms count=%d)", led_effect_str(p->effect),
             led_color_str(p->color), p->period_ms, p->count);
}

bool led_driver_active(void) { return s_active; }

void led_driver_tick(uint32_t now_ms) {
    if (!s_active) return;
    if (s_start_ms == 0) s_start_ms = now_ms;   // 第一条 tick 起算
    uint32_t el = now_ms - s_start_ms;
    uint32_t period = s_pat.period_ms ? s_pat.period_ms : LED_DEFAULT_PERIOD_MS;

    switch (s_pat.effect) {
        case LED_SOLID:
            // 已在 play 里点亮,无需每帧重复写。
            break;

        case LED_BLINK: {
            uint32_t total = period * (uint32_t)s_pat.count;
            if (el >= total) {          // 闪完 → 自动灭
                led_driver_off();
                break;
            }
            bool on = ((el / period) % 2u) == 0u;   // 前半亮、后半灭
            if (on != s_on) {
                s_on = on;
                set_duty(on ? DUTY_MAX : 0);
            }
            break;
        }

        case LED_BREATH: {
            uint32_t total = period * (uint32_t)s_pat.count;
            if (el >= total) {
                led_driver_off();
                break;
            }
            // 三角波:一个周期内 0→满→0
            uint32_t ph = el % period;                   // [0,period)
            uint32_t half = period / 2u;
            uint32_t up = (ph < half) ? ph : (period - ph);   // 0..half
            set_duty(half ? (up * DUTY_MAX / half) : DUTY_MAX);
            break;
        }

        case LED_OFF:
        default:
            led_driver_off();
            break;
    }
}
