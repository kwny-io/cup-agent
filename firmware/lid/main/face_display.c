/**
 * 杯盖 · 硬件脸显示薄壳实现(IDF 侧)。见 face_display.h。
 */
#include "face_display.h"

#include <string.h>

#include "esp_log.h"

#include "eye_render.h"

static const char *TAG = "face";

/** 前后两帧 1bpp(整屏 2048 字节 ×2;静态,不占栈)。 */
static uint8_t s_prev[EYE_RENDER_PACKED];
static uint8_t s_cur[EYE_RENDER_PACKED];
static bool s_have_prev = false;    // 首帧无上帧 → 整屏刷
static int  s_rows_pushed = 0;

/** 默认面板桩:无真面板时只记一行日志(便于先在裸板跑通逻辑)。 */
static void log_panel_write(int row_start, int row_count, const uint8_t *packed) {
    (void)packed;
    ESP_LOGD(TAG, "panel 刷行 [%d,%d) 共 %d 行", row_start, row_start + row_count, row_count);
}

static face_panel_write_fn s_panel = log_panel_write;

bool face_display_init(void) {
    memset(s_prev, 0, sizeof(s_prev));
    memset(s_cur, 0, sizeof(s_cur));
    s_have_prev = false;
    s_rows_pushed = 0;
    s_panel = log_panel_write;
    // 真面板的 SPI/GPIO 初始化在注册了 s_panel 之后由调用方做(或回调内部首调时做)。
    return true;
}

void face_display_set_panel(face_panel_write_fn fn) {
    if (fn) s_panel = fn;
}

void face_display_show(const eye_pose_t *pose) {
    if (!pose) return;
    eye_render_pack(pose, s_cur);

    if (!s_have_prev) {
        // 首帧整屏刷一次(面板上电是随机的,得先把整幅画上去)
        s_panel(0, EYE_RENDER_H, s_cur);
        s_rows_pushed += EYE_RENDER_H;
        s_have_prev = true;
    } else {
        static bool dirty[EYE_RENDER_H];
        static int span_start[EYE_RENDER_MAX_SPANS];
        static int span_count[EYE_RENDER_MAX_SPANS];
        // 脏行 → 连续段(纯 C,已宿主单测);本壳只循段推面板。
        int nd = eye_render_dirty_rows(s_prev, s_cur, dirty);
        if (nd > 0) {
            int nseg = eye_render_dirty_spans(dirty, span_start, span_count);
            for (int i = 0; i < nseg; i++) {
                int start = span_start[i], count = span_count[i];
                s_panel(start, count, s_cur + start * (EYE_RENDER_W / 8));
                s_rows_pushed += count;
            }
        }
        // 本帧加载:
        // 静止画面(nd==0)→ 一行都不刷,面板保持显像、CPU 睡觉 —— 这正是 Memory LCD 省电之处。
    }

    memcpy(s_prev, s_cur, EYE_RENDER_PACKED);
}

int face_display_rows_pushed(void) { return s_rows_pushed; }
