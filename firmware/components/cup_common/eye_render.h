/**
 * 硬件脸 · 眼睛点阵渲染器(纯 C,零 IDF 依赖)—— 可宿主单测。
 *
 * 把 eye_state 产出的**姿态**展开成 128×128 单色点阵。与
 * `apps/web/src/lib/eye-render.ts` 的 `renderEyeGrid` **逐字同构**(同几何、同画法)。
 *
 * ── 为什么要这层(备忘 §4.3)────────────────────────────────────
 * 屏幕预览、模拟器"假盖"、真固件三处共用**同一份**点阵逻辑,结果无歧义;
 * 拿到屏之前就能在 PC 上把动画调好、把边界(闭眼线宽、瞳孔挖空、蒸汽纹)钉死。
 *
 * ── 两种输出 ───────────────────────────────────────────────────
 *   eye_render_pixels()  : 每像素 1 字节(0/1),便于测试断言与屏幕预览;
 *   eye_render_pack()    : 打包成**1bpp**(行优先、MSB 在前)= Memory LCD 面板原格式,
 *                          整屏仅 2048 字节 —— 这正是"常亮 + 62 天续航"选 Memory LCD 的理由
 *                          (见备忘 §2 / 窗口 A 的前端功耗估算器)。
 *
 * 画法(与 web 一致):白眼窝(圆角超椭圆)填亮,瞳孔在其内**挖空**;
 * openness/squint → 上眼睑下压;gaze → 瞳孔在眼窝内平移;pupil_scale → 瞳孔缩放;
 * arc(content) → 两道向上弯的粗弧;sleep/nap → 横线;rotate → 整对眼绕中心旋转;
 * hot → 两眼上方各飘三道蒸汽纹(局部小片移动像素,反射屏只刷这一小带)。
 */
#pragma once

#include <stdint.h>
#include <stdbool.h>
#include "eye_state.h"

#ifdef __cplusplus
extern "C" {
#endif

#define EYE_RENDER_W 128
#define EYE_RENDER_H 128
/** 每像素 1 字节缓冲的字节数(测试/预览用)。 */
#define EYE_RENDER_PIXELS (EYE_RENDER_W * EYE_RENDER_H)
/** 1bpp 打包后的字节数(128*128/8 = 2048)= Memory LCD 整屏。 */
#define EYE_RENDER_PACKED (EYE_RENDER_W * EYE_RENDER_H / 8)
/** 一帧最多分几段脏行(隔行全脏 = W/2 + 1,由 eye_render_dirty_spans 定上界)。 */
#define EYE_RENDER_MAX_SPANS ((EYE_RENDER_H) / 2 + 1)

/**
 * 渲染一帧姿态 → 每像素 1 字节(1=亮,0=灭),行优先,index = y*W + x。
 * @param pose 姿态(见 eye_state.h)
 * @param buf  至少 EYE_RENDER_PIXELS 字节;函数内会先清零
 */
void eye_render_pixels(const eye_pose_t *pose, uint8_t *buf);

/**
 * 渲染并打包成 1bpp(行优先、每字节 MSB 对应最左像素)—— 面板直接可写的格式。
 * @param pose   姿态
 * @param packed 至少 EYE_RENDER_PACKED 字节;函数内会先清零
 */
void eye_render_pack(const eye_pose_t *pose, uint8_t *packed);

/** 亮像素数(测试断言便捷口)。 */
int eye_render_lit_count(const uint8_t *buf);

/** 某像素是否亮;越界返回 false。 */
bool eye_render_get(const uint8_t *buf, int x, int y);

/**
 * 比较两帧 1bpp 打包缓冲,逐行标记哪些行**有变化**(供 Memory LCD 局部刷新)。
 *
 * 为什么单独一个函数:Memory LCD 省电的关键不是"画得少",而是"只刷变了的那几行"——
 * 整屏 128 行、每行 16 字节;一次眨眼只动眼睛那 ~50 行,其余行不刷就不耗电。
 * 这层留在纯 C 里(可宿主单测),IDF 薄壳只负责把标了脏的行推给面板。
 *
 * @param prev      上一帧(1bpp,EYE_RENDER_PACKED 字节)
 * @param cur       本帧(同格式)
 * @param row_dirty 输出:EYE_RENDER_H 个 bool,true=该行与上帧不同;可为 NULL
 * @return 脏行数(0 = 两帧完全相同,整屏无需刷新)
 */
int eye_render_dirty_rows(const uint8_t *prev, const uint8_t *cur, bool *row_dirty);

/**
 * 把逐行脏标记**合并成连续段** —— 面板一次写一段连续行,故"首尾各脏一行"要推两次
 * (而非刷整屏)。段以升序、互不相邻返回。
 *
 * 为什么这层也在纯 C:它是"只刷脏行"的**决策核心**(段数/边界/末行),IDF 薄壳应只管
 * 循着段调用面板回调 —— 放这里才能在 PC 上把边界(首行脏、末行脏、隔行脏)钉死。
 *
 * @param row_dirty  逐行脏标记(EYE_RENDER_H 个)
 * @param out_start  输出:每段起始行;容量 >= EYE_RENDER_MAX_SPANS
 * @param out_count  输出:每段行数;容量同上
 * @return 段数(0 = 无脏行 = 整屏无需刷新)
 */
int eye_render_dirty_spans(const bool *row_dirty, int *out_start, int *out_count);

#ifdef __cplusplus
}
#endif
