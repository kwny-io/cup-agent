/**
 * 性格层 —— 杯子"按喝水规律发展脾气"(D1 傲娇宠物,M4)。
 *
 * 纯函数:输入最近 N 天日聚合,输出长期心情(--> disposition)。
 * 不含 I/O,不产生"数字以外的判断"。数字只来自事实,这里只决定"语气"。
 *
 * 为什么要它,而不是让 LLM 判断:
 *   1. 掉线也要有脾气(plan M4 验收 3)—— 纯函数永远算得出
 *   2. LLM 挂了 / 超时,心情不跟着挂
 *   3. 同一份数据 → 同一个结果,可测试、可复现
 *
 * 与前端 lib/mood.ts 的分工:
 *   · 这里   = **长期**心情(几天没达标 → 蔫),跨会话,放后端
 *   · mood.ts = **短时**表现(摇杯→皱眉、喝水→得意),50Hz 级,放前端
 *   前者通过 /report/latest 下发,只在"无短时情绪"时上脸。
 */
import type { DailyAgg } from './types.ts';

/** 长期心情:蔫(被怠慢)/ 平常 / 得意(最近一直达标) */
export type Disposition = 'sulky' | 'normal' | 'smug';

export interface Personality {
  disposition: Disposition;
  /** 综合达标率 0–1(近期平均) */
  level: number;
  /** 连续达标天数(从昨天往回数,和 Store.streak 同语义) */
  streak: number;
  /** 一句话说明"为什么是这个心情",给战报当 reason */
  reason: string;
  /**
   * 水温满意度 0–1 —— 第 2 个性格维度(达标率之外)。
   * 近期平均水温落在舒适区(35–55°C)= 1,偏离越多越低;窗口内**无一℃数据** = 0.5(中性)。
   * 只看"水烫不烫",与喝了多少无关 —— 免得"喝得多"一间把温度信号淹掉。
   */
  warmth: number;
  /**
   * 续杯规律 0–1 —— 第 3 个性格维度。
   * 近期**有续杯的天数占比**:常续杯 = 杯子被照顾、不见底;几乎不续 = 总见底也没人管。
   * 只统计"喝过或有续杯"的日子,空白日不拉低(不给莫须有的委屈)。
   */
  refill_habit: number;
}

/** 看最近几天的规律(越久越"性格化";7 天够反映一周) */
export const LOOKBACK_DAYS = 7;

/**
 * **派生性格快照**(养成卡 / 迁移码用)—— `Personality` 的 5 个数值成员 + 落盘时刻。
 *
 * 为什么单独一个形状:迁移码要"纯本地、只带派生性格",不能带 `reason`(那句话含自由
 * 文本)也不能带原始饮水曲线。这里就是"可以安全带走的那部分"的**唯一定义**。
 */
export interface TraitRecord {
  disposition: Disposition;
  level: number;
  streak: number;
  warmth: number;
  refill_habit: number;
  /** 生成时刻(ms)—— 迁移码里的"创建日期"来源 */
  updated_at: number;
}

/** 由 `Personality` 取派生性格快照(纯函数;`reason` 不外带) */
export function traitRecord(p: Personality, nowMs: number): TraitRecord {
  return {
    disposition: p.disposition,
    level: p.level,
    streak: p.streak,
    warmth: p.warmth,
    refill_habit: p.refill_habit,
    updated_at: nowMs,
  };
}

/** 达标率低于此 → 蔫 */
const SULK_LEVEL = 0.35;
/** 最近连续达标 ≥ 此天数 → 得意 */
const SMUG_STREAK = 2;
/** 饮水舒适水温区间(°C)—— 落这里就是"刚刚好" */
const TEMP_COMFORT_LO = 35;
const TEMP_COMFORT_HI = 55;
/** 离舒适区多远就算"完全不满"(°C)—— 用于把偏离距离归一成 0–1 */
const TEMP_TOLERANCE = 20;

/**
 * 由最近 N 天聚合算长期心情。
 *
 * @param recent 旧→新的日聚合(最后一个是今天);长度不限,只看最后 LOOKBACK_DAYS 天
 * @param today  今天是否已达标(今天没结束,不达标不算"蔫"的证据)
 *
 * 规则(顺序即优先级):
 *   1. 连续达标 ≥ SMUG_STREAK 天 → smug(得意)
 *   2. 达标率 < SULK_LEVEL      → sulky(蔫)
 *   3. 其余                     → normal
 */
export function computePersonality(recent: DailyAgg[], todayOk: boolean): Personality {
  const window = recent.slice(-LOOKBACK_DAYS);
  const streak = countStreak(window, todayOk);
  const level = presenceRate(window);
  const warmth = warmthScore(window);
  const refill_habit = refillHabit(window);

  if (streak >= SMUG_STREAK) {
    return {
      disposition: 'smug',
      level,
      streak,
      warmth,
      refill_habit,
      reason: `连着 ${streak} 天都达标,杯子尾巴翘上天了`,
    };
  }

  // 今天没结束:今天未达标不当作"被怠慢"的证据,只看以往
  const past = todayOk ? window : window.slice(0, -1);
  const pastRate = presenceRate(past);
  if (past.length >= 2 && pastRate < SULK_LEVEL) {
    return {
      disposition: 'sulky',
      level,
      streak,
      warmth,
      refill_habit,
      reason: `最近 ${past.length} 天都不太够,杯子快干了`,
    };
  }

  return {
    disposition: 'normal',
    level,
    streak,
    warmth,
    refill_habit,
    reason: streak > 0 ? `已经连上 ${streak} 天了,别断` : '平平淡淡才刚开始',
  };
}

/** 窗口内的达标率 0–1(空窗口视为 1,不给"莫须有的蔫") */
function presenceRate(window: DailyAgg[]): number {
  if (window.length === 0) return 1;
  let ok = 0;
  for (const d of window) if (d.goal_ml > 0 && d.drank_ml >= d.goal_ml) ok += 1;
  return ok / window.length;
}

/**
 * 近期平均水温的满意度 0–1。
 * 每天取 avg(取不到 avg 时退回 min/max 的中点),摄氏 35–55 = 1;
 * 低于 35 或高于 55 后线性掉到 0(偏离 TEMP_TOLERANCE 度即 0)。
 * 窗口内**无任何温度数据** → 0.5(中性),不因"没温度"而夸或贬。
 */
export function warmthScore(window: DailyAgg[]): number {
  let sum = 0;
  let n = 0;
  for (const d of window) {
    const t = d.temp_avg_c ?? midTemp(d.temp_min_c, d.temp_max_c);
    if (t === null) continue;
    const dev = t < TEMP_COMFORT_LO ? TEMP_COMFORT_LO - t : t > TEMP_COMFORT_HI ? t - TEMP_COMFORT_HI : 0;
    sum += Math.max(0, 1 - dev / TEMP_TOLERANCE);
    n += 1;
  }
  if (n === 0) return 0.5;
  return sum / n;
}

function midTemp(min: number | null, max: number | null): number | null {
  if (min === null && max === null) return null;
  if (min === null) return max;
  if (max === null) return min;
  return (min + max) / 2;
}

/**
 * 续杯规律 0–1 —— "有续杯的天 / 有活动的天"。
 * 只统计"喝过或有续杯"的日子(event_count>0 或 refill_ml>0),空白日不参与,
 * 免得"没数据"被当成"没续杯"而误判。无任何活动日 → 0.5(中性)。
 */
export function refillHabit(window: DailyAgg[]): number {
  let active = 0;
  let refilled = 0;
  for (const d of window) {
    if (d.event_count === 0 && d.refill_ml === 0) continue;
    active += 1;
    if (d.refill_ml > 0) refilled += 1;
  }
  if (active === 0) return 0.5;
  return refilled / active;
}

/**
 * 水温相关的一句"嘟囔" —— 给战报当可选尾巴(第 2 个性格维度上脸的地方)。
 * 只在明显偏离舒适区时才出声(≥0.8 舒服 / <0.4 明显不适),否则返回 null
 * —— 常态不啰嗦,才像"偶尔嫌一句"的傲娇。
 *
 * **刻意不含任何数字**:战报的硬规矩是"headline 里的数字必须来自 facts"
 * (见 personality.test.ts 的不变量用例),而温度不在那组允许数字里,
 * 所以这里只给语气、不给度数 —— 度数真要说,走 facts 里的 temp_min/max。
 */
export function warmthRemark(warmth: number): string | null {
  if (warmth >= 0.8) return '水温刚刚好,这点倒是没得挑。';
  if (warmth < 0.4) return '水总是凉的,杯子喝着直皱眉。';
  return null;
}

/**
 * 连续达标天数(与 Store.computeStreak 同语义):
 * 今天达标 → 从今天数;今天没达标 → 从昨天数(今天没结束,不算断链)。
 */
function countStreak(window: DailyAgg[], todayOk: boolean): number {
  let n = 0;
  let i = window.length - 1;
  if (i < 0) return 0;
  const last = window[i]!;
  // 只有当"最后一天就是今天"才可能从今天起算
  if (todayOk && last.drank_ml >= last.goal_ml) {
    // 从今天数
  } else {
    i -= 1; // 从昨天数
  }
  for (; i >= 0; i--) {
    const d = window[i]!;
    if (d.goal_ml > 0 && d.drank_ml >= d.goal_ml) n += 1;
    else break;
  }
  return n;
}
