/**
 * 眼睛点阵渲染器 —— 把 eyes.ts 的**姿态**展开成 128×128 单色点阵(创意备忘 §3/§4.3)。
 *
 * 为什么是纯函数返回像素缓冲(而不是直接画 canvas):
 *   1. 屏幕预览、模拟器"假盖"、将来固件三方用**同一份**点阵逻辑,无歧义;
 *   2. 无 DOM 也能单测(本仓 web 无 jsdom)—— 断言"某像素亮/灭"即可;
 *   3. 备忘 §4.3:"在拿到屏之前就把动画调好"。
 *
 * 设计(128×128,黑底白线,1=亮):
 *   · 白眼窝(圆角超椭圆)填亮,瞳孔在其内**挖空** → 单色下仍是一只好认的眼睛
 *   · openness/squint → 上眼睑下压(遮住顶部像素)
 *   · gaze → 瞳孔在眼窝内平移;pupilScale → 瞳孔缩放
 *   · arc(content) → 换成两道向上弯的粗弧(^^)
 *   · sleep/nap → 两道横线(nap 更粗 + 缓慢呼吸位移)
 *   · rotate → 整对眼绕中心旋转
 *   · hot(加分项)→ 两眼上方各飘三道蒸汽纹(局部小片移动像素,反射屏只刷这一小带)
 */

import type { EyePose } from './eyes.ts';

export const EYE_W = 128;
export const EYE_H = 128;

// ── 几何(128px 空间;均可在拿到真屏后按物理尺寸微调)────────────
/** 两眼中心 x 与 y */
const CX_L = 41;
const CX_R = 87;
const CY = 64;
/** 眼窝半宽 / 半高 */
const EW = 19;
const EH = 26;
/** 瞳孔基准半径 */
const PR = 9;
/** 描边/线宽(px) */
const STROKE = 5;
/** 圆角矩形指数(2=椭圆,越大越方;取 2.6 得"圆角矩形眼白") */
const RECT_EXP = 2.6;

/** 超椭圆内部判定:|dx/a|^n + |dy/b|^n <= 1 */
function inSuperellipse(dx: number, dy: number, a: number, b: number, n: number): boolean {
  if (a <= 0 || b <= 0) return false;
  return Math.pow(Math.abs(dx) / a, n) + Math.pow(Math.abs(dy) / b, n) <= 1;
}

/**
 * 渲染一帧姿态 → 128×128 缓冲(1=亮,0=灭)。行优先,index = y*128 + x。
 */
export function renderEyeGrid(pose: EyePose): Uint8Array {
  const buf = new Uint8Array(EYE_W * EYE_H);

  // 整对眼绕画面中心旋转(倾斜跟随)
  const rot = pose.rotate;
  const cos = Math.cos(-rot);
  const sin = Math.sin(-rot);
  const midX = EYE_W / 2;
  const midY = EYE_H / 2;
  const drop = pose.dropY * EH;

  for (const cx0 of [CX_L, CX_R]) {
    const cxe = cx0;
    const cye = CY + drop;

    if (pose.state === 'sleep' || pose.state === 'nap') {
      // 睡觉 2px 静线;打盹 4px + 呼吸位移(dropY 已含缓慢位移)
      const th = pose.state === 'nap' ? STROKE : 2;
      drawLine(buf, cxe, cye, EW - 1, th, cos, sin, midX, midY);
      continue;
    }
    if (pose.arc) {
      drawArc(buf, cxe, cye, EW, cos, sin, midX, midY);
      continue;
    }

    // 眼窝:固定尺寸的圆角矩形(不随开度缩);上眼睑从上沿下压
    const socketTop = cye - EH;
    const socketBot = cye + EH;
    // openness=1 → 睑在上沿(全开);=0 → 压到下沿(全闭);squint 再补压一点
    const closed = 1 - Math.min(pose.openness, 1);
    const lidY = socketTop + closed * (2 * EH) + pose.squint * EH * 0.6;

    // 全闭:直接画一条横线(比"零厚度弧"更像闭上的眼)
    if (socketBot - lidY < 2.5) {
      drawLine(buf, cxe, cye, EW - 1, 3, cos, sin, midX, midY);
      continue;
    }

    const pr = PR * pose.pupilScale;
    // 瞳孔中心:随 gaze 平移到眼窝内缘;再夹进"可见带"里,别被眼睑切一半
    const px = cxe + pose.gazeX * Math.max(0, EW - pr);
    let py = cye + pose.gazeY * Math.max(0, EH - pr);
    const pyLo = lidY + pr;
    const pyHi = socketBot - pr;
    py = pyHi >= pyLo ? clampN(py, pyLo, pyHi) : (pyLo + pyHi) / 2;

    for (let y = 0; y < EYE_H; y++) {
      for (let x = 0; x < EYE_W; x++) {
        // 逆旋转到"未旋转"坐标系(等价于把整只眼绕画面中心旋转 rot)
        const dxr = x - midX;
        const dyr = y - midY;
        const ux = dxr * cos - dyr * sin + midX;
        const uy = dxr * sin + dyr * cos + midY;

        if (uy < lidY) continue; // 上眼睑遮住的部分
        if (!inSuperellipse(ux - cxe, uy - cye, EW, EH, RECT_EXP)) continue;
        // 眼窝内:亮;若落在瞳孔内则挖空(单色下瞳孔=黑洞)
        const inPupil = Math.hypot(ux - px, uy - py) <= pr;
        buf[y * EYE_W + x] = inPupil ? 0 : 1;
      }
    }
  }
  if (pose.hot) drawSteam(buf, pose.steamPhase);
  return buf;
}

/** 蒸汽纹:每只眼窝上沿飘一道正弦上下摆动的短竖纹(单色屏表达"烫") */
function drawSteam(buf: Uint8Array, phase: number): void {
  for (const cx of [CX_L, CX_R]) {
    for (let s = 0; s < 3; s++) {
      // 同一只眼的三道纹用不同相位错开,更像袅袅上升
      for (let y = 0; y < 10; y++) {
        const wy = CY - EH - 14 + y;
        if (wy < 0) continue;
        const wx = Math.round(cx + Math.sin(phase * 1.7 + s * 2.1 + y * 0.9) * 3);
        if (wx >= 0 && wx < EYE_W) buf[wy * EYE_W + wx] = 1;
      }
    }
  }
}

function clampN(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 一道横线(闭眼):绕中心旋转 */
function drawLine(
  buf: Uint8Array,
  cx: number,
  cy: number,
  halfW: number,
  th: number,
  cos: number,
  sin: number,
  midX: number,
  midY: number,
): void {
  const halfT = th / 2;
  for (let y = 0; y < EYE_H; y++) {
    for (let x = 0; x < EYE_W; x++) {
      const dxr = x - midX;
      const dyr = y - midY;
      const ux = dxr * cos - dyr * sin + midX;
      const uy = dxr * sin + dyr * cos + midY;
      if (Math.abs(ux - cx) <= halfW && Math.abs(uy - cy) <= halfT) buf[y * EYE_W + x] = 1;
    }
  }
}

/** 一道向上弯的弧(content:眼睛弯成两道弧) */
function drawArc(
  buf: Uint8Array,
  cx: number,
  cy: number,
  halfW: number,
  cos: number,
  sin: number,
  midX: number,
  midY: number,
): void {
  const halfT = STROKE / 2;
  const curve = 0.55; // 弯度
  for (let y = 0; y < EYE_H; y++) {
    for (let x = 0; x < EYE_W; x++) {
      const dxr = x - midX;
      const dyr = y - midY;
      const ux = dxr * cos - dyr * sin + midX;
      const uy = dxr * sin + dyr * cos + midY;
      const t = (ux - cx) / halfW; // -1..1
      if (t < -1 || t > 1) continue;
      // 向上弯:y 随 t 增大而减小(两端下垂、中间上拱)
      const ty = cy + halfW * curve * (t * t) - halfW * curve * 0.5;
      if (Math.abs(uy - ty) <= halfT) buf[y * EYE_W + x] = 1;
    }
  }
}

/** 点亮像素坐标列表(测试/调试用:把缓冲转成可读点) */
export function litPixels(buf: Uint8Array): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i]) out.push({ x: i % EYE_W, y: Math.floor(i / EYE_W) });
  }
  return out;
}

/** 亮像素数(测试断言便捷口) */
export function litCount(buf: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i]) n++;
  return n;
}
