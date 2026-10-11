/**
 * 硬件脸 · 眼睛点阵渲染器实现(纯 C)。见 eye_render.h。
 * 与 apps/web/src/lib/eye-render.ts 的 renderEyeGrid 逐字同构。
 */
#include "eye_render.h"
#include <math.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// ── 几何(128px 空间;与 web 同名同值,拿到真屏后按物理尺寸微调)──────
#define CX_L 41.0f          /**< 左眼中心 x */
#define CX_R 87.0f          /**< 右眼中心 x */
#define CY   64.0f          /**< 眼中心 y */
#define EW   19.0f          /**< 眼窝半宽 */
#define EH   26.0f          /**< 眼窝半高 */
#define PR   9.0f           /**< 瞳孔基准半径 */
#define STROKE 5.0f         /**< 描边/线宽(px) */
#define RECT_EXP 2.6f       /**< 圆角矩形指数(2=椭圆;2.6 得"圆角矩形眼白") */

static inline float clampf_local(float v, float lo, float hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

/** 超椭圆内部判定:|dx/a|^n + |dy/b|^n <= 1 */
static bool in_superellipse(float dx, float dy, float a, float b, float n) {
    if (a <= 0.0f || b <= 0.0f) return false;
    return powf(fabsf(dx) / a, n) + powf(fabsf(dy) / b, n) <= 1.0f;
}

/** 一道横线(闭眼):绕画面中心旋转 rot。 */
static void draw_line(uint8_t *buf, float cx, float cy, float half_w, float th,
                      float cos_r, float sin_r, float mid_x, float mid_y) {
    float half_t = th / 2.0f;
    for (int y = 0; y < EYE_RENDER_H; y++) {
        for (int x = 0; x < EYE_RENDER_W; x++) {
            float dxr = (float)x - mid_x;
            float dyr = (float)y - mid_y;
            // 逆旋转到"未旋转"坐标系
            float ux = dxr * cos_r - dyr * sin_r + mid_x;
            float uy = dxr * sin_r + dyr * cos_r + mid_y;
            if (fabsf(ux - cx) <= half_w && fabsf(uy - cy) <= half_t)
                buf[y * EYE_RENDER_W + x] = 1;
        }
    }
}

/** 一道向上弯的弧(content:眼睛弯成两道弧)。 */
static void draw_arc(uint8_t *buf, float cx, float cy, float half_w,
                     float cos_r, float sin_r, float mid_x, float mid_y) {
    float half_t = STROKE / 2.0f;
    float curve = 0.55f;
    for (int y = 0; y < EYE_RENDER_H; y++) {
        for (int x = 0; x < EYE_RENDER_W; x++) {
            float dxr = (float)x - mid_x;
            float dyr = (float)y - mid_y;
            float ux = dxr * cos_r - dyr * sin_r + mid_x;
            float uy = dxr * sin_r + dyr * cos_r + mid_y;
            float t = (ux - cx) / half_w;     // -1..1
            if (t < -1.0f || t > 1.0f) continue;
            // 向上弯:两端下垂、中间上拱
            float ty = cy + half_w * curve * (t * t) - half_w * curve * 0.5f;
            if (fabsf(uy - ty) <= half_t) buf[y * EYE_RENDER_W + x] = 1;
        }
    }
}

/** 蒸汽纹:每只眼窝上沿飘一道正弦上下摆动的短竖纹(单色屏表达"烫")。 */
static void draw_steam(uint8_t *buf, float phase) {
    for (int eye = 0; eye < 2; eye++) {
        float cx = (eye == 0) ? CX_L : CX_R;
        for (int s = 0; s < 3; s++) {
            for (int y = 0; y < 10; y++) {
                float wy = CY - EH - 14.0f + (float)y;
                if (wy < 0.0f) continue;
                int wx = (int)lroundf(cx + sinf(phase * 1.7f + (float)s * 2.1f + (float)y * 0.9f) * 3.0f);
                if (wx >= 0 && wx < EYE_RENDER_W)
                    buf[(int)wy * EYE_RENDER_W + wx] = 1;
            }
        }
    }
}

void eye_render_pixels(const eye_pose_t *pose, uint8_t *buf) {
    memset(buf, 0, EYE_RENDER_PIXELS);

    float rot = pose->rotate;
    float c = cosf(-rot);
    float s = sinf(-rot);
    float mid_x = EYE_RENDER_W / 2.0f;
    float mid_y = EYE_RENDER_H / 2.0f;
    float drop = pose->drop_y * EH;

    for (int eye = 0; eye < 2; eye++) {
        float cxe = (eye == 0) ? CX_L : CX_R;
        float cye = CY + drop;

        if (pose->state == EYE_SLEEP || pose->state == EYE_NAP) {
            // 睡觉 2px 静线;打盹 4px + 呼吸位移(drop_y 已含缓慢位移)
            float th = (pose->state == EYE_NAP) ? STROKE : 2.0f;
            draw_line(buf, cxe, cye, EW - 1.0f, th, c, s, mid_x, mid_y);
            continue;
        }
        if (pose->arc) {
            draw_arc(buf, cxe, cye, EW, c, s, mid_x, mid_y);
            continue;
        }

        // 眼窝:固定尺寸的圆角矩形(不随开度缩);上眼睑从上沿下压
        float socket_top = cye - EH;
        float socket_bot = cye + EH;
        float closed = 1.0f - fminf(pose->openness, 1.0f);
        float lid_y = socket_top + closed * (2.0f * EH) + pose->squint * EH * 0.6f;

        // 全闭:直接画一条横线(比"零厚度弧"更像闭上的眼)
        if (socket_bot - lid_y < 2.5f) {
            draw_line(buf, cxe, cye, EW - 1.0f, 3.0f, c, s, mid_x, mid_y);
            continue;
        }

        float pr = PR * pose->pupil_scale;
        // 瞳孔中心:随 gaze 平移到眼窝内缘;再夹进"可见带"里,别被眼睑切一半
        float px = cxe + pose->gaze_x * fmaxf(0.0f, EW - pr);
        float py = cye + pose->gaze_y * fmaxf(0.0f, EH - pr);
        float py_lo = lid_y + pr;
        float py_hi = socket_bot - pr;
        py = (py_hi >= py_lo) ? clampf_local(py, py_lo, py_hi) : (py_lo + py_hi) / 2.0f;

        for (int y = 0; y < EYE_RENDER_H; y++) {
            for (int x = 0; x < EYE_RENDER_W; x++) {
                float dxr = (float)x - mid_x;
                float dyr = (float)y - mid_y;
                float ux = dxr * c - dyr * s + mid_x;
                float uy = dxr * s + dyr * c + mid_y;

                if (uy < lid_y) continue; // 上眼睑遮住的部分
                if (!in_superellipse(ux - cxe, uy - cye, EW, EH, RECT_EXP)) continue;
                // 眼窝内:亮;若落在瞳孔内则挖空(单色下瞳孔=黑洞)
                float ddx = ux - px;
                float ddy = uy - py;
                bool in_pupil = (ddx * ddx + ddy * ddy) <= (pr * pr);
                buf[y * EYE_RENDER_W + x] = in_pupil ? 0 : 1;
            }
        }
    }
    if (pose->hot) draw_steam(buf, pose->steam_phase);
}

void eye_render_pack(const eye_pose_t *pose, uint8_t *packed) {
    static uint8_t pixels[EYE_RENDER_PIXELS]; // 静态复用以省栈(真板栈小)
    eye_render_pixels(pose, pixels);
    memset(packed, 0, EYE_RENDER_PACKED);
    for (int i = 0; i < EYE_RENDER_PIXELS; i++) {
        if (pixels[i])
            packed[i >> 3] |= (uint8_t)(0x80u >> (i & 7)); // 行优先、MSB 在前
    }
}

bool eye_render_get(const uint8_t *buf, int x, int y) {
    if (x < 0 || x >= EYE_RENDER_W || y < 0 || y >= EYE_RENDER_H) return false;
    return buf[y * EYE_RENDER_W + x] != 0;
}

int eye_render_lit_count(const uint8_t *buf) {
    int n = 0;
    for (int i = 0; i < EYE_RENDER_PIXELS; i++) if (buf[i]) n++;
    return n;
}

int eye_render_dirty_rows(const uint8_t *prev, const uint8_t *cur, bool *row_dirty) {
    const int bytes_per_row = EYE_RENDER_W / 8; // 16
    int dirty = 0;
    for (int y = 0; y < EYE_RENDER_H; y++) {
        const uint8_t *p = prev + y * bytes_per_row;
        const uint8_t *c = cur + y * bytes_per_row;
        bool changed = false;
        for (int b = 0; b < bytes_per_row; b++) {
            if (p[b] != c[b]) { changed = true; break; }
        }
        if (row_dirty) row_dirty[y] = changed;
        if (changed) dirty++;
    }
    return dirty;
}

int eye_render_dirty_spans(const bool *row_dirty, int *out_start, int *out_count) {
    int n = 0;
    int y = 0;
    while (y < EYE_RENDER_H) {
        if (!row_dirty[y]) { y++; continue; }
        int start = y;
        while (y < EYE_RENDER_H && row_dirty[y]) y++;
        if (out_start) out_start[n] = start;
        if (out_count) out_count[n] = y - start;
        n++;
    }
    return n;
}
