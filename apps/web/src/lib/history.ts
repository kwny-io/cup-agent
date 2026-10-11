/**
 * 历史战报的纯函数 —— 日期标签 + 汇总行。
 *
 * 抽出来是为了**可测**(逻辑与渲染分离):
 * "日期怎么裁成 MM-DD、周几怎么标、汇总怎么算"能直接单测。
 * HistoryCard 只负责把它们接到 JSX 上。
 *
 * 每天的**一句话**(headline)由后端给,前端不重拼 —— 这里只做展示层加工。
 */
import type { HistoryDay, ServerHistory } from '../data/source.ts';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 日期键 `YYYY-MM-DD` → 展示标签 `MM-DD 周X`。
 *
 * 注意:`date` 是**后端日聚合的本地日键**(不含时区信息),所以只按字符串切,
 * **不用 `new Date('YYYY-MM-DD')`** —— 那样会被按 UTC 解析,东八区的 `周一` 可能显示成 `周日`。
 * 周几由 `Date(y, m-1, d)` 按本地时区构造,**拿到的才是那一天真实的星期**。
 */
export function dayLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date; // 形状不对就原样显示,不编
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const wd = WEEKDAYS[new Date(y, mo - 1, d).getDay()] ?? '';
  return `${m[2]}-${m[3]} 周${wd}`;
}

/** 今天那一行标出来 —— 只有它随当天饮水增长,值得点明(其余是定格的过去) */
export function isToday(date: string, todayKey: string): boolean {
  return date === todayKey;
}

export interface HistorySummary {
  /** 有数据的天数(= 后端返回的条数) */
  days: number;
  /** 其中达标天数 */
  hitDays: number;
  /** 合计饮水 */
  totalMl: number;
}

/** 汇总行:合计 / 有记录天数 / 达标天数 —— 全由后端逐日数字算,前端不另造数 */
export function summarize(h: ServerHistory | null): HistorySummary {
  const days = h?.days ?? [];
  return {
    days: days.length,
    hitDays: days.filter((d) => d.reached_goal).length,
    totalMl: days.reduce((s, d) => s + d.drank_ml, 0),
  };
}

/** 单日进度条取值:0–1,夹紧;goal 为 0 时给 0(不除零) */
export function dayProgress(d: Pick<HistoryDay, 'drank_ml' | 'goal_ml'>): number {
  if (d.goal_ml <= 0) return 0;
  return Math.max(0, Math.min(1, d.drank_ml / d.goal_ml));
}
