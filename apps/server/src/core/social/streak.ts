/**
 * 组队 streak(#74)—— 好友杯子的「**共同达标天数**」纯函数。
 *
 * 为什么是纯函数:和 `personality.ts` / `report.ts` 同一个理由 —— 掉线也要算得出、
 * 同一份输入同一份结果、可直测。社交端点只负责"把每个成员的 recentAggs 凑齐",算的活在这里。
 *
 * 口径(与单人 `countStreak` / `Store.streak` 同源,只是把"一个人"换成"每个人都要"):
 *   · **今天没结束**:今天没全员达标不算断链,从昨天往回数 —— 不然每天上午都显示"断了"
 *   · **共同**:某一天要**所有成员**都达标才算数(一人没喝 = 这天不算共同达标)
 *   · 只认"有活动"的日子?不 —— 达标是显式事实(goal>0 且 drank>=goal),没数据就是没达标
 *
 * 只看**派生结论**(哪天达标),不看原始饮水曲线 —— 与迁移码 / #72 档案同一隐私口径。
 */
import type { DailyAgg } from '../types.ts';
import { shiftDay } from '../../store/store.ts';

export interface TeamStreakResult {
  /** 共同连续达标天数(今天未全员达标 → 从昨天起算) */
  streak: number;
  /** 参与计算的成员数(有杯子的好友 + 自己) */
  members: number;
  /** 构成当前 streak 的日子(旧→新;空 streak → 空数组) */
  days: string[];
}

/** 窗口上限:再久的历史对"组队连续性"没有意义,也免得无界回溯 */
const MAX_WINDOW = 60;

/**
 * 每一成员的日聚合(旧→新均可,内部按 date 索引)→ 共同连续达标天数。
 *
 * @param perMember 每个成员一份 recentAggs(至少覆盖 window 天;多给无妨)
 * @param today     今天的日期键(dayKey)—— 判断"从今天还是昨天起算"
 * @param window    最多回溯多少天(默认 30,夹紧 [1, MAX_WINDOW])
 */
export function teamStreak(
  perMember: DailyAgg[][],
  today: string,
  window = 30,
): TeamStreakResult {
  const members = perMember.length;
  if (members === 0) return { streak: 0, members: 0, days: [] };

  const w = Math.max(1, Math.min(MAX_WINDOW, Math.floor(window)));

  // 每个成员:date → 是否达标
  const metBy = perMember.map((aggs) => {
    const m = new Map<string, boolean>();
    for (const a of aggs) m.set(a.date, a.goal_ml > 0 && a.drank_ml >= a.goal_ml);
    return m;
  });
  const allMet = (date: string): boolean => metBy.every((m) => m.get(date) === true);

  // 今天没结束:今天没全员达标就从昨天起算(不给"上午还没喝 = 断了"的委屈)
  let cursor = allMet(today) ? today : shiftDay(today, -1);
  const days: string[] = [];
  for (let i = 0; i < w; i++) {
    if (!allMet(cursor)) break;
    days.push(cursor);
    cursor = shiftDay(cursor, -1);
  }
  days.reverse(); // 旧→新,与性格史时间线一致
  return { streak: days.length, members, days };
}
