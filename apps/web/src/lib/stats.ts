/**
 * 从事件流 + 最新遥测里算"今日概览"。
 *
 * 注意:这是**前端现算**的临时实现,够 M2 用。
 * M1 后端上线后,今日/曲线应由后端日聚合给出(`/today` `/series`),
 * 前端只负责展示 —— 那时候这个文件的职责会缩到"格式化"。
 */
import type { BaseTelemetry, CupEvent, LidTelemetry } from '@cup/contract';

export interface TodayStats {
  /** 今日累计饮水 ml */
  intakeMl: number;
  /** 今日饮水次数 */
  drinkCount: number;
  /** 今日续水次数 */
  refillCount: number;
  /** 摇杯次数(英雄功能互动量) */
  shakeCount: number;
  /** 报警次数 */
  alerts: number;
  /** 水温区间 */
  tempMin: number | null;
  tempMax: number | null;
}

export function isToday(ts: number, now = Date.now()): boolean {
  const a = new Date(ts);
  const b = new Date(now);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function todayStats(events: CupEvent[], now = Date.now()): TodayStats {
  const s: TodayStats = {
    intakeMl: 0,
    drinkCount: 0,
    refillCount: 0,
    shakeCount: 0,
    alerts: 0,
    tempMin: null,
    tempMax: null,
  };
  for (const e of events) {
    if (!isToday(e.ts, now)) continue;
    switch (e.type) {
      case 'drink':
        s.drinkCount += 1;
        s.intakeMl += e.amount_ml ?? 0;
        break;
      case 'refill':
        s.refillCount += 1;
        break;
      case 'shake':
        s.shakeCount += 1;
        break;
      case 'temp_alert':
      case 'tilt_alert':
      case 'low_battery':
        s.alerts += 1;
        break;
      case 'off_base':
        break;
    }
    if (e.temp_c !== undefined) {
      s.tempMin = s.tempMin === null ? e.temp_c : Math.min(s.tempMin, e.temp_c);
      s.tempMax = s.tempMax === null ? e.temp_c : Math.max(s.tempMax, e.temp_c);
    }
  }
  return s;
}

/** 大目标(可配置,先写死) */
export const DAILY_GOAL_ML = 1500;

export function progress(intakeMl: number, goal = DAILY_GOAL_ML): number {
  return Math.max(0, Math.min(1, intakeMl / goal));
}

/**
 * 按小时把饮水事件分桶 —— **离线回退**版(纯模拟器 / mock 源,没有后端分桶时)。
 * 有后端时用 `hourlyFromSeries`(整天 24 桶),别用这个:云模式只收得到连上之后的
 * 事件,这里会把今天早些时候的喝水量算漏(S6 收窄 stats 职责的那一半)。
 */
export function hourlyIntake(events: CupEvent[], now = Date.now()): number[] {
  const buckets = new Array(24).fill(0) as number[];
  for (const e of events) {
    if (e.type !== 'drink' || !isToday(e.ts, now)) continue;
    const h = new Date(e.ts).getHours();
    buckets[h] = (buckets[h] ?? 0) + (e.amount_ml ?? 0);
  }
  return buckets;
}

/**
 * 后端 `series?range=day` 的 24 桶 → 给柱状图用的 `number[]`(取 drank_ml)。
 * 桶数不是 24(或后端回别的 range)时返回 null,让调用方回退 `hourlyIntake`
 * —— 宁可自己现算,也不拿一份形状可疑的桶去画。
 */
export function hourlyFromSeries(
  series: { range: string; buckets: readonly { drank_ml: number }[] } | null,
): number[] | null {
  if (!series || series.range !== 'day' || series.buckets.length !== 24) return null;
  return series.buckets.map((b) => b.drank_ml);
}

/**
 * 饮水曲线该用哪份桶 —— **有后端分桶就用它,否则前端现算**。
 * 这正是一条策略,抽成纯函数好测(逻辑与渲染分离,不必渲染组件)。
 */
export function intakeBuckets(
  events: CupEvent[],
  daySeries: { range: string; buckets: readonly { drank_ml: number }[] } | null,
  now = Date.now(),
): number[] {
  return hourlyFromSeries(daySeries) ?? hourlyIntake(events, now);
}

export interface CupSnapshot {
  levelPct: number;
  tempC: number | null;
  weightG: number | null;
  batteryPct: number | null;
  charging: boolean;
  online: boolean;
}

export function snapshot(
  lid: LidTelemetry | undefined,
  base: BaseTelemetry | undefined,
): CupSnapshot {
  return {
    levelPct: lid?.level_pct ?? 0,
    tempC: lid?.temp_c ?? base?.temp_c ?? null,
    weightG: base?.weight_g ?? null,
    batteryPct: lid?.battery_pct ?? base?.battery_pct ?? null,
    charging: lid?.charging ?? base?.charging ?? false,
    online: Boolean(lid || base),
  };
}
