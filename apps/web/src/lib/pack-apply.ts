/**
 * 人格包**应用层钳制**(#73 UGC 安全边,第二道)。
 *
 * 后端 normalizePack 已经做过一次保守净化(白名单键 + 宽区间);这里做**语义区间**
 * 钳制 —— 因为只有前端知道 mood.ts / water.ts 里那些参数的**手感量级**:
 *   · 一个 `k: 0` 的水波参数让水波永不回复(死水),`k: 9999` 会瞬间爆掉;
 *   · `SULK_LEVEL: 5` 会让杯子永远蔫。
 * 纵深防御:入口挡畸形,这里挡"合法但会毁手感"的值。
 *
 * **远端包只覆盖数值 + 文本,绝不执行代码** —— 本文件只产出普通对象/数组。
 *
 * 抽到 lib 是为了**可测**:越界钳到边界、未知键丢弃、长文本截断,都能直接单测。
 */
import { PACK_THRESHOLD_KEYS, PACK_WAVE_KEYS } from '../data/source.ts';
import type { PackDraft, PersonaPack } from '../data/source.ts';

/**
 * 阈值键的**语义区间**(对齐 apps/web/src/lib/mood.ts 的量级)。
 * 键名与后端 PACK_THRESHOLD_KEYS 同一套;区间是"能调但不毁手感"的域。
 * 缺省区间(不在表里的键)用 [0, 3600] —— 与后端宽区间一致,只挡负/爆炸值。
 */
const THRESHOLD_RANGE: Record<string, [number, number]> = {
  REFUSE_S: [0.05, 3], // 摇杯皱眉时长(秒),默认 0.45
  SMUG_S: [0.5, 30], // 得意持续(秒),默认 4
  CONTENT_S: [0, 60],
  IDLE_S: [0, 300],
  SULK_LEVEL: [0, 1], // 水位比例
  SULK_STREAK: [0, 60], // 连续低水位天数
};

/**
 * 水波三参的语义区间(对齐 apps/web/src/lib/water.ts 的 DEFAULT_WAVE_PARAMS {42,105,2.6})。
 * 都取正:负的 k/damp 会让波发散。
 */
const WAVE_RANGE: Record<string, [number, number]> = {
  k: [1, 500], // 弹簧回复
  c: [0, 800], // 邻居传播
  damp: [0.1, 40], // 阻尼
};

const FALLBACK_RANGE: [number, number] = [0, 3600];
const MAX_LINE_LEN = 80;
const MAX_LINES = 20;
const MAX_TONE_LEN = 200;

function clampRange(v: number, [lo, hi]: [number, number]): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 只留白名单键 + 有限数,逐项按语义区间钳制;未知键丢弃(静默净化) */
function clampNumbers(
  src: Record<string, number>,
  keys: readonly string[],
  ranges: Record<string, [number, number]>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) {
    const raw = src[k];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    out[k] = clampRange(raw, ranges[k] ?? FALLBACK_RANGE);
  }
  return out;
}

/**
 * 把一份(来自后端的)人格包钳成**可安全应用**的形状。
 * 所有数值落进语义区间,台词/语气/包名按长度封顶,未知键全部丢掉。
 */
export function sanitizePack(pack: PersonaPack): PersonaPack {
  return {
    pack_id: pack.pack_id,
    author_user_id: pack.author_user_id,
    name: pack.name.slice(0, 40),
    tone: (pack.tone ?? '').slice(0, MAX_TONE_LEN),
    thresholds: clampNumbers(pack.thresholds ?? {}, PACK_THRESHOLD_KEYS, THRESHOLD_RANGE),
    wave: clampNumbers(pack.wave ?? {}, PACK_WAVE_KEYS, WAVE_RANGE),
    lines: (pack.lines ?? [])
      .filter((l): l is string => typeof l === 'string')
      .map((l) => l.trim().slice(0, MAX_LINE_LEN))
      .filter((l) => l.length > 0)
      .slice(0, MAX_LINES),
    status: pack.status,
    created_at: pack.created_at,
  };
}

/** 投稿草稿的钳制 —— 用户在表单里造的草稿,发后端前先夹一次(与后端同口径的预检) */
export function sanitizeDraft(draft: PackDraft): PackDraft {
  const asPack: PersonaPack = {
    pack_id: '',
    author_user_id: '',
    name: draft.name,
    tone: draft.tone,
    thresholds: draft.thresholds,
    wave: draft.wave,
    lines: draft.lines,
    status: 'pending',
    created_at: 0,
  };
  const s = sanitizePack(asPack);
  return { name: s.name, tone: s.tone, thresholds: s.thresholds, wave: s.wave, lines: s.lines };
}

/**
 * 把阈值覆盖表渲染成"键 → 值"的可读行(市场卡里展示一份包"改了什么")。
 * 按固定键顺序(与后端同一套),不展示未知键(它们本就被丢了)。
 */
export function describeThresholds(t: Record<string, number>): { key: string; value: number }[] {
  return PACK_THRESHOLD_KEYS.filter((k) => k in t).map((k) => ({ key: k, value: t[k]! }));
}

/** 同上,水波三参 */
export function describeWave(w: Record<string, number>): { key: string; value: number }[] {
  return PACK_WAVE_KEYS.filter((k) => k in w).map((k) => ({ key: k, value: w[k]! }));
}
