/**
 * 记忆卡 —— 把"一天"封存成一张可 recall 的卡（第 3 阶段）。
 *
 * 纯函数在这一层：给它那天的 `DailyAgg` + 事件 + 对话轮，产出 `MemoryCardDetails`。
 * **不做 I/O** —— 存/取由 `Store` 的两个方法负责（Memory 走 Map、Pg 走 `memory_cards` 表），
 * 于是"卡长什么样"只有一份定义，两个实现不会漂（与 `capTurns`/`windowTurns` 同款纪律）。
 *
 * 三条立场（各自有测试钉）：
 *   1. **数字全来自真实来源** —— agg 的 drank/goal/streak、事件的 type/ts、轮数，没有一处凭空。
 *      recall 把它喂回 agent 时，这些数字天然可追溯（agent.ts 对工具结果跑 collectNumbers）。
 *   2. **对话蒸馏走确定性模板**（ADR T12 主路径）—— 模型只是可选润色，此处不调模型；
 *      当天没聊 → null，绝不写空话。
 *   3. **有界** —— 事件/线索封顶，摘要截断，避免一张卡无界膨胀。
 */
import type { CupEvent } from '@cup/contract';
import type { Store } from '../store/store.ts';
import { dayKey, dayStart, shiftDay } from './day-boundary.ts';
import type { ChatStore, ChatTurnRecord } from './chat/memory.ts';
import type { DailyAgg, MemoryCard, MemoryCardDetails } from './types.ts';

/** 值得记进卡里的"身体/交互"事件类型（drink/refill 已并入数值，不重复列） */
const NOTABLE_TYPES = new Set(['shake', 'temp_alert', 'tilt_alert', 'low_battery', 'off_base']);

/** 一张卡最多记这么多条显著事件（防无界；取最早的那批，按 ts 升序） */
export const MAX_NOTABLE_EVENTS = 20;
/** 对话蒸馏摘要的字数上限 */
export const MAX_SUMMARY_CHARS = 80;

/** 事件类型 → 身体线索（与 chat/body.ts 的映射同源；drink/refill 不产线索） */
function cueOf(type: string): string | null {
  if (type === 'shake') return 'hurt';
  if (type === 'temp_alert') return 'hot';
  if (type === 'low_battery') return 'tired';
  return null;
}

/**
 * 当天对话的一两句蒸馏（确定性，不调模型）。
 * 有 user 轮 → 取**首句主人问的话**（截断）+ 轮数；只有主动开口 → 记主动那句。都没 → null。
 */
export function turnsSummary(turns: ChatTurnRecord[]): string | null {
  if (turns.length === 0) return null;
  const firstUser = turns.find((t) => t.role === 'user');
  if (firstUser) {
    const q = firstUser.text.trim().replace(/\s+/g, ' ');
    const head = q.length > MAX_SUMMARY_CHARS ? `${q.slice(0, MAX_SUMMARY_CHARS)}…` : q;
    return `主人问过「${head}」`;
  }
  const firstProactive = turns.find((t) => t.role === 'proactive');
  if (firstProactive) {
    const p = firstProactive.text.trim().replace(/\s+/g, ' ');
    const head = p.length > MAX_SUMMARY_CHARS ? `${p.slice(0, MAX_SUMMARY_CHARS)}…` : p;
    return `杯子主动说过「${head}」`;
  }
  return null;
}

/** 由当天的事实拼出一张卡的 details（纯函数，无 I/O）。 */
export function buildCardDetails(
  agg: DailyAgg,
  events: CupEvent[],
  turns: ChatTurnRecord[],
): MemoryCardDetails {
  const notable: { type: string; ts: number }[] = [];
  for (const e of events) {
    if (NOTABLE_TYPES.has(e.type)) notable.push({ type: e.type, ts: e.ts });
    if (notable.length >= MAX_NOTABLE_EVENTS) break;
  }
  notable.sort((a, b) => a.ts - b.ts);

  // 线索按 cue 去重（同一 cue 只记一次，保留最早证据）
  const seenCue = new Set<string>();
  const body_cues: { cue: string; evidence: string }[] = [];
  for (const e of notable) {
    const cue = cueOf(e.type);
    if (cue && !seenCue.has(cue)) {
      seenCue.add(cue);
      body_cues.push({ cue, evidence: `${e.type}@${e.ts}` });
    }
  }

  const temp_range: [number, number] | null =
    agg.temp_min_c !== null && agg.temp_max_c !== null ? [agg.temp_min_c, agg.temp_max_c] : null;

  return {
    drank_ml: agg.drank_ml,
    goal_ml: agg.goal_ml,
    reached: agg.goal_ml > 0 && agg.drank_ml >= agg.goal_ml,
    streak: agg.streak,
    refill_count: events.filter((e) => e.type === 'refill').length,
    temp_range,
    notable_events: notable,
    body_cues,
    turns_summary: turnsSummary(turns),
    turn_count: turns.length,
  };
}

/** 取那天落在 [dayStart, dayStart+1d) 的对话轮(给封卡用)。 */
function turnsOf(records: ChatTurnRecord[], date: string): ChatTurnRecord[] {
  const from = dayStart(date);
  const to = from + 86_400_000;
  return records.filter((t) => t.ts >= from && t.ts < to);
}

/**
 * 封存某杯**某一天**的记忆卡(幂等:同 cup+date 覆盖)。返回建好的卡。
 *
 * 数据全来自真实来源:`daily_agg` 的数值 + 那天的 `events` + 那天的对话轮。
 * **不建空卡**:那天既无事件又无对话 → 返回 null(不往库里塞"空白日")。
 *
 * 抽出来给两个调用方共用:proactive 的天翻页封昨天,HTTP 的按需补建。
 */
export async function closeDayCard(
  store: Store,
  memory: ChatStore,
  cupId: string,
  date: string,
  nowMs: number,
): Promise<MemoryCard | null> {
  const agg = await store.agg(cupId, date);
  const from = dayStart(date);
  const to = from + 86_400_000;
  const events = await store.events(cupId, from, to);
  // 记忆窗口最多 200 轮(与 ChatStore 的上限同口径),再按日切
  const turns = turnsOf(await memory.recentTurns(cupId, 200), date);
  if ((!agg || agg.event_count === 0) && turns.length === 0) return null;

  const details = buildCardDetails(
    agg ?? emptyAggFor(cupId, date, await store.goal(cupId)),
    events,
    turns,
  );
  const card: MemoryCard = { cup_id: cupId, date, details, built_at: nowMs };
  await store.putMemoryCard(card);
  return card;
}

/** 那天没行时用当前 goal 造一个空 agg(与 recentAggs 的补空口径一致)。 */
function emptyAggFor(cupId: string, date: string, goalMl: number): DailyAgg {
  return {
    cup_id: cupId,
    date,
    drank_ml: 0,
    refill_ml: 0,
    drink_count: 0,
    goal_ml: goalMl,
    temp_min_c: null,
    temp_max_c: null,
    temp_avg_c: null,
    last_volume_ml: null,
    streak: 0,
    event_count: 0,
    updated_at: 0,
  };
}

/**
 * 天翻页:若"今天"已经不是 `lastClosedDay`,封存**昨天**那张卡,返回新的 lastClosedDay。
 *
 * 为什么要 lastClosedDay 状态:`tick` 每分钟一次,天只在 00:00 翻一次 —— 用这个水位
 * 免得同一张卡被反复 UPSERT(幂等没问题,但没必要每次巡检都重算)。
 * **迟/重 tick 都安全**:封的是"昨天"这个确定的日子,与 tick 时刻无关。
 */
export async function maybeCloseDay(
  store: Store,
  memory: ChatStore,
  cupId: string,
  nowMs: number,
  lastClosedDay: string | null,
): Promise<string> {
  const today = dayKey(nowMs);
  if (lastClosedDay === today) return today;
  const yesterday = shiftDay(today, -1);
  await closeDayCard(store, memory, cupId, yesterday, nowMs);
  return today;
}
