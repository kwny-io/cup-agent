/**
 * 成长展示换算(纯函数)测试 —— lib/growth.ts。
 *
 * 后端已经把事实算好了(一起第 N 天 / 阶段 / 里程碑),这里只测**前端那点换算**:
 * 升阶进度 / 还差几天 / 里程碑文案 / 徽标 / 庆祝文案。数字口径以输入为准,不重算。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  daysToNextStage,
  milestoneRemaining,
  STAGES,
  stageBadge,
  stageProgress,
  celebrateText,
} from '../src/lib/growth.ts';
import type { Growth, Milestone } from '../src/data/source.ts';

function stage(key: string): Growth['stage'] {
  return STAGES.find((s) => s.key === key)!;
}

function growth(over: Partial<Growth> = {}): Growth {
  const s = over.stage ?? stage('newborn');
  const idx = STAGES.findIndex((x) => x.key === s.key);
  const next = idx >= 0 && idx + 1 < STAGES.length ? STAGES[idx + 1]! : null;
  return {
    days_together: 0,
    best_streak: 0,
    total_achieved_days: 0,
    total_refill_days: 0,
    stage: s,
    next_stage: next,
    milestones: [],
    next_milestone: null,
    celebrate: null,
    ...over,
  };
}

function ms(over: Partial<Milestone> = {}): Milestone {
  return { id: 'x', label: '里程碑', kind: 'together', threshold: 7, value: 0, achieved: false, progress: 0, ...over };
}

test('stageProgress:从本阶段起点算,不是从 0(刚升阶不该回 0%)', () => {
  // growing 起点 7,下一阶 steady 门槛 30 → 第 7 天应 ≈ 0%
  const g = growth({ stage: stage('growing'), days_together: 7 });
  assert.equal(stageProgress(g), 0);
  // 第 18.5 天应 ≈ 50%
  const g2 = growth({ stage: stage('growing'), days_together: 18.5 });
  assert.ok(Math.abs(stageProgress(g2) - 0.5) < 1e-9);
});

test('stageProgress:顶级阶段 → 1(没有下一台阶)', () => {
  const g = growth({ stage: stage('legend'), days_together: 400 });
  assert.equal(stageProgress(g), 1);
});

test('daysToNextStage:还差几天;顶级 → null', () => {
  assert.equal(daysToNextStage(growth({ stage: stage('growing'), days_together: 10 })), 20);
  assert.equal(daysToNextStage(growth({ stage: stage('newborn'), days_together: 1 })), 2);
  assert.equal(daysToNextStage(growth({ stage: stage('legend'), days_together: 400 })), null);
});

test('milestoneRemaining:达成 → 已达成;未达成按种类给单位', () => {
  assert.equal(milestoneRemaining(ms({ achieved: true, value: 7 })), '已达成');
  assert.equal(milestoneRemaining(ms({ kind: 'together', threshold: 7, value: 3 })), '还差 4 天');
  assert.equal(milestoneRemaining(ms({ kind: 'streak', threshold: 14, value: 5 })), '还差 9 天连击');
  assert.equal(milestoneRemaining(ms({ kind: 'achieved', threshold: 7, value: 3 })), '还差 4 天达标');
  assert.equal(milestoneRemaining(ms({ kind: 'refill', threshold: 7, value: 1 })), '还差 6 天续杯');
});

test('stageBadge:顶级阶段带「满级」标', () => {
  assert.equal(stageBadge(growth({ stage: stage('growing'), days_together: 10 })), '成长期');
  assert.equal(stageBadge(growth({ stage: stage('legend'), days_together: 400 })), '传奇 · 满级');
});

test('celebrateText:有跨坎 → 解锁文案;没有 → null', () => {
  assert.equal(celebrateText(growth()), null);
  const g = growth({ celebrate: ms({ id: 'together_3', label: '一起 3 天' }) });
  assert.equal(celebrateText(g), '解锁「一起 3 天」');
});
