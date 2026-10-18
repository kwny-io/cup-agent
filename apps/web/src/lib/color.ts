/**
 * 水温配色 —— 从冰青到暖橙的多段色阶,以及插值工具。
 *
 * 抽出来单独放,一是给 CupWidget 用,二是让配色管线能被测试直接跑
 * (这段曾经出过 NaN 崩渲染的 bug,值得钉住)。
 */

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/** 解析 '#rrggbb' 或 'rgb(r,g,b)'(mix 的产物会再被 mix,两种都要能解析)。 */
export function hex(h: string): number[] {
  if (h[0] === '#') return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const m = h.match(/\d+/g);
  return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : [0, 0, 0];
}

/** 两色按 k 线性混合,输出 'rgb(...)' —— 可再次作为输入(见 hex)。 */
export function mix(a: string, b: string, k: number): string {
  const pa = hex(a);
  const pb = hex(b);
  const c = pa.map((v, i) => Math.round(v + ((pb[i] ?? v) - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export interface TempColor {
  fill: string;
  deep: string;
  foam: string;
}

type Stop = { t: number } & TempColor;

/**
 * 水温 → 水色。凉=冰青,热=暖橙,一路沿暖青体系过渡,两端一眼可辨。
 *
 * 用**多段 stops**(像热力图)而不是两端直插:青和橙是互补色,直接按 RGB
 * 插值会在中间(≈50℃,最常喝的温水)糊成一坨灰褐。相邻 stop 色相接近,
 * 逐段插值就不会脏。deep/foam 同步给,保证底部渐变和泡沫也干净。
 */
export const TEMP_STOPS: Stop[] = [
  { t: 5, fill: '#bdeaf6', deep: '#5bb6cf', foam: '#eafafd' }, // 冰水
  { t: 20, fill: '#7fd1dd', deep: '#2f8ea0', foam: '#dcf4f7' }, // 暖青(品牌主色)
  { t: 38, fill: '#93dcc6', deep: '#3d9f89', foam: '#e2f7ef' }, // 微温(青绿)
  { t: 52, fill: '#e7d79a', deep: '#b4943c', foam: '#f7f0d6' }, // 温(金黄)
  { t: 65, fill: '#f7b57e', deep: '#e97b3c', foam: '#fce3cf' }, // 热(暖橙,品牌强调)
  { t: 82, fill: '#f08a55', deep: '#cf5a22', foam: '#fbd7bf' }, // 烫
];

/**
 * 水温分区 —— 与 TEMP_STOPS **同源**的一段连续区间,让「颜色」与「分区」不会各说各话。
 *
 *   cold <14 | cool 14–38 | comfort 38–52 | hot 52–65 | scalding ≥65
 *
 * `hot` 起于 52℃(金黄→暖橙那一段),也正是**喝不下去**的起点:蒸汽(55)、
 * 脑门汗(60)、硬件盖脸的 HOT_TEMP_C(55)全都落在这个区里。
 */
export type TempZone = 'cold' | 'cool' | 'comfort' | 'hot' | 'scalding';

export const TEMP_ZONE_EDGES = { cool: 14, comfort: 38, hot: 52, scalding: 65 } as const;

export function tempZone(t: number): TempZone {
  const e = TEMP_ZONE_EDGES;
  if (t < e.cool) return 'cold';
  if (t < e.comfort) return 'cool';
  if (t < e.hot) return 'comfort';
  if (t < e.scalding) return 'hot';
  return 'scalding';
}

/** 高温区里的「受不了」强度 0..1:52℃ 起步,65℃ 拉满,更烫恒为 1。 */
export function heatAmount(t: number): number {
  return clamp01((t - TEMP_ZONE_EDGES.hot) / (TEMP_ZONE_EDGES.scalding - TEMP_ZONE_EDGES.hot));
}

/** 分区中文名(调试/测试可读) */
export const TEMP_ZONE_LABEL: Record<TempZone, string> = {
  cold: '冷',
  cool: '凉',
  comfort: '舒适',
  hot: '热',
  scalding: '烫',
};

export function tempColor(t: number): TempColor {
  const stops = TEMP_STOPS;
  const lo = stops[0]!;
  const hi = stops[stops.length - 1]!;
  if (t <= lo.t) return { fill: lo.fill, deep: lo.deep, foam: lo.foam };
  if (t >= hi.t) return { fill: hi.fill, deep: hi.deep, foam: hi.foam };
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    if (t <= b.t) {
      const k = (t - a.t) / (b.t - a.t);
      return {
        fill: mix(a.fill, b.fill, k),
        deep: mix(a.deep, b.deep, k),
        foam: mix(a.foam, b.foam, k),
      };
    }
  }
  return { fill: hi.fill, deep: hi.deep, foam: hi.foam };
}
