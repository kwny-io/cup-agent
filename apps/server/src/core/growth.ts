/**
 * 成长层 —— 把"一起走了多久、走了多远"派生成可展示的**成长快照**(养成闭环,优先级 1)。
 *
 * 纯函数:输入近期日聚合(旧→新),输出阶段 / 里程碑阶梯 / 下一次还差多少 / 今天新解锁了什么。
 * **不做 I/O、不落盘、不新增 store 方法** —— 与 personality.ts / memory-cards.ts 同款纪律:
 * 数据全来自已有 `recentAggs`(数值 + streak),这里只做**换算与起名**,不重算事实。
 *
 * 为什么要它:此前杯子只有"今天的脾气"(personality),没有"我们走了多远"——
 * 用户看不到任何**跨天的成长反馈**。这层补的正是这个可见闭环:阶段在升、里程碑在解锁。
 *
 * 与 /report、/profile 的关系:那些是**当下状态**;这层是**随时间累积的进度**,
 * 天然要更长的窗口(见 http.ts 的 GROWTH_DAYS)。
 */
import type { DailyAgg } from './types.ts';

/** 成长阶段 —— 按"一起第几天"升阶(名字是给用户看的,不参与计算) */
export interface GrowthStage {
  key: string;
  name: string;
  /** 进入这一阶段所需的最少"一起的天数" */
  min_days: number;
}

/** 阶段阶梯(升序;`min_days` 必须严格递增) */
export const STAGES: GrowthStage[] = [
  { key: 'newborn', name: '新生', min_days: 0 },
  { key: 'sprout', name: '幼芽', min_days: 3 },
  { key: 'growing', name: '成长期', min_days: 7 },
  { key: 'steady', name: '稳当', min_days: 30 },
  { key: 'companion', name: '老友', min_days: 100 },
  { key: 'legend', name: '传奇', min_days: 365 },
];

/** 里程碑的种类 —— 每种对应一个可数的量(见 `statsOf`) */
export type MilestoneKind = 'together' | 'streak' | 'achieved' | 'refill';

export interface Milestone {
  id: string;
  label: string;
  kind: MilestoneKind;
  threshold: number;
  /** 该种类当下的值(用于算进度 / 展示"还差多少") */
  value: number;
  achieved: boolean;
  /** 0–1,夹紧 */
  progress: number;
}

/** 里程碑定义(阶梯;顺序即展示顺序,升序闸门保证阶梯感) */
const MILESTONES: { id: string; label: string; kind: MilestoneKind; threshold: number }[] = [
  { id: 'first_drop', label: '第一口水', kind: 'achieved', threshold: 1 },
  { id: 'together_3', label: '一起 3 天', kind: 'together', threshold: 3 },
  { id: 'streak_3', label: '连续达标 3 天', kind: 'streak', threshold: 3 },
  { id: 'together_7', label: '一起一周', kind: 'together', threshold: 7 },
  { id: 'achieved_7', label: '累计达标 7 天', kind: 'achieved', threshold: 7 },
  { id: 'refill_7', label: '续杯 7 天', kind: 'refill', threshold: 7 },
  { id: 'streak_14', label: '连续达标两周', kind: 'streak', threshold: 14 },
  { id: 'together_30', label: '一起满月', kind: 'together', threshold: 30 },
  { id: 'achieved_30', label: '累计达标 30 天', kind: 'achieved', threshold: 30 },
  { id: 'together_100', label: '一起 100 天', kind: 'together', threshold: 100 },
  { id: 'together_365', label: '一起一年', kind: 'together', threshold: 365 },
];

/** 从日聚合里数出来的"四个可数量" —— 里程碑都建在它们之上 */
export interface GrowthStats {
  /** 一起第 N 天(最早"有活动"的那天到今天,含今天);全程无活动 → 0 */
  days_together: number;
  /** 历史最长连续达标(日聚合的 streak 是"截至那天"的连击,取最大即历史最长) */
  best_streak: number;
  /** 累计达标天数 */
  total_achieved_days: number;
  /** 续过杯的天数 */
  total_refill_days: number;
}

export interface Growth extends GrowthStats {
  stage: GrowthStage;
  /** 下一阶段(顶级阶段 → null) */
  next_stage: GrowthStage | null;
  /** 里程碑阶梯(含未达成的,带进度) */
  milestones: Milestone[];
  /** 第一个未达成(给"下一次还差多少") */
  next_milestone: Milestone | null;
  /**
   * 今天**新解锁**的里程碑(最大的那个)—— 由"去掉最后一天再算一遍"推出:
   * 昨天还没达成、今天达成了的,就是今天新解锁的。给前端一次性庆祝 / 固件点灯用。
   */
  celebrate: Milestone | null;
}

/** 那天算不算"有活动"(喝过 / 续过 / 有过事件) */
function isActive(d: DailyAgg): boolean {
  return d.event_count > 0 || d.drank_ml > 0 || d.refill_ml > 0;
}

function reached(d: DailyAgg): boolean {
  return d.goal_ml > 0 && d.drank_ml >= d.goal_ml;
}

/**
 * 从窗口(旧→新)数出四个量。
 * `days_together` 依赖窗口覆盖到最早的活动日 —— 调用方取足够长的窗口(见 GROWTH_DAYS)。
 */
export function statsOf(recent: DailyAgg[]): GrowthStats {
  let firstActive = -1;
  let bestStreak = 0;
  let achieved = 0;
  let refilled = 0;
  for (let i = 0; i < recent.length; i++) {
    const d = recent[i]!;
    if (isActive(d) && firstActive < 0) firstActive = i;
    if (d.streak > bestStreak) bestStreak = d.streak;
    if (reached(d)) achieved += 1;
    if (d.refill_ml > 0) refilled += 1;
  }
  const lastIdx = recent.length - 1;
  const days_together = firstActive < 0 ? 0 : lastIdx - firstActive + 1;
  return {
    days_together,
    best_streak: bestStreak,
    total_achieved_days: achieved,
    total_refill_days: refilled,
  };
}

/** 某种类当下的值 */
function valueOf(kind: MilestoneKind, s: GrowthStats): number {
  if (kind === 'together') return s.days_together;
  if (kind === 'streak') return s.best_streak;
  if (kind === 'achieved') return s.total_achieved_days;
  return s.total_refill_days;
}

/** 阶段阶梯:取 `days_together` 落在的最高阶段 */
export function stageFor(daysTogether: number): GrowthStage {
  let cur = STAGES[0]!;
  for (const st of STAGES) if (daysTogether >= st.min_days) cur = st;
  return cur;
}

/** 下一阶段(没有 → null) */
export function nextStageFor(stage: GrowthStage): GrowthStage | null {
  const i = STAGES.findIndex((s) => s.key === stage.key);
  return i >= 0 && i + 1 < STAGES.length ? STAGES[i + 1]! : null;
}

/** 由 stats 造出里程碑阶梯(纯) */
function milestonesOf(s: GrowthStats): Milestone[] {
  return MILESTONES.map((m) => {
    const value = valueOf(m.kind, s);
    return {
      id: m.id,
      label: m.label,
      kind: m.kind,
      threshold: m.threshold,
      value,
      achieved: value >= m.threshold,
      progress: Math.max(0, Math.min(1, m.threshold > 0 ? value / m.threshold : 1)),
    };
  });
}

/**
 * 派生成长快照(纯函数)。
 *
 * `celebrate` 的算法:窗口去掉最后一天(今天)再算一遍里程碑,取"从 locked 变 unlocked"
 * 里**最大阈值**那个 —— 即今天刚跨过的那道坎。今天没跨坎 → null(不天天庆祝)。
 */
export function deriveGrowth(recent: DailyAgg[]): Growth {
  const stats = statsOf(recent);
  const milestones = milestonesOf(stats);
  const stage = stageFor(stats.days_together);
  const next_stage = nextStageFor(stage);
  const next_milestone = milestones.find((m) => !m.achieved) ?? null;

  // 今天新解锁的:拿掉今天再算,昨天没达成而今天达成的
  let celebrate: Milestone | null = null;
  if (recent.length > 1) {
    const before = milestonesOf(statsOf(recent.slice(0, -1)));
    const beforeById = new Map(before.map((m) => [m.id, m]));
    for (const m of milestones) {
      if (m.achieved && !beforeById.get(m.id)?.achieved) {
        if (celebrate === null || m.threshold > celebrate.threshold) celebrate = m;
      }
    }
  }

  return { ...stats, stage, next_stage, milestones, next_milestone, celebrate };
}
