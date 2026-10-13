/**
 * 模拟器行为测试 —— 把"跑起来看着对"固化成断言。
 * 对应 plan.md M0 验收标准 1、2。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, gestureStep, type Frame } from '@cup/simulator';
import { typicalDay, smoke } from '@cup/simulator';
import type { CupEvent } from '@cup/contract';

interface Collected {
  events: CupEvent[];
  lidFrames: number;
  baseFrames: number;
}

function run(opts: {
  steps: ReturnType<typeof typicalDay>;
  scale: number;
  reportMs: number;
  scoreMs?: number;
  seed?: number;
}): Collected {
  const out: Collected = { events: [], lidFrames: 0, baseFrames: 0 };
  const engine = new Engine({
    config: {
      seed: opts.seed ?? 42,
      scale: opts.scale,
      startMs: Date.UTC(2026, 9, 7, 0, 0, 0),
      reportMs: opts.reportMs,
      verbose: false,
    },
    steps: opts.steps,
    sink: (f: Frame) => {
      if (f.lid) out.lidFrames++;
      if (f.base) out.baseFrames++;
      out.events.push(...f.events);
    },
  });
  engine.runToEnd(opts.scoreMs ?? 60_000);
  return out;
}

function count(events: CupEvent[], type: string): number {
  return events.filter((e) => e.type === type).length;
}

test('典型一天:产出上报帧', () => {
  const r = run({ steps: typicalDay(), scale: 600, reportMs: 60_000 });
  assert.ok(r.lidFrames > 0, '应有杯盖上报');
  assert.ok(r.baseFrames > 0, '应有底座上报');
  assert.equal(r.lidFrames, r.baseFrames, '杯盖与底座上报节奏一致');
});

test('典型一天:事件序列合理', () => {
  const r = run({ steps: typicalDay(), scale: 600, reportMs: 60_000 });
  // 脚本里有 7 次 drink,3 次 refill/hotWater,2 次 shake,1 tap + 1 long_press
  assert.equal(count(r.events, 'drink'), 7, 'drink 次数');
  assert.equal(count(r.events, 'refill'), 3, 'refill 次数');
  assert.equal(count(r.events, 'shake'), 2, 'shake 次数');
  assert.equal(count(r.events, 'tap'), 1, '上午轻磕一次 tap');
  assert.equal(count(r.events, 'long_press'), 1, '下午长按一次 long_press');
  assert.equal(count(r.events, 'temp_alert'), 1, '倒 72°C 热水触发一次过热');
  assert.equal(count(r.events, 'off_base'), 1, '只有傍晚真正带走算 off_base');
  assert.equal(count(r.events, 'low_battery'), 1, '傍晚电量告急触发一次低电提醒');
});

test('否定用例:拿起又放下不产生 drink/refill', () => {
  const r = run({ steps: smoke(), scale: 600, reportMs: 10_000 });
  // smoke 里有一次"拿起又放下";drink 应只有脚本里显式的 2 次
  assert.equal(count(r.events, 'drink'), 2, '拿起放下不应被算成喝');
});

test('摇晃去抖:一次摇晃只报一次', () => {
  const r = run({ steps: smoke(), scale: 600, reportMs: 10_000 });
  assert.equal(count(r.events, 'shake'), 1, '1500ms 摇晃应只报 1 次');
});

test('判定:轻微拿起(未越阈值)不触发 drink', () => {
  // 直接验证引擎在"拿起→放回但重量不变"时不产 drink
  const r = run({ steps: smoke(), scale: 600, reportMs: 10_000 });
  const drinks = r.events.filter((e) => e.type === 'drink');
  for (const d of drinks) {
    assert.ok((d.amount_ml ?? 0) >= 30, `drink 量应 >= 阈值,实际 ${d.amount_ml}`);
  }
});

test('可复现:同 seed 两次运行结果一致', () => {
  const a = run({ steps: smoke(), scale: 600, reportMs: 10_000, seed: 7 });
  const b = run({ steps: smoke(), scale: 600, reportMs: 10_000, seed: 7 });
  assert.equal(a.events.length, b.events.length);
  assert.deepEqual(
    a.events.map((e) => e.type),
    b.events.map((e) => e.type),
  );
});

test('时间加速不改变行为分辨率:不同 scale 得到相同事件集', () => {
  const slow = run({ steps: smoke(), scale: 60, reportMs: 10_000 });
  const fast = run({ steps: smoke(), scale: 6000, reportMs: 10_000 });
  assert.deepEqual(
    slow.events.map((e) => e.type),
    fast.events.map((e) => e.type),
    '加速倍率不应影响事件序列',
  );
});

// ── 手势(创意备忘 §5.1 #1:轻磕/长按 → 确认)──────────────────────
// 以 20ms 虚拟步长驱动,避免 runToEnd 的 250ms 粗步长把 150ms 轻磕量化掉。

test('手势:轻磕 → tap,长按 → long_press,均带 duration_ms', () => {
  const events: CupEvent[] = [];
  const engine = new Engine({
    config: { seed: 42, scale: 1, startMs: Date.UTC(2026, 9, 7, 0, 0, 0), reportMs: 1000, verbose: false },
    steps: [gestureStep(2000, 150), gestureStep(5000, 900)],
    sink: (f) => events.push(...f.events),
  });
  for (let i = 0; i < 400; i++) engine.step(20); // 推进 8s 虚拟

  const taps = events.filter((e) => e.type === 'tap');
  const longs = events.filter((e) => e.type === 'long_press');
  assert.equal(taps.length, 1, '一次轻磕恰好一个 tap');
  assert.equal(longs.length, 1, '一次长按恰好一个 long_press');
  assert.ok((taps[0]!.duration_ms ?? 0) >= 40, 'tap 必须带 duration_ms');
  assert.ok((longs[0]!.duration_ms ?? 0) >= 600, 'long_press 时长应 >= 600ms');
  assert.equal(taps[0]!.derived_by, 'lid');
  assert.equal(longs[0]!.derived_by, 'lid');
});

test('手势非紧急:随下次上报捎带(不即时单独发)', () => {
  const frames: Frame[] = [];
  const engine = new Engine({
    config: { seed: 1, scale: 1, startMs: Date.UTC(2026, 9, 7, 0, 0, 0), reportMs: 1000, verbose: false },
    steps: [gestureStep(200, 120)],
    sink: (f) => frames.push(f),
  });
  for (let i = 0; i < 100; i++) engine.step(20); // 推进 2s

  const gestureFrames = frames.filter((f) => f.events.some((e) => e.type === 'tap'));
  assert.equal(gestureFrames.length, 1, '恰在一个上报帧里出现');
  assert.ok(gestureFrames[0]!.lid, '手势随常规上报捎带(帧内带杯盖遥测)');
});

test('手势:过短接触(<40ms)视为抖动,不产生事件', () => {
  const events: CupEvent[] = [];
  const engine = new Engine({
    config: { seed: 42, scale: 1, startMs: Date.UTC(2026, 9, 7, 0, 0, 0), reportMs: 1000, verbose: false },
    steps: [gestureStep(1000, 20)], // 20ms,短于抖动阈值
    sink: (f) => events.push(...f.events),
  });
  for (let i = 0; i < 200; i++) engine.step(20);
  assert.equal(count(events, 'tap'), 0, '抖动不产生 tap');
  assert.equal(count(events, 'long_press'), 0, '抖动不产生 long_press');
});
