/**
 * 数据源抽象 —— 前端只依赖这个接口,不关心数据从哪来。
 *
 * 对应架构 §6.3。实现:
 *   SimulatorSource  连模拟器 WebSocket   ← 当前(M2/M3)
 *   CloudSource      连后端 WebSocket     ← 以后(M1 之后)
 *   BluetoothSource  Web Bluetooth 直连    ← 桌面端可选
 *
 * CupWidget / Dashboard 只 import 这个文件,换源不改画面。
 */
import type { BaseTelemetry, CupEvent, LidTelemetry } from '@cup/contract';

/** 一次更新(模拟器一帧 = 一条或多条消息) */
export interface LiveFrame {
  lid?: LidTelemetry;
  base?: BaseTelemetry;
  events: CupEvent[];
}

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'error';

/**
 * 后端算好的"今日概览" —— 对应 `GET /cups/:id/today`。
 *
 * 为什么单独一件事:今日已喝 / 次数 / 水温区间 / 连续天数 是**跨天聚合**,
 * 单靠 WS 推的实时遥测算不出来(比如"连续达标 7 天"要翻历史)。
 * 所以云源是**混合**的:实时走 WS,聚合数字走这个 REST 快照。
 */
export interface ServerToday {
  cup_id: string;
  date: string;
  drank_ml: number;
  goal_ml: number;
  drink_count: number;
  progress: number;
  temp_min_c: number | null;
  temp_max_c: number | null;
  temp_avg_c: number | null;
  streak: number;
  current_volume_ml: number | null;
  current_temp_c: number | null;
}

/**
 * 后端每日战报 —— 对应 `GET /cups/:id/report/latest`(M4)。
 *
 * 关键约定(见 apps/server core/report.ts):
 *   · headline 是**成品文案**,前端原样显示,不再自己拼
 *   · facts 是数字骨架,**唯一数字来源**(LLM 只润语气,不改数字)
 *   · disposition 是**长期性格**,喂给杯子的底色(与秒级 Mood 叠加)
 *   · source 让前端知道走的是模板还是 LLM(便于调试/展示)
 */
export interface ServerReport {
  cup_id?: string;
  date: string;
  disposition: 'sulky' | 'normal' | 'smug';
  mood_line: string;
  headline: string;
  facts: {
    date: string;
    drank_ml: number;
    goal_ml: number;
    progress: number;
    drink_count: number;
    temp_min_c: number | null;
    temp_max_c: number | null;
    streak: number;
    reached_goal: boolean;
  };
  source: 'template' | 'llm';
  generated_at: number;
}

/**
 * 对话问答 —— 对应 `POST /cups/:cupId/ask`(P4)。
 *
 * 冻结接口(见 apps/web/CHAT-HANDOFF.md,双方不得单方改):
 *   body { q: string } → 200 { cup_id: string, answer: ChatAnswer }
 * text 是**成品答复**,前端原样显示(与战报 headline 同一约定);
 * source 区分 LLM 还是模板兜底;turns 是对话轮次(后端用来控上下文)。
 */
export interface ChatAnswer {
  text: string;
  source: 'llm' | 'fallback';
  tools_used: string[];
  turns: number;
}

/**
 * 杯子主动搭话 —— WS `/cups/:id/live` 新帧 {kind:'proactive'} 的 payload。
 *
 * 与战报(一天一句、走 REST)不同:这是**随时插话**(喝水提醒、被冷落抱怨…),
 * 走 WS 实时推。facts 是后端给的事实骨架,前端只读不拼。
 */
export interface ProactiveMessage {
  text: string;
  ts: number;
  source: 'llm' | 'fallback';
  facts: Record<string, unknown>;
}

/**
 * 近 N 天趋势 —— 对应 `GET /cups/:id/series?range=week`(后端已返回 7 桶)。
 *
 * 与 ServerToday 的分工:today 是**今天这一天**的聚合(看板顶部数字),
 * series 是**若干天**的分桶(趋势卡)。二者都来自后端日聚合,前端不重算。
 */
export interface WeekBucket {
  /** 展示用日期标签,后端已裁成 MM-DD */
  label: string;
  /** 桶起点(本地日零点) */
  ts: number;
  drank_ml: number;
  refill_ml: number;
  temp_avg_c: number | null;
  last_volume_ml: number | null;
}

export interface WeekSeries {
  cup_id: string;
  range: string;
  buckets: WeekBucket[];
}

/**
 * 历史战报某一天 —— 对应 `GET /cups/:id/report/history` 的 days 元素。
 *
 * 与今日战报(report/latest)的分工:那是一条**当下**的战报(带长期性格、可被 LLM 润色),
 * 这里是**逐日回看**:后端只回**有数据的日子**(没喝的日子不占位),新→旧,
 * 每天一句模板 headline(由后端给,数字恒来自日聚合)。前端只读,不再自己拼文案。
 */
export interface HistoryDay {
  date: string;
  drank_ml: number;
  goal_ml: number;
  progress: number;
  drink_count: number;
  temp_min_c: number | null;
  temp_max_c: number | null;
  streak: number;
  reached_goal: boolean;
  /** 后端给的当天一句话(模板),前端原样显示 */
  headline: string;
}

export interface ServerHistory {
  cup_id: string;
  /** 新→旧(最近在前) */
  days: HistoryDay[];
  count: number;
}

/**
 * 脾气变化史某一天 —— 对应 `GET /cups/:id/personality/history` 的 days 元素。
 *
 * 与 HistoryDay 的分工:那个是**逐日喝水量**(drank_ml/goal_ml/headline);
 * 这个是**逐日长期性格**回放(那天杯子是什么脾气)。
 */
export interface DispositionDay {
  date: string;
  disposition: 'sulky' | 'normal' | 'smug';
  /** 那天是否达标(供上色,前端不必自己比 drank/goal) */
  reached_goal: boolean;
}

/**
 * 脾气变化史 —— 对应 `GET /cups/:id/personality/history`(创意备忘 §5.1 #3 养成卡的只读半)。
 *
 * 与 ServerHistory 的排序相反:这个是**旧→新**(时间线从左到右,给"脾气怎么变的"用),
 * 后端只回**有数据的日子**(没喝的日历日不占位)。
 */
export interface ServerPersonalityHistory {
  cup_id: string;
  /** 旧→新(最早在前) */
  days: DispositionDay[];
  count: number;
}

/** 守卫:REST 来的 history 形状不对就当没拿到,不让半截对象进列表 */
export function isServerHistory(v: unknown): v is ServerHistory {
  if (!v || typeof v !== 'object') return false;
  const h = v as Record<string, unknown>;
  if (!Array.isArray(h.days)) return false;
  return h.days.every((d) => {
    if (!d || typeof d !== 'object') return false;
    const x = d as Record<string, unknown>;
    return (
      typeof x.date === 'string' &&
      typeof x.drank_ml === 'number' &&
      typeof x.headline === 'string'
    );
  });
}

/** 守卫:REST 来的 personality/history 形状不对就当没拿到,不让半截对象进时间线 */
export function isServerPersonalityHistory(v: unknown): v is ServerPersonalityHistory {
  if (!v || typeof v !== 'object') return false;
  const h = v as Record<string, unknown>;
  if (!Array.isArray(h.days)) return false;
  return h.days.every((d) => {
    if (!d || typeof d !== 'object') return false;
    const x = d as Record<string, unknown>;
    return (
      typeof x.date === 'string' &&
      (x.disposition === 'sulky' || x.disposition === 'normal' || x.disposition === 'smug')
    );
  });
}

/** 守卫:REST 来的 series 形状不对(没 buckets)就当没拿到,不让半截对象进 SVG */
export function isWeekSeries(v: unknown): v is WeekSeries {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  if (!Array.isArray(s.buckets)) return false;
  return s.buckets.every((b) => {
    if (!b || typeof b !== 'object') return false;
    const x = b as Record<string, unknown>;
    return typeof x.label === 'string' && typeof x.ts === 'number' && typeof x.drank_ml === 'number';
  });
}

/** 守卫:WS 来的 proactive payload 形状不对就静默丢(与 telemetry 同策略) */
export function isProactiveMessage(v: unknown): v is ProactiveMessage {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.text === 'string' &&
    typeof m.ts === 'number' &&
    (m.source === 'llm' || m.source === 'fallback')
  );
}

/** 守卫:/ask 的 answer 形状不对就当"没答上",不把半截对象塞进 UI */
export function isChatAnswer(v: unknown): v is ChatAnswer {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.text === 'string' &&
    (a.source === 'llm' || a.source === 'fallback') &&
    Array.isArray(a.tools_used) &&
    typeof a.turns === 'number'
  );
}

/**
 * 问答失败的原因 —— 让 UI 分得清"没连上 / 超时 / 后端报错 / 答非所问",
 * 而不是一律"没答上"(排障时那个区分很关键)。
 */
export type AskFailure = 'offline' | 'timeout' | 'error' | 'invalid';

/** 问答结果:成功带 answer,失败带可区分的原因;契约上**从不 reject** */
export type AskResult =
  | { ok: true; answer: ChatAnswer }
  | { ok: false; reason: AskFailure };

/** 问杯子的实现(仅能问答的源有) */
export type AskFn = (q: string) => Promise<AskResult>;

/**
 * 改每日目标的结果 —— 对应 `PUT /cups/:id/goal`(体 { goal_ml })。
 * 成功带**后端确认的**目标值(以后端为准,避免前端乐观值落后端一步);
 * 失败带可区分原因(与 ask 同款:offline/timeout/error/invalid)。
 * 契约:**从不 reject**,调用方一条路径处理。
 */
export type GoalResult =
  | { ok: true; goalMl: number }
  | { ok: false; reason: AskFailure };

/** 改目标的实现(云 / mock 源都有;纯模拟器源没有) */
export type SetGoalFn = (goalMl: number) => Promise<GoalResult>;

export interface DataSourceEvents {
  frame: (f: LiveFrame) => void;
  state: (s: ConnectionState) => void;
  /** 后端今日快照(仅 CloudSource 会发);无此源时组件继续用前端现算 */
  server: (today: ServerToday) => void;
  /** 后端每日战报(仅 CloudSource 会发)—— 文案与长期性格的出口(M4) */
  report: (r: ServerReport) => void;
  /** 杯子主动搭话(仅 CloudSource 会发)—— 对话线的实时插话出口(P4) */
  proactive: (m: ProactiveMessage) => void;
  /** 近 7 天趋势(仅 CloudSource 会发)—— 趋势卡的出口;无此源时卡片显示空态 */
  series: (s: WeekSeries) => void;
  /** 历史战报(仅 CloudSource 会发)—— 逐日回看卡的出口;无此源时卡片显示空态 */
  history: (h: ServerHistory) => void;
  /** 脾气变化史(仅 CloudSource 会发)—— 养成卡的出口;无此源时卡片显示空态 */
  personality: (p: ServerPersonalityHistory) => void;
}

export interface DataSource {
  readonly kind: string;
  connect(): void;
  disconnect(): void;
  on<K extends keyof DataSourceEvents>(evt: K, cb: DataSourceEvents[K]): () => void;
  /**
   * 可选:能问答的源(CloudSource / MockSource)才实现。
   * 放在接口上(而非调用处强转)是为了让编译器帮忙 —— 不支持问答的源
   * 用 ask 会在编译期就报错,而不是运行期静默失败。
   */
  ask?(q: string): Promise<AskResult>;
  /**
   * 可选:能改每日目标的源(CloudSource 走 PUT /goal;MockSource 存本地)。
   * 与 ask 同理由放在接口上 —— 不支持写目标的源(纯模拟器)在编译期就被挡住。
   */
  setGoal?(goalMl: number): Promise<GoalResult>;
}

/** 极简事件发射器,避免引入依赖 */
export class Emitter {
  private map = new Map<string, Set<(...args: never[]) => void>>();

  on<K extends keyof DataSourceEvents>(evt: K, cb: DataSourceEvents[K]): () => void {
    let set = this.map.get(evt as string);
    if (!set) {
      set = new Set();
      this.map.set(evt as string, set);
    }
    set.add(cb as (...args: never[]) => void);
    return () => set!.delete(cb as (...args: never[]) => void);
  }

  emit<K extends keyof DataSourceEvents>(
    evt: K,
    ...args: Parameters<DataSourceEvents[K]>
  ): void {
    const set = this.map.get(evt as string);
    if (!set) return;
    for (const cb of set) (cb as (...a: unknown[]) => void)(...args);
  }
}
