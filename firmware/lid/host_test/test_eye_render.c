/**
 * 宿主单测 —— 硬件脸点阵渲染器(eye_render.c)。零 IDF,mingw gcc 直接编译。
 *
 * 覆盖:空姿态/睁眼有像素、闭眼是横线(中段亮、高度小)、瞳孔挖空(眼窝中心灭)、
 * 弧眼(content)、倾斜旋转、蒸汽带(仅 hot 时亮、随相位移动)、1bpp 打包字节数
 * 与像素一致、几何边界(越界安全)。与 apps/web eye-render.ts 同口径。
 */
#include "eye_render.h"

#include <stdio.h>
#include <string.h>

static int g_fail = 0, g_total = 0;
static void ok(int cond, const char *what) {
    g_total++;
    if (!cond) { g_fail++; printf("  ✗ %s\n", what); }
    else printf("  ✓ %s\n", what);
}

/** 亮像素的 y 范围(用于判断"闭眼是矮横线")。 */
static void y_range(const uint8_t *buf, int *lo, int *hi) {
    *lo = EYE_RENDER_H; *hi = -1;
    for (int y = 0; y < EYE_RENDER_H; y++)
        for (int x = 0; x < EYE_RENDER_W; x++)
            if (buf[y * EYE_RENDER_W + x]) { if (y < *lo) *lo = y; if (y > *hi) *hi = y; }
}

/** 指定 x 列上最靠上的亮像素 y;无亮返回 EYE_RENDER_H。 */
static int topmost_lit_at(const uint8_t *buf, int x) {
    for (int y = 0; y < EYE_RENDER_H; y++)
        if (buf[y * EYE_RENDER_W + x]) return y;
    return EYE_RENDER_H;
}

/** 蒸汽带(y < 38)的亮像素数。 */
static int steam_band_lit(const uint8_t *buf) {
    int n = 0;
    for (int y = 0; y < 38; y++)
        for (int x = 0; x < EYE_RENDER_W; x++)
            if (buf[y * EYE_RENDER_W + x]) n++;
    return n;
}

static eye_pose_t base_pose(void) {
    eye_pose_t p;
    memset(&p, 0, sizeof(p));
    p.state = EYE_IDLE;
    p.openness = 1.0f;
    p.pupil_scale = 1.0f;
    return p;
}

static void test_lit_and_empty(void) {
    printf("[睁眼有像素 / 全闭眼小于睁眼]\n");
    static uint8_t buf[EYE_RENDER_PIXELS];
    eye_pose_t open = base_pose();
    eye_render_pixels(&open, buf);
    int lit_open = eye_render_lit_count(buf);
    ok(lit_open > 100, "睁眼有足量眼白像素");

    eye_pose_t shut = base_pose();
    shut.openness = 0.0f;
    eye_render_pixels(&shut, buf);
    int lit_shut = eye_render_lit_count(buf);
    ok(lit_shut > 0, "闭眼仍有横线像素");
    ok(lit_shut < lit_open, "闭眼像素明显少于睁眼");
}

static void test_closed_is_line(void) {
    printf("[闭眼是两条矮横线]\n");
    static uint8_t buf[EYE_RENDER_PIXELS];
    eye_pose_t shut = base_pose();
    shut.openness = 0.0f;
    eye_render_pixels(&shut, buf);
    int lo, hi;
    y_range(buf, &lo, &hi);
    ok((hi - lo) < 16, "闭眼亮带高度很小(<16px)");
    // 眼中心附近应有亮像素
    ok(eye_render_get(buf, 41, 64) || eye_render_get(buf, 41, 65), "左眼中线有亮线");
}

static void test_pupil_hole(void) {
    printf("[瞳孔挖空:眼窝中心是黑洞]\n");
    static uint8_t buf[EYE_RENDER_PIXELS];
    eye_pose_t open = base_pose();
    eye_render_pixels(&open, buf);
    // 瞳孔中心(左右眼正心)应为灭(挖空)
    ok(!eye_render_get(buf, 41, 64), "左眼瞳孔中心灭(挖空)");
    ok(!eye_render_get(buf, 87, 64), "右眼瞳孔中心灭(挖空)");
    // 眼窝外缘(瞳孔外、眼白内)应亮
    ok(eye_render_get(buf, 41, 64 - 18), "眼白上缘亮");
}

static void test_arc(void) {
    printf("[弧眼(content):中段上拱、两端下垂]\n");
    static uint8_t buf[EYE_RENDER_PIXELS];
    eye_pose_t arc = base_pose();
    arc.state = EYE_CONTENT;
    arc.arc = true;
    arc.openness = 0.92f;
    eye_render_pixels(&arc, buf);
    ok(eye_render_lit_count(buf) > 50, "弧眼有像素");
    // 左眼弧:横跨 cx±EW(41±19)。中段(41)应比两端(25 / 57)更靠上
    int y_mid = topmost_lit_at(buf, 41);
    int y_l = topmost_lit_at(buf, 25);
    int y_r = topmost_lit_at(buf, 57);
    ok(y_mid < y_l, "弧中段比左端高(向上弯)");
    ok(y_mid < y_r, "弧中段比右端高(向上弯)");
}

static void test_rotate(void) {
    printf("[倾斜:整眼绕中心旋转]\n");
    static uint8_t u[EYE_RENDER_PIXELS], r[EYE_RENDER_PIXELS];
    eye_pose_t flat = base_pose();
    eye_render_pixels(&flat, u);
    eye_pose_t rot = base_pose();
    rot.rotate = 0.3f;
    eye_render_pixels(&rot, r);
    ok(eye_render_lit_count(r) > 0, "旋转后仍有像素");
    int diff = 0;
    for (int i = 0; i < EYE_RENDER_PIXELS; i++) if ((u[i] != 0) != (r[i] != 0)) diff++;
    ok(diff > 50, "旋转确实改变了点阵(与未旋转不同)");
}

static void test_steam(void) {
    printf("[水烫蒸汽带:仅 hot 时亮,且随时间移动]\n");
    static uint8_t a[EYE_RENDER_PIXELS], b[EYE_RENDER_PIXELS];
    eye_pose_t cold = base_pose();
    eye_render_pixels(&cold, a);
    ok(steam_band_lit(a) == 0, "常温:蒸汽带 0 像素");

    eye_pose_t hot = base_pose();
    hot.hot = true;
    hot.steam_phase = 0.0f;
    eye_render_pixels(&hot, b);
    int s0 = steam_band_lit(b);
    ok(s0 > 0, "烫:蒸汽带出现像素");

    hot.steam_phase = 1.0f;
    eye_render_pixels(&hot, b);
    ok(steam_band_lit(b) > 0, "烫:相位推进后仍有像素");

    // 两张不同相位的蒸汽带应不同(证明"飘动")
    static uint8_t pa[EYE_RENDER_PIXELS], pb[EYE_RENDER_PIXELS];
    eye_pose_t hotA = base_pose(); hotA.hot = true; hotA.steam_phase = 0.0f;
    eye_pose_t hotB = base_pose(); hotB.hot = true; hotB.steam_phase = 1.0f;
    eye_render_pixels(&hotA, pa);
    eye_render_pixels(&hotB, pb);
    int moved = 0;
    for (int y = 0; y < 38; y++)
        for (int x = 0; x < EYE_RENDER_W; x++)
            if ((pa[y * EYE_RENDER_W + x] != 0) != (pb[y * EYE_RENDER_W + x] != 0)) moved++;
    ok(moved > 0, "蒸汽随相位移动(不同相位点阵不同)");
}

static void test_pack(void) {
    printf("[1bpp 打包:字节数正确,且与像素一致]\n");
    static uint8_t px[EYE_RENDER_PIXELS];
    static uint8_t pk[EYE_RENDER_PACKED];
    eye_pose_t open = base_pose();
    eye_render_pack(&open, pk);
    eye_render_pixels(&open, px);

    ok(EYE_RENDER_PACKED == 2048, "打包字节数 = 2048(整屏)");

    // 逐像素核对:packed 的第 i 位 = pixels[i]
    int mism = 0;
    for (int i = 0; i < EYE_RENDER_PIXELS; i++) {
        int bit = (pk[i >> 3] >> (7 - (i & 7))) & 1;
        if (bit != (px[i] ? 1 : 0)) mism++;
    }
    ok(mism == 0, "每一位与像素缓冲逐一对应(MSB 在前)");
}

static void test_bounds(void) {
    printf("[几何边界:越界安全]\n");
    static uint8_t buf[EYE_RENDER_PIXELS];
    eye_pose_t open = base_pose();
    eye_render_pixels(&open, buf);
    ok(!eye_render_get(buf, -1, 5), "x<0 → false");
    ok(!eye_render_get(buf, EYE_RENDER_W, 5), "x 越界 → false");
    ok(!eye_render_get(buf, 5, -1), "y<0 → false");
    ok(!eye_render_get(buf, 5, EYE_RENDER_H), "y 越界 → false");
}

static void test_dirty_rows(void) {
    printf("[局部刷新:逐行脏标记 = Memory LCD 省电核心]\n");
    static uint8_t a[EYE_RENDER_PACKED], b[EYE_RENDER_PACKED];
    static bool dirty[EYE_RENDER_H];
    eye_pose_t open = base_pose();
    eye_render_pack(&open, a);

    // 1. 同一帧 → 0 脏行(整屏无需刷新)
    eye_render_pack(&open, b);
    ok(eye_render_dirty_rows(a, b, dirty) == 0, "两帧相同 → 0 脏行");
    int any = 0; for (int y = 0; y < EYE_RENDER_H; y++) if (dirty[y]) any = 1;
    ok(!any, "两帧相同 → 无行被标脏");

    // 2. 眨眼(开度变)→ 只有眼睛附近的行脏,非整屏
    eye_pose_t shut = base_pose();
    shut.openness = 0.0f;
    eye_render_pack(&shut, b);
    int nd = eye_render_dirty_rows(a, b, dirty);
    ok(nd > 0, "开→闭 → 有脏行");
    ok(nd < EYE_RENDER_H, "但非整屏脏(仅眼区那几行)");
    // 顶部若干行应干净(眼睛在 y≈38..90,顶部没内容)
    ok(!dirty[0] && !dirty[EYE_RENDER_H - 1], "最顶/最底行干净");

    // 3. row_dirty 可传 NULL(只要计数)
    ok(eye_render_dirty_rows(a, b, NULL) == nd, "row_dirty=NULL 仍返回相同计数");
}

static void test_dirty_spans(void) {
    printf("[脏行→连续段:合并决策(纯 C,边界钉死)]\n");
    static bool dirty[EYE_RENDER_H];
    static int st[EYE_RENDER_MAX_SPANS], ct[EYE_RENDER_MAX_SPANS];

    // 全净 → 0 段
    for (int y = 0; y < EYE_RENDER_H; y++) dirty[y] = false;
    ok(eye_render_dirty_spans(dirty, st, ct) == 0, "全净 → 0 段");

    // 单个连续带 [10,20) → 1 段 (start=10,count=10)
    for (int y = 0; y < EYE_RENDER_H; y++) dirty[y] = (y >= 10 && y < 20);
    int n = eye_render_dirty_spans(dirty, st, ct);
    ok(n == 1 && st[0] == 10 && ct[0] == 10, "连续带 → 1 段(起/长对)");

    // 两条分离带 [5,8) 与 [100,104) → 2 段(而非刷整屏)
    for (int y = 0; y < EYE_RENDER_H; y++)
        dirty[y] = (y >= 5 && y < 8) || (y >= 100 && y < 104);
    n = eye_render_dirty_spans(dirty, st, ct);
    ok(n == 2, "两条分离带 → 2 段");
    ok(st[0] == 5 && ct[0] == 3 && st[1] == 100 && ct[1] == 4, "两段起/长对");

    // 首行脏 → 段从 0 起
    for (int y = 0; y < EYE_RENDER_H; y++) dirty[y] = (y < 3);
    n = eye_render_dirty_spans(dirty, st, ct);
    ok(n == 1 && st[0] == 0 && ct[0] == 3, "首行脏 → 段起 0");

    // 末行脏 → 段抵达最后一行(边界不越界)
    for (int y = 0; y < EYE_RENDER_H; y++) dirty[y] = (y >= EYE_RENDER_H - 2);
    n = eye_render_dirty_spans(dirty, st, ct);
    ok(n == 1 && st[0] == EYE_RENDER_H - 2 && ct[0] == 2, "末行脏 → 段含末行");

    // 隔行全脏 → 最坏情况:段数 = W/2,容量够(不溢出)
    int singles = 0;
    for (int y = 0; y < EYE_RENDER_H; y++) { dirty[y] = (y % 2 == 0); if (dirty[y]) singles++; }
    n = eye_render_dirty_spans(dirty, st, ct);
    ok(n == singles && n <= EYE_RENDER_MAX_SPANS, "隔行脏 → 段数 = 单行数,且 ≤ 容量");
}

int main(void) {
    printf("== eye_render 硬件脸点阵渲染 宿主单测 ==\n");
    test_lit_and_empty();
    test_closed_is_line();
    test_pupil_hole();
    test_arc();
    test_rotate();
    test_steam();
    test_pack();
    test_bounds();
    test_dirty_rows();
    test_dirty_spans();
    printf("\n== %d/%d 通过,%d 失败 ==\n", g_total - g_fail, g_total, g_fail);
    return g_fail == 0 ? 0 : 1;
}
