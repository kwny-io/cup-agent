/**
 * 杯量分档的纯逻辑 —— 把今天的单次喝水量按档分桶(给"杯量分档"卡用)。
 *
 * 抽到 lib 为了**可测**(web 无 DOM 测试环境):分档边界、计数、合计都能单测;
 * 卡片只负责画。不引任何图表库(按需引入,P4),分档是纯数组运算。
 */
import type { CupEvent } from '@cup/contract';
import { isToday } from './stats.ts';

/** 一档:min 含、max 不含(max=null 表示无上界);范围都是 ml。 */
export interface DrinkBand {
  key: string;
  /** 档名(展示用) */
  label: string;
  /** 数值区间文案(展示用) */
  range: string;
  min: number;
  max: number | null;
}

/** 分档定义(顺序即展示顺序)。半开区间 [min, max),故整数边界不重不漏。 */
export const DRINK_BANDS: readonly DrinkBand[] = [
  { key: 'sip', label: '小口', range: '<100', min: 0, max: 100 },
  { key: 'small', label: '小杯', range: '100–199', min: 100, max: 200 },
  { key: 'medium', label: '中杯', range: '200–299', min: 200, max: 300 },
  { key: 'large', label: '大杯', range: '300–399', min: 300, max: 400 },
  { key: 'full', label: '豪饮', range: '≥400', min: 400, max: null },
];

/** 分档统计:每档的次数与合计;外加总次数与总毫升,省得调用方再算一遍。 */
export interface BandStat extends DrinkBand {
  count: number;
  totalMl: number;
}

export interface DrinkBucketResult {
  bands: BandStat[];
  totalCount: number;
  totalMl: number;
}

/** 单次量落在哪一档;越界(负数)夹到第一档,无上界档吞掉超大值。 */
export function bandOf(amountMl: number): DrinkBand {
  const x = Number.isFinite(amountMl) ? Math.max(0, amountMl) : 0;
  for (const b of DRINK_BANDS) {
    if (x >= b.min && (b.max === null || x < b.max)) return b;
  }
  return DRINK_BANDS[DRINK_BANDS.length - 1]!; // 理论上到不了(最后一档无上界)
}

/**
 * 把今天的 drink 事件按单次量分档。
 * 只看今天(与看板其余卡一致);非 drink / 缺 amount_ml 的跳过
 * (amount_ml 仅 drink/refill 携带,drink 缺失按 0 处理会污染"小口"档,故跳过)。
 */
export function drinkBuckets(events: CupEvent[], now = Date.now()): DrinkBucketResult {
  const acc = new Map<string, BandStat>();
  for (const b of DRINK_BANDS) acc.set(b.key, { ...b, count: 0, totalMl: 0 });

  let totalCount = 0;
  let totalMl = 0;
  for (const e of events) {
    if (e.type !== 'drink' || !isToday(e.ts, now)) continue;
    if (e.amount_ml === undefined) continue;
    const b = bandOf(e.amount_ml);
    const s = acc.get(b.key);
    if (!s) continue;
    s.count += 1;
    s.totalMl += e.amount_ml;
    totalCount += 1;
    totalMl += e.amount_ml;
  }

  return { bands: [...acc.values()], totalCount, totalMl };
}
