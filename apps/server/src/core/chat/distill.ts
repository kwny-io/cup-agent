/**
 * 长期画像蒸馏 —— `profile()` 的**写端**(memory.ts 注释里那句"要蒸馏是另调一次 LLM")。
 *
 * 读端(agent.ts)已把画像按字节封顶注入系统提示;本模块负责**产出**那段文本:
 * 攒够新对话轮 → 让模型把最近对话**归纳**成"杯子对主人的长期记忆" → 落进 `setProfile()`。
 *
 * 三条与 ADR T12 同源的立场:
 *   1. **画像不是依赖**:模型不可用(NullChatLlm / 出错)→ 用**确定性模板画像**兜底
 *      (数字取自日聚合,绝不含空泡谎);模型只是把它归纳得更准。
 *   2. **数字不许凭空**:模型产出的画像同样过**数字守卫**(allow 集 = 历史轮数字 ∪
 *      日聚合事实数字)—— 否则读端还会把画像数字并入守卫,等于给瞎编数开后门。
 *   3. **有界**:画像文本 `MAX_PROFILE_CHARS` 封顶、输入是 `recentTurns` 的 4KB 窗口。
 *
 * 判"攒够了"用阈值 `minNewTurns`(自上次蒸馏以来新增的轮数)。无 LLM 时阈值不可达,
 * 故这个功能在模板档位下**自然休眠**(不白跑、不写空画像)。
 */
import type { Store } from '../../store/store.ts';
import { dayKey } from '../../store/store.ts';
import type { ChatLlm, LogFn } from './types.ts';
import { PROFILE_DISTILL_SYSTEM } from './prompt.ts';
import { collectNumbers, numbersIn, type Grounding } from './guard.ts';
import { MAX_PROFILE_CHARS, type ChatStore, type ChatTurnRecord } from './memory.ts';

/** 自上次蒸馏后至少新增这么多轮,才值得再蒸一次(免得每句都烧一次模型) */
export const DEFAULT_MIN_NEW_TURNS = 8;

export interface DistillDeps {
  store: Store;
  memory: ChatStore;
  chat: ChatLlm;
  log: LogFn;
  now?: () => number;
}

export interface DistillRequest {
  cupId: string;
  /** 注入时钟便于测试(缺省用 deps.now 或 Date.now) */
  nowMs?: number;
  minNewTurns?: number;
}

export interface DistillResult {
  text: string;
  source: 'llm' | 'template';
}

/** 攒够新轮了吗(自 sinceTs 起新增 ≥ minNewTurns 条) */
export function distillDue(
  store: ChatStore,
  cupId: string,
  sinceTs: number,
  minNewTurns = DEFAULT_MIN_NEW_TURNS,
): boolean {
  const turns = store.recentTurns(cupId, 200);
  let n = 0;
  for (const t of turns) if (t.ts > sinceTs) n++;
  return n >= minNewTurns;
}

/** 把召回的历史轮拍成一段朴素文本(user/assistant/proactive 三分) */
export function transcript(turns: ChatTurnRecord[]): string {
  const lines: string[] = [];
  for (const t of turns) {
    const who = t.role === 'user' ? '主人' : t.role === 'proactive' ? '(杯子主动)' : '杯子';
    lines.push(`${who}: ${t.text}`);
  }
  return lines.join('\n');
}

/**
 * 确定性模板画像 —— 模型不可用 / 守卫拦下时的兜底。
 * 数字**全部来自日聚合**,与 report.ts 同宗("模板 + 真实数字是主路径")。
 */
export function templateProfile(store: Store, cupId: string, nowMs: number): string {
  const rows = store.recentAggs(cupId, dayKey(nowMs), 7);
  const totalDrank = rows.reduce((s, a) => s + a.drank_ml, 0);
  const daysWithData = rows.filter((a) => a.event_count > 0).length;
  const goal = store.goal(cupId);
  const parts: string[] = [];
  if (daysWithData > 0) parts.push(`近 7 天有 ${daysWithData} 天在喝,共约 ${totalDrank}ml`);
  parts.push(`每日目标 ${goal}ml`);
  return `据杯子自己的记录:${parts.join(',')}。`;
}

/**
 * 画像可否采用:非空、单行、≤ 上限、**数字不凭空**。
 * 是 `guard.grounded` 的放宽版 —— 上限换成长度 `MAX_PROFILE_CHARS`(画像比一句答复长)。
 */
export function acceptProfile(text: string, allowed: Set<string>): Grounding {
  const t = text.trim();
  if (t.length === 0) return { ok: false, reason: '空画像' };
  if (t.length > MAX_PROFILE_CHARS) return { ok: false, reason: '过长' };
  if (/[\n\r]/.test(t)) return { ok: false, reason: '不是单行' };
  for (const n of numbersIn(t)) {
    if (!allowed.has(n)) return { ok: false, reason: `凭空数字 ${n}` };
  }
  return { ok: true };
}

/**
 * 蒸馏一次。未攒够 → null(不写)。否则产出画像并 `setProfile`,推进"上次蒸馏时刻"。
 * 永远返回一句可用的画像文本(模型归纳 or 模板),绝不留空。
 */
export async function distillProfile(
  deps: DistillDeps,
  req: DistillRequest,
): Promise<DistillResult | null> {
  const { store, memory, chat, log } = deps;
  const nowMs = req.nowMs ?? (deps.now ? deps.now() : Date.now());

  const sinceTs = memory.lastDistilledAt(req.cupId);
  if (!distillDue(memory, req.cupId, sinceTs, req.minNewTurns)) return null;

  const turns = memory.recentTurns(req.cupId, 200);
  const tpl = templateProfile(store, req.cupId, nowMs);

  // allow 集 = 历史轮里的数字 ∪ 日聚合事实数字(模板)—— 模型可以复述,但不得凭空
  const allowed = new Set<string>();
  for (const t of turns) collectNumbers(allowed, t.text);
  collectNumbers(allowed, tpl);

  let text = tpl;
  let source: 'llm' | 'template' = 'template';
  try {
    const turn = await chat.turn({
      system: PROFILE_DISTILL_SYSTEM,
      turns: [{ role: 'user', text: `对话记录:\n${transcript(turns)}` }],
      tools: [],
      maxTokens: 400,
    });
    const cand = (turn.text ?? '').trim();
    const check = acceptProfile(cand, allowed);
    if (check.ok) {
      text = cand;
      source = 'llm';
    } else {
      log(`画像蒸馏:守卫拦下 → 模板(${check.reason})`, 'warn');
    }
  } catch (err) {
    log(`画像蒸馏:模型不可用 → 模板(${(err as Error).message})`, 'info');
  }

  memory.setProfile(req.cupId, text);
  memory.setLastDistilledAt(req.cupId, nowMs);
  return { text, source };
}
