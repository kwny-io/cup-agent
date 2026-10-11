/**
 * 杯盖 · 硬件脸显示薄壳(IDF 侧;把纯 C 的眼睛点阵推到 Memory LCD 面板)。
 *
 * ── 与纯 C 层的分工 ─────────────────────────────────────────────
 * 眼睛状态机(eye_state.c)与点阵渲染(eye_render.c)是**纯 C、零 IDF、可宿主单测**的;
 * 本文件只做**两件硬件相关的事**,故薄:
 *   1. 持有前后两帧 1bpp 缓冲,用 eye_render_dirty_rows 算出**脏行**;
 *   2. 把脏行(合并成连续段)推给面板 —— 只刷变了的那几行。
 *
 * ── 为什么是"只推脏行"──────────────────────────────────────────
 * 备忘 §2 选 Memory LCD 的唯一理由是"常亮 + 62 天续航":它**局部刷新才能省电**——
 * 整屏 128 行,一次眨眼只动眼区约 50 行,其余不刷就不耗电。故薄壳的核心不是"画",
 * 而是"算出该刷哪几行"。
 *
 * ── 面板接缝 ───────────────────────────────────────────────────
 * 真面板走 SPI(如 Sharp LS013B7DH03 一类 memory LCD 的 1bpp 协议)。本机**无面板、
 * 无 SPI 从设备**,故把"推一段行"抽成回调 `face_panel_write_fn`:真板到货时注册一个
 * 用 esp_lcd / spi_master 写的实现即可;未注册时默认实现只打日志(`[待实测]` 桩)。
 * 这与 led_driver / prov 的"IDF 薄壳 + 真板才真跑"同一取舍。
 *
 * 本机无 ESP-IDF,本文件仅做 shim 语法检查(见 README),非真编译。
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "eye_state.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * 面板推屏回调:把 [row_start, row_start+row_count) 连续行的 1bpp 位推到面板。
 * @param row_start  起始行(0..127)
 * @param row_count  行数(>=1)
 * @param packed     行优先、MSB 在前的 1bpp 位;指向整屏缓冲第 row_start 行首,
 *                   连续 row_count 行(每行 16 字节)有效
 */
typedef void (*face_panel_write_fn)(int row_start, int row_count, const uint8_t *packed);

/** 初始化(清缓冲、复位"首帧整刷"标志)。面板 SPI 初始化留给注册的回调。 */
bool face_display_init(void);

/** 注册真面板推屏实现;不注册则用内置日志桩(便于先跑通逻辑)。 */
void face_display_set_panel(face_panel_write_fn fn);

/**
 * 渲染一帧姿态并按**脏行**推屏。首帧整屏刷。
 * @param pose 本帧姿态(eye_state 产出)
 */
void face_display_show(const eye_pose_t *pose);

/** 累计推过的行数(诊断/日志;局部刷新的省电效果一眼可见)。 */
int face_display_rows_pushed(void);

#ifdef __cplusplus
}
#endif
