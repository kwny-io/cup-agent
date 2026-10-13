/**
 * 成长层的**展示换算**(纯函数)—— 把后端快照换算成界面直接能画的数。
 *
 * 后端(`core/growth.ts`)已经把"一起第 N 天 / 阶段 / 里程碑阶梯 / 今天新解锁"算好了,
 * 前端**不重算事实**,只做两类换算:
 *   · 阶段进度(当前阶段走到下一阶段还差几天 / 百分比)—— 后端只给了阶段名与门槛,没给进度;
 *   · 文案(阶段徽标、下一目标那句话)。
 *
 * 与 lib/memories.ts 同款纪律:纯函数、可直测、零 I/O。
 */
import type { Growth, GrowthStage, Milestone } from '../data/source.ts';

/** 阶段阶梯的判定(与后端 core/growth.ts 的 STAGES 同源;前端只用来渲染阶梯)。 */
export const STAGES: GrowthStage[] = [
  { key: 'newborn', name: '新生', min_days: 0 },
  { key: 'sprout', name: '幼芽', min_days: 3 },
  { key: 'growing', name: '成长期', min_days: 7 },
  { key: 'steady', name: '稳当', min_days: 30 },
  { key: 'companion', name: '老友', min_days: 100 },
  { key: 'legend', name: '传奇', min_days: 365 },
];

/**
 * 当前阶段走了多远(0–1)。
 * 顶级阶段(`next_stage===null`)→ 1(已到顶,没有下一台阶)。
 * 门槛按"本阶段起点 → 下阶段门槛"的区间算,不是从 0 起 —— 免得刚升阶就回到 0%。
 */
export function stageProgress(g: Growth): number {
  if (!g.next_stage) return 1;
  const from = g.stage.min_days;
  const to = g.next_stage.min_days;
  if (to <= from) return 1;
  return Math.max(0, Math.min(1, (g.days_together - from) / (to - from)));
}

/** 距下一阶段还差几天(顶级阶段 → null)。 */
export function daysToNextStage(g: Growth): number | null {
  if (!g.next_stage) return null;
  return Math.max(0, g.next_stage.min_days - g.days_together);
}

/** 里程碑"还差多少"那句话 —— 达成 → 已达成;未达成 → 还差 N(单位按种类)。 */
export function milestoneRemaining(m: Milestone): string {
  if (m.achieved) return '已达成';
  const gap = Math.max(0, m.threshold - m.value);
  if (m.kind === 'streak') return `还差 ${gap} 天连击`;
  if (m.kind === 'refill') return `还差 ${gap} 天续杯`;
  if (m.kind === 'achieved') return `还差 ${gap} 天达标`;
  return `还差 ${gap} 天`;
}

/** 阶段徽标用的短名(顶级阶段加个「满」前缀感);没有特殊态 → 原名。 */
export function stageBadge(g: Growth): string {
  return g.next_stage ? g.stage.name : `${g.stage.name} · 满级`;
}

/** 庆祝文案 —— `celebrate` 那道坎新解锁时的横幅。没跨坎 → null。 */
export function celebrateText(g: Growth): string | null {
  if (!g.celebrate) return null;
  return `解锁「${g.celebrate.label}」`;
}
