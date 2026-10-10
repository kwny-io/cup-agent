/**
 * 反打卡立场的**表现层调子**(创意备忘 §5.1 #5)。
 *
 * 立场:杯子它会生气,但**会原谅你** —— 蔫的时候**不指责**,只是无精打采
 * (气泡变少、水色发灰、眼睛耷拉);你喝一口,它"勉强振作"一下(不是满血复活)。
 * 健康 App 死于制造焦虑,所以这里的情绪**都是往低处走、往暖处收**,没有一句重话。
 *
 * 三个纯函数(零 DOM、可测):
 *   · `pepEnvelope`   —— 最近喝过一口后的"勉强振作"包络(瞬间提振 → 衰减)
 *   · `dejectedness`  —— 综合"长期蔫 + 眼前这口提振"后的低落度 0..1
 *   · `dulled` / `soberBubbleCount` —— 由低落度派生**水色去饱和**与**气泡数量**
 *
 * 眼睛那半(耷拉/撇嘴)在 lib/eyes.ts 与 CupWidget 的 sulk 分支里已经成立,
 * 本模块只补上备忘点名缺的两样:**水色发灰**与**气泡变少**。
 *
 * 长期蔫与否由后端 `Report.disposition === 'sulky'` 喂进来(见 personality.ts);
 * "喝了一口"由 CupWidget 从水位掉一截就地检出(信号本就在遥测里)。
 */

/** "勉强振作"的峰值强度:不是满血,只回一小半 —— 傲娇的"勉为其难" */
export const PEP_GAIN = 0.6;
/** 提振的衰减时间常数(秒):慢慢蔫回去,不是瞬间打回原形 */
export const PEP_DECAY_S = 22;
/** 已激励多久算"振作得差不多了"(超过这个小段就不再当作新的一口) */
const PEP_FRESH_S = 0.7;

/**
 * "勉强振作"包络:刚从 0 跳到 1(喝了一口的新鲜度)。
 *
 * 由 Δ≥1 触发 —— CupWidget 检测到水位掉一截时把 `tSince=0`;之后每步 `+dt`。
 * 便于测试与渲染两侧共用同一条曲线,不各算各的。
 */
export function pepEnvelope(tSinceSip: number): number {
  if (tSinceSip <= 0) return 1;
  if (tSinceSip > PEP_DECAY_S * 6) return 0;
  return Math.exp(-tSinceSip / PEP_DECAY_S);
}

/**
 * 低落度 0..1:`1` = 长期蔫且眼下没被哄好;`0` = 要么不蔫,要么刚被"一口"哄得差不多了。
 *
 * @param sulky         长期性格是否蔫(后端 disposition === 'sulky')
 * @param tSinceSip     距最近一口的秒数;`null` = 这段时间没喝过
 */
export function dejectedness(sulky: boolean, tSinceSip: number | null): number {
  if (!sulky) return 0;
  const pep = tSinceSip === null ? 0 : pepEnvelope(tSinceSip) * PEP_GAIN;
  return Math.max(0, 1 - pep);
}

/**
 * 水色"发灰":把颜色朝它的亮度灰点收。
 *
 * 用**标准去饱和**(luma 插值)而非直接混灰 —— 混中灰会把暖橙水也染脏,
 * 而 luma 去饱和只是"提不起劲",水还是那个水的颜色,只是淡了。
 * `amount` 0 = 原色,1 = 全灰(实际由 `dejectedness × DULL_MAX` 给,不会到 1)。
 *
 * 同时接受 `#rrggbb` 与 `rgb(r,g,b)`(见 lib/color.ts 的 hex/mix 约定),输出恒为 `rgb(...)`。
 */
export function dulled(color: string, amount: number): string {
  const [r, g, b] = parseRgb(color);
  const k = amount < 0 ? 0 : amount > 1 ? 1 : amount;
  if (k === 0) return `rgb(${r},${g},${b})`;
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  const c = (v: number) => Math.round(v + (luma - v) * k);
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

/** 蔫到底时水色最多去饱和多少:留一点原色,不是彻底黑白 */
export const WATER_DULL_MAX = 0.5;

/** 蔫到底时最多减多少气泡(比例):留一半,不显得"死水" */
export const BUBBLE_DULL_MAX = 0.5;

/**
 * 委屈时还剩几个气泡 —— 按低落度线性削减,至少保留 1 个(全没了就像坏了,不是蔫了)。
 */
export function soberBubbleCount(base: number, dejected: number): number {
  const d = dejected < 0 ? 0 : dejected > 1 ? 1 : dejected;
  const n = Math.round(base * (1 - d * BUBBLE_DULL_MAX));
  return Math.max(1, n);
}

/** 解析 '#rrggbb' / 'rgb(r,g,b)';坏输入 → 中性灰(不炸渲染,同 color.ts 的兜底精神) */
function parseRgb(h: string): [number, number, number] {
  if (h[0] === '#') {
    return [
      parseInt(h.slice(1, 3), 16) || 0,
      parseInt(h.slice(3, 5), 16) || 0,
      parseInt(h.slice(5, 7), 16) || 0,
    ];
  }
  const m = h.match(/\d+/g);
  return m ? [Number(m[0]) || 0, Number(m[1]) || 0, Number(m[2]) || 0] : [128, 128, 128];
}

/** 是否算"刚喝了一口的新鲜提振"(供渲染侧判断要不要让眼睛别太耷拉) */
export function pepIsFresh(tSinceSip: number | null): boolean {
  return tSinceSip !== null && tSinceSip <= PEP_FRESH_S;
}
