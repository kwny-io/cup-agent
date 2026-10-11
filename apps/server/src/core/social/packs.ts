/**
 * 人格市场包 —— 投稿的**形状校验 + 归一化**(UGC 安全边)。
 *
 * ── 为什么校验必须在服务端 ────────────────────────────────────────
 * 包是**用户投稿**的内容,要到别人杯子上生效。两个硬规矩:
 *   1. **只带数值 + 文本,绝不执行代码** —— 这里只解析数字与字符串,任何别的东西丢掉。
 *   2. **逐项钳制 + 长度封顶** —— 一个 `k: 1e9` 的水波参数或 10 万字的台词,
 *      到前端就是崩/卡;入口这里先夹住,前端再夹一次(纵深防御)。
 * 数值的**语义区间**前端最清楚(见 apps/web lib/pack-apply.ts);这里给保守的宽区间,
 * 只挡明显畸形,不替前端定最终口径。
 */
import { newPackId } from './crypto.ts';
import type { PersonaPack } from './types.ts';

const MAX_NAME_LEN = 40;
const MAX_TONE_LEN = 200;
const MAX_LINE_LEN = 80;
const MAX_LINES = 20;
const MAX_TRAIT_KEYS = 16;

/** 市场包里允许出现的阈值键(mood.ts 的量级)—— 未知键直接丢,不给前端瞎传的机会 */
export const PACK_THRESHOLD_KEYS = [
  'REFUSE_S',
  'SMUG_S',
  'CONTENT_S',
  'IDLE_S',
  'SULK_LEVEL',
  'SULK_STREAK',
] as const;
/** 水波性格键(water.ts 的 DEFAULT_WAVE_PARAMS 三参) */
export const PACK_WAVE_KEYS = ['k', 'c', 'damp'] as const;

export interface PackDraft {
  name: string;
  tone: string;
  thresholds: Record<string, number>;
  wave: Record<string, number>;
  lines: string[];
}

export type PackResult =
  | { ok: true; draft: PackDraft }
  | { ok: false; error: string };

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** 只留下白名单键、有限数、且落 [lo,hi] 的项;其余丢弃(不报错,静默净化) */
function pickNumbers(
  src: unknown,
  keys: readonly string[],
  lo: number,
  hi: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  const rec = asRecord(src);
  let n = 0;
  for (const k of keys) {
    if (n >= MAX_TRAIT_KEYS) break;
    const raw = rec[k];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    out[k] = Math.min(hi, Math.max(lo, raw));
    n += 1;
  }
  return out;
}

/**
 * 校验并归一化一份投稿。返回净化后的 draft(权威形状),或错误串。
 * 净化是**静默**的(丢非法项),但"名字空 / 没有台词"这类硬缺失要明确报错。
 */
export function normalizePack(body: unknown): PackResult {
  const b = asRecord(body);
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (name.length === 0) return { ok: false, error: '包名不能为空' };
  if (name.length > MAX_NAME_LEN) return { ok: false, error: `包名过长(上限 ${MAX_NAME_LEN} 字)` };

  const tone = typeof b.tone === 'string' ? b.tone.slice(0, MAX_TONE_LEN) : '';

  // 阈值 / 水波:保守宽区间,只挡畸形(真正的语义区间在前端 apply 时夹)
  const thresholds = pickNumbers(b.thresholds, PACK_THRESHOLD_KEYS, 0, 3600);
  const wave = pickNumbers(b.wave, PACK_WAVE_KEYS, 0, 10_000);

  const rawLines = Array.isArray(b.lines) ? b.lines : [];
  const lines = rawLines
    .filter((l): l is string => typeof l === 'string')
    .map((l) => l.trim().slice(0, MAX_LINE_LEN))
    .filter((l) => l.length > 0)
    .slice(0, MAX_LINES);

  if (lines.length === 0 && tone.length === 0) {
    return { ok: false, error: '至少要有语气或一句台词' };
  }

  return { ok: true, draft: { name, tone, thresholds, wave, lines } };
}

/** 由净化后的 draft 造一条待审包(pack_id / 作者 / 时间 / 状态由服务端填) */
export function makePack(draft: PackDraft, authorUserId: string, nowMs: number): PersonaPack {
  return {
    pack_id: newPackId(),
    author_user_id: authorUserId,
    name: draft.name,
    tone: draft.tone,
    thresholds: draft.thresholds,
    wave: draft.wave,
    lines: draft.lines,
    status: 'pending',
    created_at: nowMs,
  };
}
