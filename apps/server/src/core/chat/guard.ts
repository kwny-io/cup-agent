/**
 * 数字守卫 —— `llm.ts` 里 `safeTone` 的继任者,**方向相反**。
 *
 *   · `safeTone`(战报润色):要**不许漏** —— 原句里的数字必须都还在
 *   · 本模块(对话):     要**不许多** —— 回复里的数字必须都能追溯到"事实来源"
 *
 * 事实来源 = 工具返回结果 ∪ 用户的问题 ∪ 最近对话历史。
 * 模型自己算出来的数(如 1500-728=772)不算数 —— 必须由工具预计算好(见 tools.ts)。
 * 这是 M4"数字不能瞎编"(验收 2)在对话层的延续。
 *
 * 与 `safeTone` 的另一个共同点:**失败不是崩溃,是回退**。守卫不过 → 调用方
 * 用确定性模板兜底说话,绝不给用户一个空泡(ADR T12)。
 */

const NUM_RE = /\d+(?:\.\d+)?/g;
const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}/g;

/** 归一化一个数字串:`1,000` → `1000`,`3.50` → `3.5` */
function canon(n: string): string {
  const f = Number.parseFloat(n);
  return Number.isFinite(f) ? String(f) : n;
}

/** 去掉 ISO 日期(2026-10-08 不该被当成"凭空数字") */
function stripDates(s: string): string {
  return s.replace(ISO_DATE_RE, ' ');
}

/** 从一段文本里抽出归一化后的数字集合 */
export function numbersIn(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of stripDates(s).match(NUM_RE) ?? []) out.add(canon(m));
  return out;
}

/** 把一段文本里的数字并入 allow 集合(事实来源的累积) */
export function collectNumbers(into: Set<string>, s: string): void {
  for (const n of numbersIn(s)) into.add(n);
}

export interface Grounding {
  ok: boolean;
  reason?: string;
}

/**
 * 判断一句回复是否"有据可依"。
 *
 * 通过条件(全部满足):
 *   · 非空、单行、长度 ≤ 300
 *   · 每个数字都在 allow 集合里
 */
export function grounded(text: string, allowed: Set<string>): Grounding {
  const t = text.trim();
  if (t.length === 0) return { ok: false, reason: '空回复' };
  if (t.length > 300) return { ok: false, reason: '过长' };
  if (/[\n\r]/.test(t)) return { ok: false, reason: '不是单行' };
  for (const m of stripDates(t).match(NUM_RE) ?? []) {
    if (!allowed.has(canon(m))) return { ok: false, reason: `凭空数字 ${m}` };
  }
  return { ok: true };
}
