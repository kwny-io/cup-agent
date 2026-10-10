/**
 * 模拟器行为测试 —— 把"跑起来看着对"固化成断言。
 * 对应 plan.md M0 验收标准 1、2。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, type Frame } from '@cup/simulator';
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
  // 脚本里有 7 次 drink,3 次 refill/hotWater,2 次 shake
  assert.equal(count(r.events, 'drink'), 7, 'drink 次数');
  assert.equal(count(r.events, 'refill'), 3, 'refill 次数');
  assert.equal(count(r.events, 'shake'), 2, 'shake 次数');
  assert.equal(count(r.events, 'temp_alert'), 1, '倒 72°C 热水触发一次过热');
  assert.equal(count(r.events, 'off_base'), 1, '只有傍晚真正带走算 off_base');
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
