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
 * 分桶序列 —— 同一个形状服务两种粒度(`range` 区分):
 *   · `range=week` → 7 个**按天**桶(趋势卡)
 *   · `range=day`  → 24 个**按小时**桶(饮水曲线;补上云模式里 WS 给不全的"今天早些时候")
 * 对应 `GET /cups/:id/series?range=week|day`。
 *
 * 与 ServerToday 的分工:today 是**今天这一天**的一个汇总(看板顶部数字),
 * series 是分桶明细。二者都来自后端日聚合/事件流,**前端不重算**。
 */
export interface SeriesBucket {
  /** 展示用标签:天桶=MM-DD,时桶=HH:00(后端已排好) */
  label: string;
  /** 桶起点(天桶=本地日零点,时桶=整点) */
  ts: number;
  drank_ml: number;
  refill_ml: number;
  temp_avg_c: number | null;
  last_volume_ml: number | null;
}

export interface ServerSeries {
  cup_id: string;
  range: string;
  buckets: SeriesBucket[];
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
export function isServerSeries(v: unknown): v is ServerSeries {
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

// ── 多用户 / 市场 / 社交(产品功能;**设备协议无关**,故不入 contract)──────
//
// 这些是"登录用户 ↔ 后端"的东西,固件永远看不到 —— 与 ServerToday / ServerReport
// 同先例,留在前端数据层,不进 packages/contract。云源实现(见 cloud.ts),
// 模拟器 / mock 源没有这块(social 为 undefined),UI 据此显示空态。

/** 派生性格快照 —— 与后端 TraitRecord 同形(5 数值 + 落盘时刻);迁移码 / 好友互见共用 */
export interface TraitRecord {
  disposition: 'sulky' | 'normal' | 'smug';
  level: number;
  streak: number;
  warmth: number;
  refill_habit: number;
  updated_at: number;
}

/**
 * 登录用户的出口视图(后端绝不含 salt/hash)。
 *
 * `role` 2026-10-14 由 `user|admin` 扩成四档(服务日志端):ops 可动手(触发保留、
 * 看分区),reviewer 只读(查 + 导出)。**这是前端自身的类型** —— 与 packages/contract
 * 无关(contract 冻结不动;角色是服务端自有域)。
 */
export interface PublicUser {
  user_id: string;
  email: string;
  nickname: string;
  role: 'user' | 'admin' | 'ops' | 'reviewer';
}

// ── 服务日志端(admin/ops/reviewer 回看)───────────────────────────
// 与 B 定死的服务端契约逐字对齐(GET /admin/logs 等)。日志域是服务端自有,非契约。

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 一条落库日志 —— 与后端 `LogRow` 同形(冻结握手)。 */
export interface LogRow {
  ts: number; // unix ms
  level: LogLevel;
  src: string | null;
  msg: string;
  payload: Record<string, unknown>;
}

/** 查询条件(全部可选);`level` 可多值,`cursor` 原样回传(keyset 分页)。 */
export interface LogQuery {
  level?: LogLevel[];
  src?: string;
  q?: string;
  from?: number;
  to?: number;
  limit?: number;
  cursor?: string;
}

/** 一页日志 —— 后端回 `{logs, next_cursor}`,域内叫 `rows`(对齐内部 store 视图)。 */
export interface LogPage {
  rows: LogRow[];
  next_cursor: string | null;
}

/** 一个日志分区及其占用(运维用);`bytes` 是 `pg_total_relation_size`。 */
export interface LogPartition {
  name: string;
  bytes: number;
}

/** 管理后台的用户视图 —— 带 disabled(管理员要看出谁被禁了),仍无机密 */
export interface AdminUser extends PublicUser {
  disabled: boolean;
  created_at: number;
}

// ── 长期记忆 / 回忆(第 3 阶段)—— `GET /cups/:id/memory` ────────────
// 与后端 core/types.ts 的 MemoryCardDetails / MemoryCard 同形(冻结握手)。
// 回忆界面是这块的**唯一消费者**;数字全来自后端封存的卡,前端不重算。

/** 记忆卡里一天的点滴 —— 数值 + 当天显著事件 + 身体线索 + 对话蒸馏。 */
export interface MemoryCardDetails {
  drank_ml: number;
  goal_ml: number;
  reached: boolean;
  streak: number;
  refill_count: number;
  /** 水温区间 [最低, 最高];当天无水温 → null */
  temp_range: [number, number] | null;
  /** 当天"值得记一笔"的事件(被摔/烫/没电/倾斜/离座),按 ts 升序 */
  notable_events: { type: string; ts: number }[];
  /** 当天身体线索(与 body.ts 同源的类型→cue 映射) */
  body_cues: { cue: string; evidence: string }[];
  /** 当天对话的一两句蒸馏;当天没聊 → null */
  turns_summary: string | null;
  turn_count: number;
}

/** 一张记忆卡(按本地日存)。`date` = 'YYYY-MM-DD'。 */
export interface MemoryCard {
  cup_id: string;
  date: string;
  details: MemoryCardDetails;
  /** 后端封存时刻(ms) */
  built_at: number;
}

/** 记忆卡回看的取数参数:`all=1` 取全部有卡的日;否则最近 `recent` 天(后端钳到 366)。 */
export interface MemoryQuery {
  all?: boolean;
  recent?: number;
  /** 取前先按需补封今天那张卡(=`build=1`);幂等,那天没数据就不建空卡。 */
  buildToday?: boolean;
}

/** 守卫:REST 来的记忆卡形状不对就当没拿到,不让半截卡进回忆时间线。 */
export function isMemoryCard(v: unknown): v is MemoryCard {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  if (typeof c.date !== 'string') return false;
  const d = c.details;
  if (!d || typeof d !== 'object') return false;
  const x = d as Record<string, unknown>;
  return (
    typeof x.drank_ml === 'number' &&
    typeof x.goal_ml === 'number' &&
    typeof x.reached === 'boolean' &&
    Array.isArray(x.notable_events)
  );
}

// ── 成长 / 养成闭环(优先级 1)—— `GET /cups/:id/growth` ─────────────
// 与后端 core/growth.ts 同形(冻结握手)。数字全来自后端 recentAggs 派生,前端不重算。

/** 成长阶段(按"一起第 N 天"升阶) */
export interface GrowthStage {
  key: string;
  name: string;
  min_days: number;
}

/** 里程碑种类(每种对应一个可数的量) */
export type MilestoneKind = 'together' | 'streak' | 'achieved' | 'refill';

/** 一道里程碑(含未达成的,带进度) */
export interface Milestone {
  id: string;
  label: string;
  kind: MilestoneKind;
  threshold: number;
  /** 该种类当下的值 */
  value: number;
  achieved: boolean;
  /** 0–1,夹紧 */
  progress: number;
}

/** 成长快照(后端 `deriveGrowth` 产物)—— 一起多久 / 阶段 / 里程碑 / 今天新解锁 */
export interface Growth {
  days_together: number;
  best_streak: number;
  total_achieved_days: number;
  total_refill_days: number;
  stage: GrowthStage;
  next_stage: GrowthStage | null;
  milestones: Milestone[];
  next_milestone: Milestone | null;
  /** 今天**新解锁**的里程碑(最大的那个);没跨坎 → null */
  celebrate: Milestone | null;
}

/** 端点响应体(外层包 cup_id + today)。 */
export interface GrowthSnapshot {
  cup_id: string;
  today: string;
  growth: Growth;
}

/** 守卫:REST 来的成长快照形状不对就当没拿到。 */
export function isGrowthSnapshot(v: unknown): v is GrowthSnapshot {
  if (!v || typeof v !== 'object') return false;
  const g = (v as Record<string, unknown>).growth;
  if (!g || typeof g !== 'object') return false;
  const x = g as Record<string, unknown>;
  const stage = x.stage;
  return (
    typeof x.days_together === 'number' &&
    Array.isArray(x.milestones) &&
    !!stage &&
    typeof stage === 'object' &&
    typeof (stage as Record<string, unknown>).key === 'string'
  );
}

/** 人格档案(#72)—— `GET|PUT /cups/:id/profile` */
export interface ServerProfile {
  cup_id: string;
  nickname: string;
  traits: TraitRecord;
}

/** 支持自选模型的提供商(BYOK)—— 与后端 `CupLlmProvider` / `isCupLlmProvider` 逐字一致 */
export type CupLlmProvider = 'anthropic' | 'openai';

/**
 * 每杯模型配置的**出口视图**(BYOK)—— `GET|PUT /cups/:id/llm`。
 * **绝不含 key(明文或密文)**;只有 `has_key` 布尔,前端据此显示"已接入 / 未接入"。
 * 与后端 `CupLlmPublic` 同形(冻结握手)。
 */
export interface CupLlmPublic {
  cup_id: string;
  provider: CupLlmProvider;
  model: string;
  base_url?: string;
  has_key: boolean;
  updated_at: number;
}

/**
 * 写入体(与后端 PUT 入口形状一致)。`key` 可省 → 沿用已有密文(只改模型/端点时不逼重填);
 * `base_url` 可省 → 用 provider 默认端点。
 */
export interface CupLlmDraft {
  provider: CupLlmProvider;
  model: string;
  base_url?: string;
  key?: string;
}

export type PackStatus = 'pending' | 'approved' | 'rejected';

/** 人格市场包(UGC;#73)—— **只带数值 + 文本,不执行代码**;应用前逐项区间钳制 */
export interface PersonaPack {
  pack_id: string;
  author_user_id: string;
  name: string;
  tone: string;
  thresholds: Record<string, number>;
  wave: Record<string, number>;
  lines: string[];
  status: PackStatus;
  created_at: number;
}

/** 投稿草稿(与后端 normalizePack 的入口形状一致) */
export interface PackDraft {
  name: string;
  tone: string;
  thresholds: Record<string, number>;
  wave: Record<string, number>;
  lines: string[];
}

/**
 * 市场包里允许出现的**阈值键** —— 与后端 `PACK_THRESHOLD_KEYS` 逐字一致(冻结握手)。
 * 前端不 import 后端(跨 workspace),故这里留一份同源副本;两侧改动必须同步。
 * 语义区间在 lib/pack-apply.ts(前端最懂 mood.ts 的手感量级)。
 */
export const PACK_THRESHOLD_KEYS = [
  'REFUSE_S',
  'SMUG_S',
  'CONTENT_S',
  'IDLE_S',
  'SULK_LEVEL',
  'SULK_STREAK',
] as const;

/** 水波性格键(对齐 water.ts 的 k/c/damp);同后端 `PACK_WAVE_KEYS` */
export const PACK_WAVE_KEYS = ['k', 'c', 'damp'] as const;

/** 好友出口视图(#74)—— 好友的昵称 + 派生性格 + streak(绑了杯子才有后两者) */
export interface FriendView {
  user_id: string;
  nickname: string;
  traits: TraitRecord | null;
  streak: number | null;
}

/** 组队 streak 视图(#74)—— `GET /social/team` */
export interface TeamState {
  members: number;
  friends: number;
  streak: number;
  days: string[];
}

/**
 * 我的邀请码概览(P4.3)—— `GET /social/invite`。
 *   · invited_count 我拉来的被邀请人数(转化率分子);
 *   · invited_by    我的归属边指向的邀请人 id(可查);无 → null。
 */
export interface InviteSummary {
  invited_count: number;
  invited_by: string | null;
}

/**
 * 邀请码落地页预览(P4.3)—— `GET /social/invite/:code`(**公开,免登录**)。
 * 回邀请人的**昵称 + 一眼性格 + streak**(正是分享卡上已画着的场景);邀请人关掉
 * 可见性 / 没绑杯时 traits/streak 为 null。email / cup_id 恒不出。
 * `valid:false` = 码不存在 / 形状不合法 / 邀请人已注销。
 */
export interface InvitePreview {
  valid: boolean;
  inviter: { nickname: string; traits: TraitRecord | null; streak: number | null } | null;
}

/** 登录 / 注册结果;失败带可区分原因(与 ask 同款)与后端人话 */
export type AuthOutcome =
  | { ok: true; user: PublicUser }
  | { ok: false; reason: AskFailure; error?: string };

/**
 * 绑杯 / 解绑结果。为什么要带 error(而不是一个 boolean):
 * 可信绑定开关开时,后端对缺码/错码一律回 403 `{error:'杯子绑定凭证无效'}` ——
 * 前端要把这句**原样**显示给用户(否则用户不知道码错在哪)。boolean 会把它丢掉。
 */
export type BindOutcome = { ok: true } | { ok: false; error?: string };

/**
 * 社交 / 市场 / 管理的拉式接口(#72/#73/#74)—— 挂在 DataSource 上的**可选**面。
 *
 * 为什么用**拉**而不是 DataSourceEvents 的**推**:这些是"用户点一下才动"的
 * 行为(登录、投稿、加好友),不是杯子每秒推的遥测。照 [useChat] 处理 ask 的先例,
 * 把动作放接口、状态留组件,REST 请求在点的时候才发 —— 不为坐着不动的用户空拉轮询。
 * 只有 CloudSource 实现它;模拟器 / mock 源没有(UI 显示"需连后端")。
 */
export interface SocialApi {
  // ── 会话 ──
  me(): Promise<PublicUser | null>;
  /** 注册;`invite` 为分享卡邀请码(P4.3)—— 带上则后端记一条归属边(尽力而为,不影响注册成败)。 */
  register(email: string, password: string, nickname?: string, invite?: string): Promise<AuthOutcome>;
  login(email: string, password: string): Promise<AuthOutcome>;
  logout(): Promise<void>;
  /** 是否已有会话令牌(同步判据,给 UI 决定显示登录还是登出) */
  hasSession(): boolean;
  /** 当前会话令牌(无 → null);供读端点带 `Authorization: Bearer`(S4)。单一真源 = sessionStorage */
  getToken(): string | null;

  // ── 人格档案(#72)──
  getProfile(): Promise<ServerProfile | null>;
  saveProfile(nickname: string): Promise<ServerProfile | null>;

  // ── 长期记忆 / 回忆(第 3 阶段)── 读 /memory;删走同路由 DELETE。
  /** 取记忆卡;`q.all` 一次翻完(≤366 天),否则最近 `q.recent`(默认后端 7)。失败 → []。 */
  getMemory(q?: MemoryQuery): Promise<MemoryCard[]>;
  /**
   * 三档删除(「被遗忘权」)。scope:
   *   · conversation → 对话轮 + 长期画像(「聊过什么」)
   *   · memory       → 记忆卡 + 人格档案(「那些日子」)
   *   · all          → 一切都归零(含遥测)
   * 成功 → true。scope 由调用方给全(后端不默认、不猜测)。
   */
  deleteMemory(scope: 'conversation' | 'memory' | 'all'): Promise<boolean>;

  // ── 成长 / 养成闭环(优先级 1)── 读 /growth;纯读,无写动作。
  /** 取成长快照(阶段 / 里程碑阶梯 / 今天新解锁)。失败 → null(UI 显示空态)。 */
  getGrowth(): Promise<GrowthSnapshot | null>;

  // ── 每杯自选模型(BYOK)── 走**账号会话**(Bearer,同 /social/*),不走设备 x-api-key
  getCupLlm(): Promise<CupLlmPublic | null>;
  saveCupLlm(draft: CupLlmDraft): Promise<CupLlmPublic | null>;
  /** 取消接入(删该杯配置);无行也算成功 */
  clearCupLlm(): Promise<boolean>;

  // ── 人格市场(#73)──
  listPacks(): Promise<PersonaPack[]>;
  submitPack(draft: PackDraft): Promise<PersonaPack | null>;
  subscribePack(packId: string): Promise<boolean>;
  /** 我订过的包 id 列表(只回已上架的);失败 → []。用于市场卡片标「已订阅」。 */
  listSubscriptions(): Promise<string[]>;

  // ── 杯子当前生效包(P4.2)—— 走**账号会话 + 归属**(同 /llm),不走设备 x-api-key
  //    「订了」≠「穿着」:订阅是账号级,生效是杯级(一只杯穿一件)。
  /** 我这只杯现在穿的人格包(全文);没装 / 未登录 / 无此口 → null(= 出厂体质)。 */
  getActivePack(): Promise<PersonaPack | null>;
  /** 把某个已上架包装到这只杯;成功 → 包全文,失败 → null。 */
  setActivePack(packId: string): Promise<PersonaPack | null>;
  /** 卸下当前包 → 回默认体质;成功 → true。 */
  clearActivePack(): Promise<boolean>;

  // ── 管理后台(#73)──
  adminListUsers(): Promise<AdminUser[]>;
  adminSetDisabled(userId: string, disabled: boolean): Promise<AdminUser | null>;
  adminListPacks(status?: PackStatus): Promise<PersonaPack[]>;
  adminVerdict(packId: string, approve: boolean): Promise<PersonaPack | null>;

  // ── 服务日志端(admin/ops/reviewer 回看)──────────────────────
  // 读/admin+ops+reviewer;retain 是写动作,仅 admin+ops(reviewer 服务端 403)。
  // 失败一律归 null(照本接口"从不 reject"的既有契约;null → UI 显示"--")。
  adminListLogs(q: LogQuery): Promise<LogPage | null>;
  adminLogPartitions(): Promise<LogPartition[] | null>;
  adminRetainLogs(): Promise<string[] | null>;

  // ── 杯子社交(#74)──
  listFriends(): Promise<FriendView[]>;
  addFriend(email: string): Promise<FriendView | null>;
  /** 删好友(P4.4,G5「只能加不能删」的出口);无向边,任一方向调都清那条边;失败 → false。 */
  deleteFriend(friendUserId: string): Promise<boolean>;
  /** 我的可见性开关(P4.4);缺省 true。失败 → null(= 未知,UI 不擅自翻面)。 */
  getPrivacy(): Promise<boolean | null>;
  /** 设我的可见性开关;关掉 → 好友看我只有昵称(traits/streak 为 null)。失败 → null。 */
  setPrivacy(visible: boolean): Promise<boolean | null>;
  /** 我当前绑的杯子;没绑 / 未登录 → null */
  getBoundCup(): Promise<string | null>;
  /** 绑定杯子;可信绑定开关(--require-claim)开时,缺/错码 → {ok:false, error:'杯子绑定凭证无效'} */
  bindCup(cupId: string, claimCode?: string): Promise<BindOutcome>;
  /** 解绑我的杯子(没绑也算成功)*/
  unbindCup(): Promise<BindOutcome>;
  getTeam(): Promise<TeamState | null>;

  // ── 分享卡邀请码 / 归属边(P4.3)──
  /** 铸一枚新邀请码(POST /social/invite);失败 → null。 */
  mintInvite(): Promise<string | null>;
  /** 我的邀请概览(拉来几人 + 我由谁邀请);失败 → null。 */
  getInvite(): Promise<InviteSummary | null>;
  /** 落地页预览:某枚码的邀请人昵称(**公开,免登录**);无效码 → null。 */
  previewInvite(code: string): Promise<InvitePreview | null>;
}

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
  series: (s: ServerSeries) => void;
  /**
   * 今日 24 小时分桶(仅 CloudSource 会发)—— 饮水曲线的出口。
   * 云模式只收得到"连上之后"的 WS 事件,今天早些时候的喝水量它拿不到,
   * 故曲线改用后端这份**整天**分桶(否则曲线会少半截,与"今日已喝"自相矛盾)。
   */
  daySeries: (s: ServerSeries) => void;
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
  /**
   * 可选:多用户 / 市场 / 社交(#72/#73/#74)。只有 CloudSource 实现 ——
   * 这些能力要后端账号体系,模拟器 / mock 源没有(UI 据此显示"需连后端")。
   */
  social?: SocialApi;
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
