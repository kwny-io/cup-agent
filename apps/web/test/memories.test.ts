/**
 * 「回忆」纯函数测试 —— 日期换算 / 那年今日 / 一起第 N 天 / 在场连击 / 起名。
 *
 * 铁律同 lib/history.ts:日键走字符串,不用 `new Date('YYYY-MM-DD')`(会按 UTC 解析 → 东八区错一天)。
 * 这里钉的是"整卡分类与换算"的边界(空卡、断档、跨年同日、形键不对),不碰渲染。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cardSummary,
  cardTitle,
  cueLabel,
  currentCardStreak,
  daysBetween,
  daysTogether,
  eventLabel,
  localDayKey,
  memoirDetail,
  memoryDateLabel,
  onThisDay,
} from '../src/lib/memories.ts';
import type { MemoryCard, MemoryCardDetails } from '../src/data/source.ts';

function details(over: Partial<MemoryCardDetails> = {}): MemoryCardDetails {
  return {
    drank_ml: 0,
    goal_ml: 1500,
    reached: false,
    streak: 0,
    refill_count: 0,
    temp_range: null,
    notable_events: [],
    body_cues: [],
    turns_summary: null,
    turn_count: 0,
    ...over,
  };
}

function card(date: string, over: Partial<MemoryCardDetails> = {}): MemoryCard {
  return { cup_id: 'cup-X', date, built_at: 1, details: details(over) };
}

test('localDayKey:按本地时区拼 YYYY-MM-DD(补零)', () => {
  assert.equal(localDayKey(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(localDayKey(new Date(2026, 9, 14)), '2026-10-14');
});

test('daysBetween:过去为正、今天 0、未来为负;形键不对 → null', () => {
  assert.equal(daysBetween('2026-10-14', '2026-10-14'), 0);
  assert.equal(daysBetween('2026-10-13', '2026-10-14'), 1);
  assert.equal(daysBetween('2026-10-15', '2026-10-14'), -1);
  assert.equal(daysBetween('2025-10-14', '2026-10-14'), 365);
  assert.equal(daysBetween('bad', '2026-10-14'), null);
});

test('memoryDateLabel:MM-DD → M月D日 周X;形键不对原样', () => {
  // 2026-10-14 是周三
  assert.equal(memoryDateLabel('2026-10-14'), '10月14日 周三');
  assert.equal(memoryDateLabel('nope'), 'nope');
});

test('daysTogether:最早卡到今天 +1;空 → null', () => {
  assert.equal(daysTogether([], '2026-10-14'), null);
  assert.equal(daysTogether([card('2026-10-10')], '2026-10-14'), 5); // 10~14 共 5 天
  // 乱序也给最早那张
  assert.equal(daysTogether([card('2026-10-12'), card('2026-10-08')], '2026-10-14'), 7);
});

test('currentCardStreak:从今天往前数连续有卡的天;今天没卡不算断', () => {
  const today = '2026-10-14';
  // 今天 + 昨天 + 前天都有 → 3
  assert.equal(
    currentCardStreak([card('2026-10-14'), card('2026-10-13'), card('2026-10-12')], today),
    3,
  );
  // 今天没卡,昨天 + 前天有 → 2(今天可以还没封)
  assert.equal(currentCardStreak([card('2026-10-13'), card('2026-10-12')], today), 2);
  // 断档:今天 + 前天(缺昨天)→ 1
  assert.equal(currentCardStreak([card('2026-10-14'), card('2026-10-12')], today), 1);
  assert.equal(currentCardStreak([], today), 0);
});

test('onThisDay:挑同月同日的往年卡(不含今年);没有 → null', () => {
  const today = '2026-10-14';
  assert.equal(onThisDay([card('2026-10-14')], today), null, '今天不算那年今日');
  const past = card('2025-10-14');
  assert.equal(onThisDay([card('2026-10-14'), past, card('2025-11-01')], today)?.date, '2025-10-14');
  // 多年同日 → 取最新那张
  const newer = card('2025-10-14');
  const older = card('2024-10-14');
  assert.equal(onThisDay([older, newer], today)?.date, '2025-10-14');
});

test('cardTitle:按卡里已有什么分类,不编情绪', () => {
  assert.equal(cardTitle(card('2026-10-14', { reached: true })), '达标的一天');
  assert.equal(cardTitle(card('2026-10-14', { notable_events: [{ type: 'shake', ts: 1 }] })), '有事发生的一天');
  assert.equal(cardTitle(card('2026-10-14', { turns_summary: '主人问过「早」' })), '聊过天的一天');
  assert.equal(cardTitle(card('2026-10-14', { drank_ml: 300 })), '喝过水的一天');
  assert.equal(cardTitle(card('2026-10-14')), '平平淡淡的一天');
});

test('eventLabel / cueLabel:已知翻中文,未知原样回(不吞)', () => {
  assert.equal(eventLabel('shake'), '被摇了一下');
  assert.equal(eventLabel('weird'), 'weird');
  assert.equal(cueLabel('hurt'), '受了点惊');
  assert.equal(cueLabel('mystery'), 'mystery');
});

test('cardSummary:喝了 X · 目标 Y · 连 N 天(0 值不占位)', () => {
  assert.equal(cardSummary(card('2026-10-14', { drank_ml: 1200, goal_ml: 1500, streak: 3 })), '喝了 1200ml · 目标 1500ml · 连 3 天');
  assert.equal(cardSummary(card('2026-10-14', { drank_ml: 800, goal_ml: 0 })), '喝了 800ml');
});

test('memoirDetail:数值 + 显著事件 + 对话蒸馏(有才带)', () => {
  assert.equal(memoirDetail(details({ drank_ml: 1500, goal_ml: 1500 })), '1500/1500ml');
  assert.equal(
    memoirDetail(details({ drank_ml: 1200, goal_ml: 1500, notable_events: [{ type: 'shake', ts: 1 }] })),
    '1200/1500ml · 被摇了一下',
  );
  assert.equal(
    memoirDetail(details({ drank_ml: 1500, goal_ml: 1500, turns_summary: '主人问过「早」' })),
    '1500/1500ml · 主人问过「早」',
  );
});
