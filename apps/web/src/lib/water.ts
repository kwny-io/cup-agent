/**
 * 一维水波 —— 卡通杯液面的物理内核(架构 §6.2)。
 *
 * 把液面离散成 N 个采样点,每点记:
 *   h[i]  偏离静止液面的高度(px,**向上为正**)
 *   v[i]  h[i] 的变化率
 *
 * 每个固定步长推进(不是每帧!调用方用 rAF + 固定 dt 累加,步长与帧率无关):
 *   a    = -k·h[i] + c·(h[i-1] + h[i+1] - 2h[i])   ← 弹簧回复 + 邻居传播
 *   v[i] = (v[i] + a·dt) · exp(-damp·dt)
 *   h[i] += v[i]·dt
 *
 * 关键选择:
 *   · h 每步做**零均值化**——水不可压缩,晃动不改变总量;
 *     总水量由 level_pct 单独驱动(见 CupWidget),h 只描述"波"。
 *   · 整体倾斜(slope)单独存,不参与波动方程:它是稳态形状,不是行波。
 *     倾斜时液面流向低处 = slope 拉大 + 一次冲流脉冲,静下来后保持 slope。
 *   · 端点按自由端处理(只有一侧邻居)。
 */

export const WAVE_POINTS = 32;

/** 波高峰值上限(px):杯里晃不出杯外,兼作数值兜底。 */
const H_MAX = 60;

/** 固定物理步长(秒)。渲染 60fps、输入 ~50Hz,都靠它对齐,别跟帧率漂。 */
export const FIXED_DT = 1 / 120;

export interface WaveParams {
  /** 弹簧回复:把 h 拉回 0 的强度,≈ 波的固有角频率² */
  k: number;
  /** 邻居传播:相邻点高度差驱动的耦合 */
  c: number;
  /** 阻尼(每秒),越大静得越快 */
  damp: number;
}

// 调参记录(靠 __probe 手感迭代,不是物理量):
//   k 小 → 波慢、大起大落;c 大 → 波在杯里铺开;damp 小 → 晃得久。
//   SHAKE_HZ 取在系统基频附近会共振放大,所以给 2.2Hz 而不是十几Hz。
export const DEFAULT_WAVE_PARAMS: WaveParams = { k: 42, c: 105, damp: 2.6 };

/** 摇晃驱动频率(Hz):液面左右来回晃的快慢,靠近水的晃动基频。 */
export const SHAKE_HZ = 2.2;

/**
 * 摇晃驱动增益:注入速度的幅值(px/s)。数值靠手感调,不是物理量。
 * 稳态波幅 ≈ 驱动速度 /(2π·SHAKE_HZ·damp),50Hz 连续驱动时大约 35px,
 * 留了到 H_MAX(60) 的余量,波是真在动而不是顶在上限。
 */
export const SHAKE_DRIVE_AMP = 3400;

/**
 * 整体倾斜的上限,**单位是 tan(液面倾角)**(无量纲)。0.73 ≈ 36°,刚好
 * 盖住 tilt_alert 的 35°;再陡就快洒出来了。与杯宽/采样点密度无关。
 */
export const MAX_TAN = 0.73;

/** 倾倒时冲流脉冲:让水"哗"地涌向低处,而不是瞬间摆好。 */
export const TILT_SLOSH_PER_RAD = 600;

/** 视觉倾角 → tan(倾角)。垂直方向略收(真实杯里水不会齐到杯壁)。 */
function clampTan(rad: number): number {
  const t = Math.tan(rad) * 0.92;
  if (t > MAX_TAN) return MAX_TAN;
  if (t < -MAX_TAN) return -MAX_TAN;
  return t;
}

export class WaterWave {
  readonly n: number;
  /** 波高,向上为正 */
  readonly h: Float32Array;
  /** 波高的变化率 */
  readonly v: Float32Array;
  /** 静止液面的整体倾斜(存 tan(倾角);向右下倾为正) */
  slopeTan = 0;
  /**
   * 液面的横向跨度(px)。slope 换算到"每采样点升降"要用它,
   * 由渲染方每次设置,使倾斜与杯宽/采样密度解耦。
   */
  spanPx = 100;
  /** 上一帧的倾斜目标,用来检测"倾角刚变化"→ 打冲流脉冲 */
  private prevTiltRad = 0;
  /** 复用的邻点快照,避免每步分配 */
  private readonly scratch: Float32Array;

  constructor(n = WAVE_POINTS) {
    this.n = n;
    this.h = new Float32Array(n);
    this.v = new Float32Array(n);
    this.scratch = new Float32Array(n);
  }

  /**
   * 第 i 个采样点的液面高度:波高 + 整体倾斜(相对静止线,向上为正)。
   * `slope` 是**每采样点**的升降量(px/索引间距),不是 px/px —— 这样
   * 液面整体倾角由 `slope / (杯宽/采样点数)` 决定,与采样密度解耦。
   */
  surfaceOffset(i: number): number {
    const dx = this.spanPx / (this.n - 1);
    return this.h[i]! + this.slopeTan * dx * (i - (this.n - 1) / 2);
  }

  /**
   * 摇晃驱动:按正弦相位给中间一带注入速度,模拟被人从中间来回晃。
   * 分布时**去掉均值**,保证只制造波动、不改变水量。
   */
  drive(phase: number, amp: number, dt: number): void {
    const { n, v } = this;
    const shape = Math.sin(phase) * amp;
    const c = (n - 1) / 2;
    const sigma2 = (n * 0.22) ** 2 * 2;
    const tmp = (i: number) => {
      const d = i - c;
      // 中心一个高斯包,让中间晃得最凶
      return Math.exp(-(d * d) / sigma2);
    };
    let sum = 0;
    for (let i = 0; i < n; i++) sum += tmp(i);
    const mean = sum / n;
    const norm = 1 / (1 - mean); // 归一化:去掉均值后峰值仍为 1,amp 才是真实幅值
    for (let i = 0; i < n; i++) v[i]! += (tmp(i) - mean) * norm * shape * dt;
  }

  /** 波是否已经静止(用于停止重绘) */
  get calm(): boolean {
    let mh = 0;
    let mv = 0;
    for (let i = 0; i < this.n; i++) {
      mh = Math.max(mh, Math.abs(this.h[i]!));
      mv = Math.max(mv, Math.abs(this.v[i]!));
    }
    return mh < 0.05 && mv < 0.25;
  }

  /** 给中间几个点注入一次脉冲(速度)。交替符号 → 零均值,不改变水量。 */
  impulse(amp: number): void {
    const c = (this.n - 1) / 2;
    for (let d = -1; d <= 1; d++) {
      const i = Math.round(c) + d;
      if (i < 0 || i >= this.n) continue;
      // 中间点最强,两侧弱;符号交替,像被人从中间晃了一下
      const w = d === 0 ? 1 : -0.65;
      this.v[i]! += amp * w;
    }
  }

  /**
   * 方向性冲流:给所有点加一份线性递增的速度(零均值),水整体往一侧涌。
   * amp>0 → 右侧抬起、水往左压;用于"倾斜时哗地流向低处"。
   */
  slosh(amp: number): void {
    const c = (this.n - 1) / 2;
    for (let i = 0; i < this.n; i++) this.v[i]! += (amp * (i - c)) / c;
  }

  /**
   * 把倾斜目标设成 tiltRad(带符号的弧度,右倾为正)。
   * slope 平滑逼近稳态倾角;倾角变化够大时补一记方向性冲流,
   * 让水真的"哗"地流向低处,而不是瞬间摆好角度。
   */
  applyTilt(tiltRad: number, dt: number): void {
    // 视觉斜率 ~ tan(倾角),两侧微收(真实杯里水不会齐到杯壁);限幅防洒。
    const target = clampTan(tiltRad);
    const d = tiltRad - this.prevTiltRad;
    this.prevTiltRad = tiltRad;

    // 平滑逼近(解耦遥测抖动),避免液面跟着采样噪点跳
    this.slopeTan += (target - this.slopeTan) * Math.min(1, 14 * dt);

    if (Math.abs(d) > 0.01) {
      // 一次性冲流;限幅防止极端倾角变化打飞液面
      const k = Math.max(-1, Math.min(1, d * 6));
      this.slosh(k * TILT_SLOSH_PER_RAD);
    }
  }

  /** 推进一个固定步长 */
  step(dt: number, p: WaveParams = DEFAULT_WAVE_PARAMS): void {
    const { n, h, v, scratch } = this;
    for (let i = 0; i < n; i++) scratch[i] = h[i]!;

    const decay = Math.exp(-p.damp * dt);
    for (let i = 0; i < n; i++) {
      const hi = scratch[i]!;
      let lap = 0;
      if (i > 0) lap += scratch[i - 1]! - hi;
      if (i < n - 1) lap += scratch[i + 1]! - hi;
      const a = -p.k * hi + p.c * lap;
      let vi = (v[i]! + a * dt) * decay;
      v[i] = vi;
      let hNew = hi + vi * dt;
      // 幅值上限:杯里晃不出杯外。既防极端共振数值发散,也防穿帮。
      if (hNew > H_MAX) hNew = H_MAX;
      else if (hNew < -H_MAX) hNew = -H_MAX;
      h[i] = hNew;
    }
    this.removeMean();
  }

  /** 零均值化:晃动不改变水量(总水量另由 level_pct 控制) */
  private removeMean(): void {
    const { n, h } = this;
    let s = 0;
    for (let i = 0; i < n; i++) s += h[i]!;
    const m = s / n;
    if (m === 0) return;
    for (let i = 0; i < n; i++) h[i] = h[i]! - m;
  }

  reset(): void {
    this.h.fill(0);
    this.v.fill(0);
    this.slopeTan = 0;
    this.prevTiltRad = 0;
  }
}
