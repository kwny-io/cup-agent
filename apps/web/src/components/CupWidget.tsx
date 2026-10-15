/**
 * 卡通杯 —— Canvas 2D + 一维水波物理(架构 §6.2)。
 *
 * 这是 **M3 英雄功能**:模拟器一摇,画面立即同步晃;倾斜时液面流向低处,
 * 静下来水平且带倾角。感觉是"同步"而非"播动画"。
 *
 * 实现要点:
 *   · 物理在 rAF 里跑,但**固定步长**(lib/water.ts 的 FIXED_DT),用累加器
 *     对齐 —— 输入 ~50Hz、渲染 60fps(甚至 120fps),步长都不漂。
 *   · 遥测通过 ref 读,不触发 React 重渲染(否则 1Hz 数据会让动画卡帧)。
 *   · 水位/水温做显示平滑(遥测变了液面才缓缓升降,不是瞬跳)。
 *   · motion==='shake' → 连续驱动中间点水波;tilt_deg/tilt_dir → 液面 slope
 *     + 冲流脉冲。有 imu 就用它的能量调制强度,没有就退回 motion 判定。
 *
 * 只读 lid/base 遥测,不关心数据从哪来。
 */
import { useEffect, useRef } from 'react';
import { SHAKE_DRIVE_AMP, SHAKE_HZ, WaterWave, FIXED_DT } from '../lib/water.ts';
import { clamp01, lerp, mix, tempColor, type TempColor } from '../lib/color.ts';
import { dejectedness, dulled, soberBubbleCount, WATER_DULL_MAX } from '../lib/sulk.ts';
import { CupMood, type Disposition, type Mood } from '../lib/mood.ts';
import { packRenderParams, type PackRenderParams } from '../lib/pack-render.ts';
import type { PersonaPack } from '../data/source.ts';
import type { BaseTelemetry, LidTelemetry } from '@cup/contract';

interface Props {
  lid?: LidTelemetry;
  base?: BaseTelemetry;
  /** 画布逻辑尺寸(CSS px);内部按 dpr 放大 */
  size?: number;
  /** 长期性格底色(M4,来自后端战报);缺省 normal = 无底色 */
  disposition?: Disposition;
  /**
   * 当前生效的人格包(P4.2);缺省 / null → 出厂体质。
   * 只管"底色与表达"(水波手感 + 心情/表情阈值),与 disposition(当前情绪)分工不重叠。
   */
  pack?: PersonaPack | null;
}

/**
 * 杯体配色 = 主题板「C · 奶油」的舱内副本(mirror of styles.css @theme)。
 *
 * 为什么在画布代码里放一份 hex,而不是读 CSS 变量:
 *   Tailwind v4 会 tree-shake 未被样式引用的 @theme token,运行时
 *   getPropertyValue('--color-cup-sky') 可能拿到空串 —— 读它会让画布随机缺色。
 *   集中成一份常量,至少不会再次散落在 10 个函数里。
 * ⚠️ 改主题色时,这里必须跟着 styles.css 一起改。
 * 注:水温色阶在 lib/color.ts,是**物理编码**(水多热),不属于本表。
 */
const P = {
  deep: '#2f6b66',
  deepInk: '#132624', // 瞳孔:deep 压暗(旧 #17332f 偏冷绿)
  aqua: '#4fa8a8',
  sky: '#8ec9c4',
  warm: '#f0a875',
  ember: '#d4813f',
} as const;
// 杯体玻璃:奶油色板下偏暖白(旧值 #dceef0/#f4fbfc/#eef8f9/#cfe6ea 是冷青)
const BODY_FILL = ['#f7f3ea', '#fdfbf6', '#fffdf9', '#fbf7ef', '#ece4d7'] as const;
const BODY_EDGE = '#c9bda9';
const RIM_IN = 'rgba(212,226,223,0.5)'; // 内沿:暖青 veil
const RIM_BACK = 'rgba(211,226,223,0.75)'; // 杯口后缘
const RIM_FRONT = '#b8a894'; // 杯口前缘(厚、实)
// 杯口内腔:烟灰青(aqua 去饱和,再用 veil 提亮至前壁)
const HOLE = ['rgba(127,157,151,0.5)', 'rgba(178,203,198,0.3)', 'rgba(232,238,233,0.16)'] as const;
const SHADOW = '#5f584d'; // 杯下投影:暖灰
const HILITE = '#fffdf9'; // 镜面高光:暖白(冷白在奶油板里发脏)

// ── 组件 ────────────────────────────────────────────────────────

export function CupWidget({ lid, base, size = 200, disposition = 'normal', pack = null }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  // 遥测走 ref:rAF 里读最新值,不让 1Hz 数据触发 React 重渲染
  const telemetry = useRef<{ lid?: LidTelemetry; base?: BaseTelemetry }>({ lid, base });
  telemetry.current = { lid, base };
  // 长期性格也走 ref:它是低频变化的天级信号,不该重建画布/物理(依赖只有 size)
  const dispRef = useRef<Disposition>(disposition);
  dispRef.current = disposition;
  // 生效包同理走 ref:换包不重建画布,只在 simulate 里换参数(包可能是异步到手的)
  const paramsRef = useRef<PackRenderParams>(packRenderParams(pack));
  paramsRef.current = packRenderParams(pack);
  // 显示用的平滑状态(水位/水温),跨渲染保留
  const disp = useRef({ level: 0, temp: 25, init: false });

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;

    const wave = new WaterWave();
    wave.spanPx = geom(size).w; // 液面横向跨度 → 倾角换算用,尺寸变化也准
    const mood = new CupMood();
    // "被喝"检测:水位比例往下掉一截 → 记一口(信号本来就在遥测里,不依赖事件流)
    let lastLevelPct: number | null = null;
    let raf = 0;
    let last = performance.now();
    let acc = 0; // 固定步长累加器
    let shakePhase = 0; // 摇晃驱动相位
    let wasShaking = false;
    let tSec = 0; // 动画时钟(气泡/蒸汽)
    // 反愧疚(#5):距最近一口的秒数 —— 蔫的杯子里"喝一口"→ 勉强振作一下
    let tSinceSip: number | null = null;

    const simulate = (dt: number) => {
      const { lid: l, base: b } = telemetry.current;
      const d = disp.current;
      const params = paramsRef.current;

      // 水位 / 水温:显示平滑(遥测变了才缓缓动)
      const levelTarget = (l?.level_pct ?? 0) / 100;
      const tempTarget = l?.temp_c ?? b?.temp_c ?? 25;
      if (!d.init) {
        d.level = levelTarget;
        d.temp = tempTarget;
        d.init = true;
      } else {
        d.level += (levelTarget - d.level) * (1 - Math.exp(-6 * dt));
        d.temp += (tempTarget - d.temp) * (1 - Math.exp(-2.5 * dt));
      }

      // 倾斜:带符号倾角 = 倾角 × 方向在屏幕水平轴上的投影
      const tiltDeg = l?.tilt_deg ?? 0;
      const tiltDir = ((l?.tilt_dir ?? 0) * Math.PI) / 180;
      const signedTiltRad = (tiltDeg * Math.PI) / 180 * Math.cos(tiltDir);
      wave.applyTilt(signedTiltRad, dt);

      // 摇晃:motion 判定为准;有 imu 就用其超出重力的能量调强度
      const shaking = l?.motion === 'shake';
      let amp = 0;
      if (shaking) {
        amp = 1;
        const imu = l?.imu;
        if (imu) {
          const mag = Math.hypot(imu.ax, imu.ay, imu.az);
          amp = Math.min(1.3, Math.max(amp, 0.55 + clamp01(Math.abs(mag - 1) / 1.4) * 0.9));
        }
      }
      if (shaking && !wasShaking) {
        // 起晃:相位归零,幅度从 0 起,避免第一下硬切
        shakePhase = 0;
        wasShaking = true;
      } else if (!shaking) {
        wasShaking = false;
      }
      if (amp > 0.001) {
        shakePhase += dt * Math.PI * 2 * SHAKE_HZ;
        wave.drive(shakePhase, amp * SHAKE_DRIVE_AMP, dt);
      }

      wave.step(dt, params.wave);
      tSec += dt;

      // 心情:先看这一帧水位有没有往下掉(被喝),再把状态机往前推一步
      const pct = (l?.level_pct ?? 0);
      if (lastLevelPct !== null && lastLevelPct - pct >= 2) {
        mood.noteSip();
        tSinceSip = 0; // 喝了一口 → 勉强振作的计时重置
      }
      lastLevelPct = pct;
      if (tSinceSip !== null) tSinceSip += dt; // 一口之后,提振随时间衰减
      mood.setDisposition(dispRef.current);
      mood.setParams(params.mood);
      mood.step(dt, shaking, levelTarget);
    };

    const render = () => {
      const { lid: l } = telemetry.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // 反愧疚(#5):把"长期蔫 + 眼前这口提振"算成 0..1 低落度,喂给水色/气泡/脸
      const dej = dejectedness(dispRef.current === 'sulky', tSinceSip);
      draw(ctx, size, wave, disp.current.level, disp.current.temp, l, tSec, mood.current, dej);
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      let dt = (now - last) / 1000;
      last = now;
      if (dt > 0.1) dt = 0.1; // 标签页切回来别一帧跳太狠
      acc += dt;
      let steps = 0;
      while (acc >= FIXED_DT && steps < 16) {
        simulate(FIXED_DT);
        acc -= FIXED_DT;
        steps++;
      }
      if (steps >= 16) acc = 0; // 长时间挂起:丢掉积压,别追帧
      render();
    };

    // 先同步画一帧:等第一帧遥测到位前也有画面;标签页在后台(rAF 被限流)时也不空
    disp.current.init = false;
    simulate(FIXED_DT);
    render();
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // size 变了才重建画布/物理;遥测通过 ref 传递,不进依赖
  }, [size]);

  return (
    <canvas
      ref={ref}
      style={{ width: size, height: size }}
      className="block touch-none"
      aria-label="水杯"
    />
  );
}

// ── 绘制 ────────────────────────────────────────────────────────

interface Geom {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  /** 杯口椭圆的竖直半径 —— 俯视一点视角,立体感的来源 */
  rim: number;
  /** 侧壁中段外鼓量 —— 让杯子"饱满",不是直筒 */
  bulge: number;
}

function geom(s: number): Geom {
  const w = s * 0.66; // 更宽 → 饱满
  const h = s * 0.56; // 略矮 → 敦实
  return {
    x: (s - w) / 2,
    y: s * 0.18,
    w,
    h,
    r: s * 0.115, // 大圆角:鼓、胖
    rim: w * 0.15,
    bulge: w * 0.05, // 侧壁外鼓更明显
  };
}

/**
 * 杯身轮廓:饱满的圆柱。两侧中段外鼓,底部大圆角,顶部接**椭圆杯口的上半弧**
 * (右极点 → 越顶 → 左极点),这样杯口才是一个"开口"而不是切平的板。
 * 水、内影都复用这条路径裁剪,保证与轮廓严丝合缝。
 */
function cupBodyPath(ctx: CanvasRenderingContext2D, g: Geom): void {
  const { x, y, w, h, r, rim, bulge } = g;
  const cx = x + w / 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.quadraticCurveTo(x - bulge, y + h * 0.5, x, y + h - r); // 左壁外鼓
  ctx.quadraticCurveTo(x, y + h, x + r, y + h); // 左下圆角
  ctx.lineTo(x + w - r, y + h); // 杯底
  ctx.quadraticCurveTo(x + w, y + h, x + w, y + h - r); // 右下圆角
  ctx.quadraticCurveTo(x + w + bulge, y + h * 0.5, x + w, y); // 右壁外鼓
  ctx.ellipse(cx, y, w / 2, rim, 0, 0, Math.PI, true); // 杯口上半弧
  ctx.closePath();
}

function draw(
  ctx: CanvasRenderingContext2D,
  s: number,
  wave: WaterWave,
  level: number,
  temp: number,
  lid: LidTelemetry | undefined,
  tSec: number,
  mood: Mood,
  dejected: number,
): void {
  ctx.clearRect(0, 0, s, s);
  const g = geom(s);
  const col = tempColor(temp);
  const level01 = clamp01(level);

  const cx = g.x + g.w / 2;

  // 杯下投影(落地感,立体第一步)
  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = SHADOW;
  ctx.beginPath();
  ctx.ellipse(cx, g.y + g.h + s * 0.02, g.w * 0.5, s * 0.03, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 杯身:饱满圆柱。横向渐变(左暗→中亮→右暗)是立体感的来源
  cupBodyPath(ctx, g);
  const body = ctx.createLinearGradient(g.x - g.bulge, 0, g.x + g.w + g.bulge, 0);
  body.addColorStop(0, BODY_FILL[0]);
  body.addColorStop(0.14, BODY_FILL[1]);
  body.addColorStop(0.42, BODY_FILL[2]); // 主高光带偏左
  body.addColorStop(0.72, BODY_FILL[3]);
  body.addColorStop(1, BODY_FILL[4]);
  ctx.fillStyle = body;
  ctx.fill();
  ctx.lineWidth = s * 0.018;
  ctx.strokeStyle = BODY_EDGE;
  ctx.stroke();

  // 内壁:杯口以内的"腔体"——上缘一圈青色内沿 + 两侧内影,把口"掏"出来
  ctx.save();
  cupBodyPath(ctx, g);
  ctx.clip();
  const inRim = ctx.createLinearGradient(0, g.y - g.rim, 0, g.y + g.rim * 2.2);
  inRim.addColorStop(0, RIM_IN);
  inRim.addColorStop(0.5, 'rgba(212,226,223,0.16)');
  inRim.addColorStop(1, 'rgba(212,226,223,0)');
  ctx.fillStyle = inRim;
  ctx.fillRect(g.x, g.y - g.rim, g.w, g.rim * 3.2);

  const inner = ctx.createLinearGradient(g.x, 0, g.x + g.w, 0);
  // 中性冷灰而非青色:青色影会把暖橙水染脏
  inner.addColorStop(0, 'rgba(58,74,68,0.1)');
  inner.addColorStop(0.16, 'rgba(58,74,68,0)');
  inner.addColorStop(0.84, 'rgba(58,74,68,0)');
  inner.addColorStop(1, 'rgba(58,74,68,0.1)');
  ctx.fillStyle = inner;
  ctx.fillRect(g.x, g.y, g.w, g.h);
  ctx.restore();

  // 水(内含液面/气泡/蒸汽)—— 独立裁剪,只画在水区
  ctx.save();
  cupBodyPath(ctx, g);
  ctx.clip();
  drawWater(ctx, s, g, wave, level01, temp, col, tSec, dejected);
  ctx.restore();

  // 脸:骑着液面,随波起伏、随坡微转
  drawFaceLayer(ctx, s, g, wave, level01, temp, lid, tSec, mood, dejected);

  // 杯口椭圆:画在脸之后,让杯口前缘"绕过"脸 —— 脸在杯里,口在前,纵深就出来了
  cupRim(ctx, s, g);

  // 侧壁竖高光:一条从上到下的亮带,圆柱玻璃感(裁进杯身)
  ctx.save();
  cupBodyPath(ctx, g);
  ctx.clip();
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = HILITE;
  ctx.lineWidth = s * 0.02;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(g.x + g.w * 0.24, g.y + g.h * 0.16);
  ctx.quadraticCurveTo(g.x + g.w * 0.19, g.y + g.h * 0.52, g.x + g.w * 0.23, g.y + g.h * 0.86);
  ctx.stroke();
  ctx.restore();
}

/** 水面:波高数组 + 整体倾斜构成液面曲线 */
function drawWater(
  ctx: CanvasRenderingContext2D,
  s: number,
  g: Geom,
  wave: WaterWave,
  level: number,
  temp: number,
  col: TempColor,
  tSec: number,
  dejected: number,
): void {
  const n = wave.n;
  const dx = g.w / (n - 1);
  const waterH = g.h * level;
  const surfaceY = g.y + g.h - waterH;

  // 反愧疚(#5):蔫则水色发灰(luma 去饱和)、气泡变少 —— 无精打采,不是指责
  const dull = dejected * WATER_DULL_MAX;
  const fill = dulled(col.fill, dull);
  const deep = dulled(col.deep, dull);
  const foam = dulled(col.foam, dull);

  if (level > 0.004) {
    // 液面曲线(向上为正 → 屏幕 y 要减)
    const yAt = (i: number) => surfaceY - wave.surfaceOffset(i);

    // 水体
    ctx.beginPath();
    ctx.moveTo(g.x, yAt(0));
    for (let i = 1; i < n; i++) ctx.lineTo(g.x + i * dx, yAt(i));
    ctx.lineTo(g.x + g.w, g.y + g.h);
    ctx.lineTo(g.x, g.y + g.h);
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, surfaceY - s * 0.06, 0, g.y + g.h);
    grad.addColorStop(0, fill);
    grad.addColorStop(1, mix(fill, deep, 0.85));
    ctx.fillStyle = grad;
    ctx.fill();

    // 气泡(上升)
    ctx.save();
    ctx.clip();
    drawBubbles(ctx, s, g, surfaceY, tSec, level, dejected);
    ctx.restore();

    // 液面描边:深色细线,给液面"边"
    ctx.beginPath();
    ctx.moveTo(g.x, yAt(0));
    for (let i = 1; i < n; i++) ctx.lineTo(g.x + i * dx, yAt(i));
    ctx.strokeStyle = deep;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = s * 0.012;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.globalAlpha = 1;

    // 泡沫高光:贴着液面的一条亮线
    ctx.beginPath();
    ctx.moveTo(g.x, yAt(0) - s * 0.008);
    for (let i = 1; i < n; i++) ctx.lineTo(g.x + i * dx, yAt(i) - s * 0.008);
    ctx.strokeStyle = foam;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = s * 0.014;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // 热水冒气 / 冷水凌霜
    if (temp >= 55) drawSteam(ctx, s, g, surfaceY, temp, tSec);
    else if (temp <= 12) drawFrost(ctx, s, g, surfaceY - s * 0.02, tSec);
  }

  // 空杯:杯底一点残渍
  if (level <= 0.04) {
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = deep;
    ctx.beginPath();
    ctx.ellipse(g.x + g.w / 2, g.y + g.h - s * 0.012, g.w * 0.34, s * 0.012, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function drawBubbles(
  ctx: CanvasRenderingContext2D,
  s: number,
  g: Geom,
  surfaceY: number,
  tSec: number,
  level: number,
  dejected = 0,
): void {
  if (level < 0.14) return;
  // 反愧疚(#5):蔫则气泡变少(至少留 1 个)—— 水"提不起劲"而不是"死水"
  const count = soberBubbleCount(5, dejected);
  const bottom = g.y + g.h;
  const span = bottom - surfaceY;
  if (span <= 4) return;
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = Math.max(1, s * 0.005);
  for (let k = 0; k < count; k++) {
    const seed = (k * 0.618) % 1;
    const speed = 0.14 + seed * 0.12;
    const p = (tSec * speed + seed) % 1; // 0=底,1=面
    const bx = g.x + g.w * (0.16 + 0.68 * ((seed * 7.13) % 1));
    const by = bottom - p * span;
    const r = s * (0.008 + 0.006 * ((seed * 3.7) % 1));
    const fade = Math.min(1, (1 - p) * 3) * Math.min(1, p * 8);
    ctx.globalAlpha = 0.5 * fade;
    ctx.beginPath();
    ctx.arc(bx + Math.sin(by * 0.09 + k) * r, by, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawSteam(
  ctx: CanvasRenderingContext2D,
  s: number,
  g: Geom,
  surfaceY: number,
  temp: number,
  tSec: number,
): void {
  const intensity = clamp01((temp - 52) / 25);
  const cx = g.x + g.w / 2;
  ctx.strokeStyle = P.ember;
  ctx.lineWidth = s * 0.012;
  ctx.lineCap = 'round';
  for (let k = -1; k <= 1; k++) {
    const bx = cx + k * g.w * 0.22;
    ctx.globalAlpha = 0.34 * intensity * (k === 0 ? 1 : 0.75);
    ctx.beginPath();
    const top = g.y + g.h * 0.06;
    const steps = 10;
    for (let i = 0; i <= steps; i++) {
      const p = i / steps;
      const yy = lerp(surfaceY - s * 0.02, top, p);
      const xx = bx + Math.sin(p * 5 + tSec * 2.2 + k * 1.7) * g.w * 0.07 * p;
      if (i === 0) ctx.moveTo(xx, yy);
      else ctx.lineTo(xx, yy);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawFrost(
  ctx: CanvasRenderingContext2D,
  s: number,
  g: Geom,
  y: number,
  tSec: number,
): void {
  ctx.strokeStyle = 'rgba(180,235,245,0.9)';
  ctx.lineWidth = Math.max(1, s * 0.006);
  const cx = g.x + g.w / 2;
  for (let k = -1; k <= 1; k++) {
    const bx = cx + k * g.w * 0.24;
    const yy = y - s * 0.02 - (Math.sin(tSec * 1.6 + k) + 1) * s * 0.008;
    const r = s * 0.014;
    ctx.globalAlpha = 0.55 + 0.25 * Math.sin(tSec * 2 + k * 2);
    ctx.beginPath();
    ctx.moveTo(bx - r, yy);
    ctx.lineTo(bx + r, yy);
    ctx.moveTo(bx, yy - r);
    ctx.lineTo(bx, yy + r);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** 脸:骑在液面上,随波起伏;倾角越大越"滑向低处",摇晃时闭眼发懵 */
function drawFaceLayer(
  ctx: CanvasRenderingContext2D,
  s: number,
  g: Geom,
  wave: WaterWave,
  level: number,
  temp: number,
  lid: LidTelemetry | undefined,
  tSec: number,
  mood: Mood,
  dejected: number,
): void {
  const n = wave.n;
  const mid = (n - 1) / 2;
  const dx = g.w / (n - 1);
  const waterH = g.h * level;
  const surfaceY = g.y + g.h - waterH;

  const empty = level <= 0.06;
  const faceR = s * 0.13;
  const sulking = mood === 'sulk'; // 蔫:闹别扭(撇嘴 + 眼神飘走)
  const smug = mood === 'smug'; // 得意:傲娇地满足(半眯眼)
  // 反愧疚(#5):蔫的**程度**(0..1)—— 喝了一口 → dejected 掉下来 → 表情缓和。
  // 不蔫时 sulkAmt 恒 0;蔫但刚被哄 → 介于"全撇嘴"和"淡淡抿着"之间(勉强振作)。
  const sulkAmt = sulking ? dejected : 0;

  // 液面中点(脸就骑在这)
  const midIdx = Math.round(mid);
  const midOffset = wave.surfaceOffset(midIdx);
  const surfMid = surfaceY - midOffset;

  // 脸随液面斜率微转
  const slopePxUp =
    (wave.surfaceOffset(Math.min(n - 1, midIdx + 1)) -
      wave.surfaceOffset(Math.max(0, midIdx - 1))) /
    (2 * dx);
  const rot = Math.atan(-slopePxUp) * 0.7;

  const cx = g.x + g.w / 2;
  let cy = empty ? g.y + g.h - faceR * 1.8 : surfMid - faceR * 1.35;
  // 夹在杯内:上界要躲开杯口椭圆前缘(脸在杯里,杯口画在后面会盖住脸)
  cy = Math.max(g.y + g.rim + faceR * 0.9, Math.min(g.y + g.h - faceR * 1.1, cy));

  const shaking = lid?.motion === 'shake';
  const tiltDir = ((lid?.tilt_dir ?? 0) * Math.PI) / 180;
  // 眼珠朝低处瞟
  const lookX = clamp01((1 + Math.cos(tiltDir)) / 2) * 2 - 1;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);

  const ink = P.deep;
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineCap = 'round';

  // 眼(二次元):竖长虹膜 + 上眼睑压盖 + 多重高光 + 睫毛
  const eyeDX = faceR * 0.5;
  const eyeY = -faceR * 0.04;
  const eyeRX = faceR * 0.25;
  const eyeRY = faceR * 0.34; // 竖长 → 二次元
  // 视线偏移(朝倾斜低处瞟):整颗虹膜在眼眶里平移
  // 蔫(闹别扭)→ 眼神飘走(往一边撇,不看你);被哄一口 → sulkAmt 变小 → 慢慢看回来
  const gazeX = empty ? 0 : sulking ? -eyeRX * 0.34 * sulkAmt : lookX * eyeRX * 0.32;
  const gazeY = shaking ? Math.sin(tSec * 12) * eyeRY * 0.08 : sulking ? eyeRY * 0.06 * sulkAmt : 0;
  // 得意 → 半眯眼(上眼睑压到中段,露出下半个亮虹膜,像在"哼")
  const lidDroop = smug ? 0.78 : 0;

  if (empty || shaking) {
    // 蔫 / 发懵:闭眼(向下弯的弧,像 ▶◀ 的柔和版;摇晃时上下抖)
    const wob = shaking ? Math.sin(tSec * 14) * faceR * 0.05 : 0;
    ctx.strokeStyle = ink;
    ctx.lineWidth = Math.max(2, faceR * 0.15);
    for (const d of [-eyeDX, eyeDX]) {
      ctx.beginPath();
      ctx.arc(d, eyeY - faceR * 0.02 + wob, faceR * 0.24, Math.PI * 1.18, Math.PI * 1.82);
      ctx.stroke();
    }
    // 蔫了也留一撮睫毛
    ctx.lineWidth = Math.max(2, faceR * 0.11);
    ctx.beginPath();
    ctx.moveTo(-eyeDX - faceR * 0.24, eyeY - faceR * 0.14 + wob);
    ctx.lineTo(-eyeDX - faceR * 0.36, eyeY - faceR * 0.22 + wob);
    ctx.moveTo(eyeDX + faceR * 0.24, eyeY - faceR * 0.14 + wob);
    ctx.lineTo(eyeDX + faceR * 0.36, eyeY - faceR * 0.22 + wob);
    ctx.stroke();
  } else {
    for (const d of [-eyeDX, eyeDX]) {
      const ex = d + gazeX;
      const ey = eyeY + gazeY;

      // 眼眶:竖向椭圆,填白眼
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(ex, ey, eyeRX, eyeRY, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.clip();

      // 虹膜:上部暖青亮、下部深青,二次元的"上暗下亮"玻璃感
      const irisR = eyeRX * 1.05;
      const iris = ctx.createLinearGradient(0, ey - eyeRY, 0, ey + eyeRY);
      iris.addColorStop(0, P.deep);
      iris.addColorStop(0.55, P.aqua);
      iris.addColorStop(1, P.sky);
      ctx.fillStyle = iris;
      ctx.beginPath();
      ctx.ellipse(ex, ey + gazeY * 0.4 + eyeRY * 0.04, irisR, eyeRY * 0.92, 0, 0, Math.PI * 2);
      ctx.fill();

      // 瞳孔:深色竖椭圆
      ctx.fillStyle = P.deepInk;
      ctx.beginPath();
      ctx.ellipse(ex, ey + eyeRY * 0.06, irisR * 0.5, eyeRY * 0.62, 0, 0, Math.PI * 2);
      ctx.fill();

      // 主高光(左上大块)+ 副高光(右下小点)—— 二次元的标志
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(ex - irisR * 0.36, ey - eyeRY * 0.4, irisR * 0.36, eyeRY * 0.3, -0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.ellipse(ex + irisR * 0.34, ey + eyeRY * 0.4, irisR * 0.16, eyeRY * 0.14, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.restore();

      // 上眼睑:一道粗弧压住眼球上缘(二次元的"眼线");得意时整体下压 = 眯眼
      ctx.strokeStyle = ink;
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(2, faceR * (smug ? 0.2 : 0.13));
      ctx.beginPath();
      const lidY = ey - eyeRY * 0.62 + eyeRY * lidDroop;
      const lidEdge = ey - eyeRY * 0.15 + eyeRY * lidDroop;
      ctx.moveTo(ex - eyeRX * 0.98, lidEdge + eyeRY * 0.06);
      ctx.quadraticCurveTo(ex, lidY - eyeRY * 0.5, ex + eyeRX * 0.98, lidEdge - eyeRY * 0.02);
      ctx.stroke();

      // 外眼角睫毛:往外上翘一撮
      ctx.lineWidth = Math.max(2, faceR * 0.1);
      const outward = d < 0 ? -1 : 1;
      ctx.beginPath();
      ctx.moveTo(ex + outward * eyeRX * 0.95, ey - eyeRY * 0.2);
      ctx.lineTo(ex + outward * eyeRX * 1.5, ey - eyeRY * 0.62);
      ctx.stroke();
    }
  }

  // 腮红(热)或冷色腮(凉)
  if (temp >= 45 || temp <= 14) {
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = temp >= 45 ? P.warm : P.sky;
    for (const d of [-faceR * 0.85, faceR * 0.85]) {
      ctx.beginPath();
      ctx.ellipse(d, faceR * 0.22, faceR * 0.2, faceR * 0.13, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // 嘴:随心情。傲娇的"哼"是**一边嘴角上扬**的斜笑,闹别扭是**撇嘴**
  ctx.strokeStyle = ink;
  ctx.lineWidth = Math.max(2, faceR * 0.15);
  ctx.beginPath();
  const my = faceR * 0.3;
  if (shaking || mood === 'refuse' || mood === 'give') {
    // 被摇:先皱成波浪嘴,勉为其难时幅度收小(不再抗议)
    const k = mood === 'give' ? 0.6 : 1;
    ctx.moveTo(-faceR * 0.4, my + faceR * 0.1 * k);
    ctx.quadraticCurveTo(-faceR * 0.13, my - faceR * 0.08 * k, 0, my + faceR * 0.1 * k);
    ctx.quadraticCurveTo(faceR * 0.13, my + faceR * 0.28 * k, faceR * 0.4, my + faceR * 0.1 * k);
  } else if (smug) {
    // 得意:一边翘的斜笑 —— "哼,这才像话"
    ctx.moveTo(-faceR * 0.46, my + faceR * 0.16);
    ctx.quadraticCurveTo(0, my - faceR * 0.02, faceR * 0.5, my - faceR * 0.3);
  } else if (sulking) {
    // 蔫:撇嘴(嘴角往一边耷拉),不是悲伤的瘪嘴。
    // 被哄一口(sulkAmt 变小)→ 嘴角抬上来,成"淡淡抿着" = 勉强振作,不是咧嘴笑
    const down = faceR * 0.34 * sulkAmt;
    ctx.moveTo(-faceR * 0.44, my + faceR * 0.2 * (1 - sulkAmt));
    ctx.quadraticCurveTo(-faceR * 0.05, my + down, faceR * 0.4, my + down);
  } else if (empty) {
    ctx.arc(0, faceR * 0.62, faceR * 0.32, Math.PI * 1.15, Math.PI * 1.85);
  } else {
    const smile = level > 0.45 ? 0.55 : level > 0.22 ? 0.2 : -0.35;
    ctx.moveTo(-faceR * 0.42, my);
    ctx.quadraticCurveTo(0, my + smile * faceR * 0.9, faceR * 0.42, my);
  }
  ctx.stroke();

  // 皱眉:只在摇杯起手那一瞬(refuse),两道斜线压在眼上方 —— 傲娇的"不耐烦"
  if (mood === 'refuse') {
    ctx.strokeStyle = ink;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(2, faceR * 0.14);
    const browY = eyeY - eyeRY - faceR * 0.2;
    for (const d of [-eyeDX, eyeDX]) {
      const inward = d < 0 ? 1 : -1; // 眉梢朝内下压 = 皱眉
      ctx.beginPath();
      ctx.moveTo(d - inward * faceR * 0.26, browY + faceR * 0.08);
      ctx.lineTo(d + inward * faceR * 0.24, browY - faceR * 0.06);
      ctx.stroke();
    }
  }

  // 热水脑门一点汗
  if (temp >= 60 && !shaking && !empty) {
    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = P.sky;
    ctx.beginPath();
    ctx.ellipse(faceR * 0.8, -faceR * 0.55, faceR * 0.1, faceR * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.restore();
}

/**
 * 杯口:一个椭圆开口。后缘(上半弧)淡而远,前缘(下半弧)实而近 ——
 * 前缘画在脸之后,让"口沿"绕过脸,杯子立刻有了纵深。
 */
function cupRim(ctx: CanvasRenderingContext2D, s: number, g: Geom): void {
  const cx = g.x + g.w / 2;
  const rx = g.w / 2;
  const ry = g.rim;

  // 口腔:只在杯身内填(裁掉上半弧以外的区域,免得涂到杯外)
  ctx.save();
  cupBodyPath(ctx, g);
  ctx.clip();
  const hole = ctx.createLinearGradient(0, g.y - ry, 0, g.y + ry);
  hole.addColorStop(0, HOLE[0]); // 后壁:深
  hole.addColorStop(0.65, HOLE[1]);
  hole.addColorStop(1, HOLE[2]); // 前壁:浅
  ctx.fillStyle = hole;
  ctx.beginPath();
  ctx.ellipse(cx, g.y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 后缘(上半弧):细、淡
  ctx.beginPath();
  ctx.ellipse(cx, g.y, rx, ry, 0, Math.PI, Math.PI * 2);
  ctx.strokeStyle = RIM_BACK;
  ctx.lineWidth = Math.max(1, s * 0.007);
  ctx.stroke();

  // 前缘(下半弧):厚、实,近处的口沿 + 一道白高光
  ctx.beginPath();
  ctx.ellipse(cx, g.y, rx, ry, 0, 0, Math.PI);
  ctx.strokeStyle = RIM_FRONT;
  ctx.lineWidth = Math.max(1.5, s * 0.015);
  ctx.lineCap = 'round';
  ctx.stroke();

  ctx.beginPath();
  ctx.ellipse(cx, g.y + s * 0.008, rx * 0.9, ry * 0.92, 0, Math.PI * 0.15, Math.PI * 0.85);
  ctx.strokeStyle = 'rgba(255,253,249,0.7)';
  ctx.lineWidth = Math.max(1, s * 0.008);
  ctx.stroke();
}
