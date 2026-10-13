/**
 * 「回忆」的纯函数 —— 把后端封存的记忆卡加工成展示层要的几组视图。
 *
 * 分工与 lib/history.ts / lib/mood-history.ts 一致:**逻辑在这层、渲染在组件层**,
 * 于是"那年今日怎么挑、一起第几天怎么算、哪些事件叫得出名字"都能直接单测。
 * 数字全来自后端卡(`MemoryCard.details`),前端只做**筛选 / 换算 / 起名**,不重算数值。
 *
 * 日期一律走**字符串键 `YYYY-MM-DD`**(与后端 dayKey 同口径,浏览器本地日),
 * 不用 `new Date('YYYY-MM-DD')` —— 那会按 UTC 解析,东八区会错一天。
 */
import type { MemoryCard, MemoryCardDetails } from '../data/source.ts';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** 一天 = 86400_000ms(只用于按日键做整数天差;两端都按本地日 0 点构造,不受 DST 影响) */
const DAY_MS = 86_400_000;

/** 本地日键 `YYYY-MM-DD`(与后端 dayKey 同口径,浏览器本地时区) */
export function localDayKey(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 把日键按本地日 0 点解成 epoch ms;形状不对 → null(不编) */
function dayMs(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/**
 * `date` 距 `today` 多少天(过去为正、今天为 0、未来为负)。任一形状不对 → null。
 * 按本地日 0 点相减再取整,避免本地时区 / 夏令时的毫秒级偏差。
 */
export function daysBetween(date: string, today: string): number | null {
  const a = dayMs(date);
  const b = dayMs(today);
  if (a === null || b === null) return null;
  return Math.round((b - a) / DAY_MS);
}

/** 展示标签 `M月D日 周X`(整卡标题用);形状不对 → 原样 */
export function memoryDateLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const wd = WEEKDAYS[new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay()] ?? '';
  return `${Number(m[2])}月${Number(m[3])}日 周${wd}`;
}

/**
 * 「一起第 N 天」—— 最早那张卡到今天(含今天)过了几天,加 1。
 * 没有卡 / 形键不对 → null(还没开始一起,不编一个 N)。
 */
export function daysTogether(cards: MemoryCard[], today: string): number | null {
  if (cards.length === 0) return null;
  const earliest = cards.reduce((min, c) => (c.date < min ? c.date : min), cards[0]!.date);
  const n = daysBetween(earliest, today);
  if (n === null) return null;
  return n + 1;
}

/**
 * 连续在场天数 —— 从 `today` 起往前数,有多少个连续日**有卡**。
 * 今天还没封卡(当天还没喝/没聊)时不算断,从昨天接着数。
 * 无卡 → 0。
 */
export function currentCardStreak(cards: MemoryCard[], today: string): number {
  const have = new Set(cards.map((c) => c.date));
  let cursor = today;
  if (!have.has(cursor)) {
    // 今天没卡:从昨天起算(今天可以还没封,不算断)
    const d = dayMs(today);
    if (d === null) return 0;
    cursor = localDayKey(new Date(d - DAY_MS));
  }
  let n = 0;
  while (have.has(cursor)) {
    n++;
    const d = dayMs(cursor);
    if (d === null) break;
    cursor = localDayKey(new Date(d - DAY_MS));
  }
  return n;
}

/**
 * 「那年今日」—— `today` 的同月同日、但在**过去某一年**封存的卡(不含今年)。
 * 一年只可能一张(按本地日唯一),故取最新那张;没有 → null。
 */
export function onThisDay(cards: MemoryCard[], today: string): MemoryCard | null {
  const mmdd = today.slice(5); // 'MM-DD'
  let hit: MemoryCard | null = null;
  for (const c of cards) {
    if (c.date === today) continue; // 今天不算"那年今日"
    if (c.date.slice(5) === mmdd && (hit === null || c.date > hit.date)) hit = c;
  }
  return hit;
}

// ── 日子起名(纯文案,不造数)─────────────────────────────────────

/**
 * 一张卡的一句话标题 —— 只描述**卡里已有什么**,不编情绪。
 * 优先级:达标 > 有显著事件 > 有对话 > 有记录。都没 → 泛称。
 */
export function cardTitle(card: MemoryCard): string {
  const d = card.details;
  if (d.reached) return '达标的一天';
  if (d.notable_events.length > 0) return '有事发生的一天';
  if (d.turns_summary) return '聊过天的一天';
  if (d.drank_ml > 0) return '喝过水的一天';
  return '平平淡淡的一天';
}

const EVENT_CN: Record<string, string> = {
  shake: '被摇了一下',
  temp_alert: '水温烫了',
  tilt_alert: '被碰歪了',
  low_battery: '快没电了',
  off_base: '离开了底座',
};

/** 显著事件类型 → 人话(未知类型原样回,不吞) */
export function eventLabel(type: string): string {
  return EVENT_CN[type] ?? type;
}

const CUE_CN: Record<string, string> = {
  hurt: '受了点惊',
  hot: '被烫到',
  tired: '有点累',
};

/** 身体线索 → 人话(未知原样回) */
export function cueLabel(cue: string): string {
  return CUE_CN[cue] ?? cue;
}

/** 一条卡上要显示的一行摘要 —— 给时间线用,一行说清"那天怎么样" */
export function cardSummary(card: MemoryCard): string {
  const d = card.details;
  const parts: string[] = [`喝了 ${Math.round(d.drank_ml)}ml`];
  if (d.goal_ml > 0) parts.push(`目标 ${Math.round(d.goal_ml)}ml`);
  if (d.streak > 0) parts.push(`连 ${d.streak} 天`);
  return parts.join(' · ');
}

// ── 回忆录(导出用的行模型;与 card-render 的 CardModel 同分工)────

export interface MemoirLine {
  date: string;
  label: string;
  title: string;
  detail: string;
}

/**
 * 把(新→旧的)卡片整成回忆录行 —— 每行一天:日期标签 / 一句话标题 / 细节。
 * 有对话蒸馏就带上(那是"关系"的痕迹);数值细节由 `memoirDetail` 拼。
 */
export function buildMemoirLines(cards: MemoryCard[]): MemoirLine[] {
  return [...cards]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)) // 新→旧
    .map((c) => ({
      date: c.date,
      label: memoryDateLabel(c.date),
      title: cardTitle(c),
      detail: memoirDetail(c.details),
    }));
}

/** 回忆录每行的细节串:数值 + (若有)对话蒸馏 */
export function memoirDetail(d: MemoryCardDetails): string {
  const bits = [`${Math.round(d.drank_ml)}/${Math.round(d.goal_ml)}ml`];
  if (d.notable_events.length > 0) {
    bits.push(d.notable_events.map((e) => eventLabel(e.type)).join('、'));
  }
  if (d.turns_summary) bits.push(d.turns_summary);
  return bits.join(' · ');
}
