/**
 * 可复现随机数 —— 同一 seed 得到同一份模拟数据。
 * 这是模拟器的硬要求:调试时不能每次跑出不同的数,否则没法复现问题。
 */

/** mulberry32:小、快、够随机。确定性 = 由 seed 决定整条序列。 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 在 [min, max) 内均匀取数 */
export function uniform(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

/**
 * 由模拟器 seed 派生一个 64 位子种子 —— 同 `seed` + 同 `salt` → 同值(可复现),
 * 不同 `salt` → 不同流(各用途互不串扰)。供 claim code 这类"要 64 位一次性值"的地方用
 * (claim 用 splitmix64 吃 64 位种子,见 util/claim.ts)。
 */
export function deriveSeed64(seed: number, salt: number): bigint {
  const rng = createRng(seed ^ Math.imul(salt, 0x9e3779b1));
  const hi = BigInt(Math.floor(rng() * 0x1_0000_0000));
  const lo = BigInt(Math.floor(rng() * 0x1_0000_0000));
  return (hi << 32n) | lo;
}

/**
 * 在期望值附近取高斯噪声(Box–Muller)。
 * 注意:高斯噪声理论上无界,这里截到 ±3σ,避免偶发离谱读数污染"稳定性检测"。
 */
export function gaussian(
  rng: () => number,
  mean: number,
  std: number,
): number {
  const u1 = Math.max(rng(), 1e-12); // 防 log(0)
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + Math.max(-3, Math.min(3, z)) * std;
}
