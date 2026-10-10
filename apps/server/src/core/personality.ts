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
}

/** 看最近几天的规律(越久越"性格化";7 天够反映一周) */
export const LOOKBACK_DAYS = 7;

/** 达标率低于此 → 蔫 */
const SULK_LEVEL = 0.35;
/** 最近连续达标 ≥ 此天数 → 得意 */
const SMUG_STREAK = 2;

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

  if (streak >= SMUG_STREAK) {
    return {
      disposition: 'smug',
      level,
      streak,
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
      reason: `最近 ${past.length} 天都不太够,杯子快干了`,
    };
  }

  return {
    disposition: 'normal',
    level,
    streak,
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
