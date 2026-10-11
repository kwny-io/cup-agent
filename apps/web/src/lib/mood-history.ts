/**
 * 脾气变化史的展示层纯函数 —— 标签 / 色调 / 趋势。
 *
 * 抽出来是为了**可测**(逻辑与渲染分离):
 * "心情怎么印成中文、上什么色、这周比上周是变好还是变坏"能直接单测。
 * MoodHistoryCard 只负责把它们接到 JSX 上。
 *
 * 三种长期心情(与后端 personality.ts 的 Disposition 同集):
 *   sulky  蔫    —— 最近不大上心
 *   normal 平常  —— 无底色
 *   smug   得意  —— 连着达标
 * 数字与排序都由后端给;这里只做展示层加工,不重算心情。
 */
import type { DispositionDay } from '../data/source.ts';

export type Disposition = DispositionDay['disposition'];

/** 心情 → 中文标签(短,时间线轴上用) */
const LABELS: Record<Disposition, string> = {
  sulky: '蔫',
  normal: '平常',
  smug: '得意',
};

/** 心情 → 一句话(卡里点开用),与后端 war report 的措辞家族一致 */
const BLURBS: Record<Disposition, string> = {
  sulky: '最近不太上心,杯子蔫蔫的',
  normal: '平平淡淡,没怎么被怠慢',
  smug: '连着达标,尾巴翘起来了',
};

/** 心情 → 色调 token(尾色:得分越高越暖) */
const TONES: Record<Disposition, string> = {
  sulky: 'text-cup-ink-soft',
  normal: 'text-cup-aqua',
  smug: 'text-cup-ember',
};

/** 心情 → 圆点/背景色 token */
const DOTS: Record<Disposition, string> = {
  sulky: 'bg-cup-ink-soft/50',
  normal: 'bg-cup-aqua/70',
  smug: 'bg-cup-ember',
};

/** 心情 → 高度权重 0..1(时间线柱状用;蔫矮、平常中、得意的最高) */
const WEIGHTS: Record<Disposition, number> = {
  sulky: 0.3,
  normal: 0.6,
  smug: 1,
};

export function dispositionLabel(d: Disposition): string {
  return LABELS[d];
}

export function dispositionBlurb(d: Disposition): string {
  return BLURBS[d];
}

export function dispositionTone(d: Disposition): string {
  return TONES[d];
}

export function dispositionDot(d: Disposition): string {
  return DOTS[d];
}

export function dispositionWeight(d: Disposition): number {
  return WEIGHTS[d];
}

/** 心情 → 分值(算趋势用):蔫 0 / 平常 1 / 得意 2 */
const SCORES: Record<Disposition, number> = { sulky: 0, normal: 1, smug: 2 };

export interface MoodSummary {
  /** 有记录的天数 */
  days: number;
  /** 各心情天数 */
  sulky: number;
  normal: number;
  smug: number;
  /** 最近连续"得意"天数(从末尾往回数)—— 养成卡最想看到的数 */
  smugStreak: number;
}

/** 汇总:各心情天数 + 末尾得意连击。全由后端逐日 disposition 数,不重算心情 */
export function summarizeMood(p: { days: DispositionDay[] } | null): MoodSummary {
  const days = p?.days ?? [];
  let sulky = 0;
  let normal = 0;
  let smug = 0;
  for (const d of days) {
    if (d.disposition === 'sulky') sulky += 1;
    else if (d.disposition === 'smug') smug += 1;
    else normal += 1;
  }
  let smugStreak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i]!.disposition === 'smug') smugStreak += 1;
    else break;
  }
  return { days: days.length, sulky, normal, smug, smugStreak };
}

export type MoodTrend = 'warming' | 'cooling' | 'steady';

/**
 * 趋势:后半段 vs 前半段的心情均分(旧→新)。
 *
 * 天数 < 4 判 'steady'(样本太少,不给"趋势"这种结论 —— 同后端"空窗口不给莫须有的蔫")。
 * 均分差 < 0.5 算平(避免一两天抖动就被判"变好/变坏")。
 */
export function moodTrend(p: { days: DispositionDay[] } | null): MoodTrend {
  const days = p?.days ?? [];
  if (days.length < 4) return 'steady';
  const mid = Math.floor(days.length / 2);
  const score = (arr: DispositionDay[]) =>
    arr.reduce((s, d) => s + SCORES[d.disposition], 0) / arr.length;
  const delta = score(days.slice(mid)) - score(days.slice(0, mid));
  if (delta >= 0.5) return 'warming';
  if (delta <= -0.5) return 'cooling';
  return 'steady';
}

/** 趋势 → 中文短语(卡里放标题旁) */
export function trendLabel(t: MoodTrend): string {
  if (t === 'warming') return '最近比之前好';
  if (t === 'cooling') return '最近有点蔫';
  return '一直挺稳';
}
