/**
 * 优先级 3:主动开口「时机」模型 —— 纯函数测试(注入 clock,零真实时间)。
 *
 * 钉死两件事:
 *   · 说多了会烦 → 自适应退避(连续被无视 → 冷却 2h→3h→…封顶 6h;被回应 → 回基准)
 *   · 说少了会淡 → 不打扰(用户刚在说 / 刚喝过 → 让位),但档期到了仍会说
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ignoredStreak,
  cooldownMsFor,
  decideSpeak,
  BASE_COOLDOWN_MS,
  BACKOFF_PER_IGNORE_MS,
  MAX_COOLDOWN_MS,
  ENGAGE_WINDOW_MS,
  type TimingTurn,
} from '@cup/server';

const T0 = new Date(2026, 9, 8, 15, 0, 0).getTime(); // 本地 15:00(窗口内)
const H = 3_600_000;

function baseInput(over: Partial<Parameters<typeof decideSpeak>[0]> = {}) {
  return {
    nowMs: T0,
    hour: 15,
    drankMl: 400, // < 0.5*1500
    goalMl: 1500,
    eventCount: 3,
    recentTurns: [] as TimingTurn[],
    lastDrinkTs: null as number | null,
    ...over,
  };
}

test('时机:窗口内 + 欠水 + 无历史 → 开口(due)', () => {
  const d = decideSpeak(baseInput());
  assert.equal(d.speak, true);
  assert.equal(d.reason, 'due');
  assert.equal(d.cooldownMs, BASE_COOLDOWN_MS);
});

test('时机:时段外 → 不说话', () => {
  assert.equal(decideSpeak(baseInput({ hour: 9 })).reason, 'out-of-window');
  assert.equal(decideSpeak(baseInput({ hour: 19 })).reason, 'out-of-window');
});

test('时机:没数据 / 无目标 / 已达标 → 各有其理由', () => {
  assert.equal(decideSpeak(baseInput({ eventCount: 0 })).reason, 'no-data');
  assert.equal(decideSpeak(baseInput({ goalMl: 0 })).reason, 'no-goal');
  assert.equal(decideSpeak(baseInput({ drankMl: 1000 })).reason, 'not-thirsty');
});

test('时机:用户刚在说话 → 让位(不叠话)', () => {
  const turns: TimingTurn[] = [{ role: 'user', ts: T0 - 60_000 }]; // 1 分钟前
  assert.equal(decideSpeak(baseInput({ recentTurns: turns })).reason, 'user-just-spoke');
  // 超过 notch 窗就不再挡
  const old: TimingTurn[] = [{ role: 'user', ts: T0 - 10 * 60_000 }];
  assert.equal(decideSpeak(baseInput({ recentTurns: old })).speak, true);
});

test('时机:刚喝过(30 分钟内)→ 先按住', () => {
  assert.equal(decideSpeak(baseInput({ lastDrinkTs: T0 - 5 * 60_000 })).reason, 'just-drank');
  assert.equal(decideSpeak(baseInput({ lastDrinkTs: T0 - 45 * 60_000 })).speak, true);
});

test('自适应:连续被无视 → 冷却 2h→3h→4h,封顶 6h', () => {
  const ignored = (n: number): TimingTurn[] =>
    Array.from({ length: n }, (_, i) => ({ role: 'proactive' as const, ts: T0 - (n - i) * 24 * H }));
  assert.equal(cooldownMsFor(ignored(0)), BASE_COOLDOWN_MS);
  assert.equal(cooldownMsFor(ignored(1)), BASE_COOLDOWN_MS + BACKOFF_PER_IGNORE_MS);
  assert.equal(cooldownMsFor(ignored(2)), BASE_COOLDOWN_MS + 2 * BACKOFF_PER_IGNORE_MS);
  // 远超上限 → 封在 MAX
  assert.equal(cooldownMsFor(ignored(10)), MAX_COOLDOWN_MS);
  assert.equal(ignoredStreak(ignored(3)), 3);
});

test('自适应:一次开口被回应 → 退避清零(回基准冷却)', () => {
  const turns: TimingTurn[] = [
    { role: 'proactive', ts: T0 - 5 * H },
    { role: 'user', ts: T0 - 5 * H + 2 * 60_000 }, // 10 分钟窗内回应 → 该次算被回应
  ];
  assert.equal(ignoredStreak(turns), 0);
  assert.equal(cooldownMsFor(turns), BASE_COOLDOWN_MS);
});

test('自适应:回应窗外的 user 轮不算"被回应"', () => {
  const turns: TimingTurn[] = [
    { role: 'proactive', ts: T0 - 5 * H },
    { role: 'user', ts: T0 - 5 * H + ENGAGE_WINDOW_MS + 1 }, // 窗口外
  ];
  assert.equal(ignoredStreak(turns), 1);
});

test('自适应:拉长的冷却,在到达前仍让位(cooldown)', () => {
  const turns: TimingTurn[] = [{ role: 'proactive', ts: T0 - 90 * 60_000 }]; // 1.5h 前,已忽视 1 次 → 冷却 3h
  assert.equal(decideSpeak(baseInput({ recentTurns: turns })).reason, 'cooldown');
  // 满 3h → 可以再说(reason 标明是退避后的到期)
  const due = decideSpeak(baseInput({ recentTurns: turns, nowMs: T0 + 90 * 60_000 }));
  assert.equal(due.speak, true);
});
