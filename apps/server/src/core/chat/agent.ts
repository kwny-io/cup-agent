/**
 * 对话循环 —— 有界的"模型 ↔ 工具"往返。
 *
 * 流程:
 *   user 问题 ──► [模型轮] ──► 有工具调用? ──► 分发(白名单+校验+写预算) ──► 结果回喂
 *                     ▲                                    │
 *                     └────────────────────────────────────┘(至多 MAX_TURNS 轮)
 *                              无工具调用 ──► 数字守卫 ──► 通过则采用,否则确定性回退
 *
 * 三条不变量(全部对应 M4 的立场,ADR T12):
 *   1. **数字只能来自工具** —— guard.ts 的 allow 集合 = 工具结果 ∪ 用户问题 ∪ 召回历史
 *   2. **不可信参数收口** —— 模型给的 input 一律走 tools.ts 的 parse;未知工具名 → {ok:false},不抛
 *   3. **写预算** —— 每次对话至多一次写;写后从可用工具里摘掉写工具,再写被拒
 *
 * 失败永远回退到"用真实数据拼的一句"(never 空泡)。
 */
import type { Store } from '../../store/store.ts';
import type { CommandQueue } from '../commands.ts';
import type { ChatAnswer, ChatLlm, ChatTurn, LogFn, ToolSpec } from './types.ts';
import { getTool, toolSpecs, type ToolCtx, type ToolResult } from './tools.ts';
import { collectNumbers, grounded } from './guard.ts';
import { CHAT_SYSTEM, PROACTIVE_PROMPT } from './prompt.ts';
import { MAX_PROFILE_CHARS, type ChatStore, type ChatTurnRecord } from './memory.ts';

export const MAX_TURNS = 6;
/** 每次召回多少轮历史进提示词 */
const RECALL_TURNS = 12;

export interface ChatDeps {
  store: Store;
  commands: CommandQueue;
  chat: ChatLlm;
  memory: ChatStore;
  log: LogFn;
  now?: () => number;
}

export interface ChatRequest {
  cupId: string;
  question: string;
  /** 主动开口(true 时记 role:'proactive') */
  proactive?: boolean;
}

/** 把召回的历史轮转成模型可读的 ChatTurn(只回放 user/assistant,不回放工具轮) */
function historyToTurns(records: ChatTurnRecord[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const r of records) {
    if (r.role === 'user') turns.push({ role: 'user', text: r.text });
    else turns.push({ role: 'assistant', text: r.text, toolCalls: [] });
  }
  return turns;
}

/** 画像按字节封顶(与历史召回同款"有界"),并丢弃空/全空白 */
function boundedProfile(text: string | null): string | null {
  if (!text) return null;
  const t = text.trim();
  if (t.length === 0) return null;
  return t.length > MAX_PROFILE_CHARS ? t.slice(0, MAX_PROFILE_CHARS) : t;
}

/**
 * 组装系统提示。
 *   基础人设(CHAT_SYSTEM)常驻;主动开口时**追加** PROACTIVE_PROMPT(不替换 ——
 *   傲娇铁律仍要管住主动那句);有长期画像时再追加一段"你记得的事"。
 */
function systemPrompt(req: ChatRequest, profile: string | null): string {
  const parts = [CHAT_SYSTEM];
  if (req.proactive) parts.push(PROACTIVE_PROMPT);
  if (profile) parts.push(`关于这位主人,你长期记得这些(不要凭空改数字,别生硬背诵):\n${profile}`);
  return parts.join('\n\n');
}

export async function runChat(deps: ChatDeps, req: ChatRequest): Promise<ChatAnswer> {
  const now = deps.now ?? (() => Date.now());
  const ctx: ToolCtx = { store: deps.store, commands: deps.commands, now };

  const history = await deps.memory.recentTurns(req.cupId, RECALL_TURNS);
  const profile = boundedProfile(await deps.memory.profile(req.cupId));

  // 数字守卫的 allow 集合:用户问题、历史、长期画像里的数字先天可信(工具结果边跑边并入)
  const allowed = new Set<string>();
  collectNumbers(allowed, req.question);
  for (const h of history) collectNumbers(allowed, h.text);
  // 画像必须并入 —— 否则模型复述画像里的数字会被判"凭空数字" → 整段高质量回复被丢弃回退
  if (profile) collectNumbers(allowed, profile);

  const toolsUsed: string[] = [];
  let wrote = false;

  const turns: ChatTurn[] = historyToTurns(history);
  turns.push({ role: 'user', text: req.question });

  for (let i = 0; i < MAX_TURNS; i++) {
    let modelTurn;
    try {
      modelTurn = await deps.chat.turn({ system: systemPrompt(req, profile), turns, tools: availableTools(wrote) });
    } catch (err) {
      deps.log(`chat: 模型调用失败 → 回退(${(err as Error).message})`, 'warn');
      return await fallback(deps, ctx, req, toolsUsed, i);
    }

    const calls = modelTurn.toolCalls ?? [];
    if (calls.length === 0) {
      const text = (modelTurn.text ?? '').trim();
      const check = grounded(text, allowed);
      if (check.ok) {
        await record(deps, req, text, 'llm', toolsUsed);
        return { text, source: 'llm', tools_used: toolsUsed, turns: i + 1 };
      }
      deps.log(`chat: 守卫拦下 → 回退(${check.reason})`, 'warn');
      return await fallback(deps, ctx, req, toolsUsed, i);
    }

    turns.push({ role: 'assistant', text: modelTurn.text ?? '', toolCalls: calls });

    for (const call of calls) {
      const result = await dispatch(ctx, req.cupId, call.name, call.input, wrote);
      if (result.ok && getTool(call.name)?.isWrite) wrote = true;
      if (!toolsUsed.includes(call.name)) toolsUsed.push(call.name);

      const out = result.ok ? result.output : { error: result.error };
      collectNumbers(allowed, JSON.stringify(out));
      turns.push({ role: 'tool', callId: call.id, name: call.name, output: out, ok: result.ok });
    }
  }

  deps.log(`chat: 达到 ${MAX_TURNS} 轮上限 → 回退`, 'warn');
  return await fallback(deps, ctx, req, toolsUsed, MAX_TURNS);
}

/** 可用工具:写过之后摘掉写工具(写预算的"摘"这一半) */
function availableTools(wrote: boolean): ToolSpec[] {
  const all = toolSpecs();
  if (!wrote) return all;
  return all.filter((t) => !getTool(t.name)?.isWrite);
}

/**
 * 分发一次工具调用 —— **不可信参数的唯一收口**。
 * 未知工具名 → {ok:false}(不抛、不调);参数校验失败 → {ok:false};写预算耗尽 → {ok:false}。
 */
export async function dispatch(
  ctx: ToolCtx,
  cupId: string,
  name: string,
  input: unknown,
  wrote: boolean,
): Promise<ToolResult> {
  const tool = getTool(name);
  if (!tool) return { ok: false, output: null, error: `未知工具 ${name}` };
  if (tool.isWrite && wrote) return { ok: false, output: null, error: '每次对话只允许一次写入' };
  const parsed = tool.parse(input);
  if (parsed === null) return { ok: false, output: null, error: '参数不合法' };
  return await tool.run(ctx, cupId, parsed);
}

/** 用真实数据拼一句确定性答复(守卫拦下 / 超时 / 出错 / 轮次用尽 的兜底) */
async function fallback(
  deps: ChatDeps,
  ctx: ToolCtx,
  req: ChatRequest,
  toolsUsed: string[],
  turns: number,
): Promise<ChatAnswer> {
  const out = (await getTool('get_today')!.run(ctx, req.cupId, {})).output;
  const text = buildFallback(out);
  await record(deps, req, text, 'fallback', toolsUsed);
  return { text, source: 'fallback', tools_used: toolsUsed, turns };
}

/** 模板句 —— 数字直接来自 get_today 的产出,与 report.ts 的措辞家族一致 */
function buildFallback(out: unknown): string {
  const f = out as {
    drank_ml: number;
    goal_ml: number;
    remaining_ml: number;
    drink_count: number;
    reached_goal: boolean;
  };
  if (f.drink_count === 0) return '今天一口都没喝呢……杯子在角落里盯着你。';
  if (f.reached_goal) return `喝了 ${f.drank_ml}ml,达标了——哼,也就还行吧。`;
  return `才 ${f.drank_ml}ml(目标 ${f.goal_ml}),还差 ${f.remaining_ml}ml,再冲一冲?`;
}

/** 记入记忆(非主动时补一条 user 轮,再记助手轮) */
async function record(
  deps: ChatDeps,
  req: ChatRequest,
  answer: string,
  source: 'llm' | 'fallback',
  toolsUsed: string[],
): Promise<void> {
  const now = (deps.now ?? (() => Date.now()))();
  if (!req.proactive) {
    await deps.memory.appendTurn({ cup_id: req.cupId, ts: now, role: 'user', text: req.question });
  }
  await deps.memory.appendTurn({
    cup_id: req.cupId,
    ts: now,
    role: req.proactive ? 'proactive' : 'assistant',
    text: answer,
    tools_used: toolsUsed.length ? toolsUsed.slice() : undefined,
    source,
  });
}
