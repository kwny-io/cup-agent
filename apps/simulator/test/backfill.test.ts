/**
 * 多日回填测试 —— 把"造出来的历史"钉死:可复现、旧→新、契约合规、两档语义。
 * 纯合成,零网络(HTTP 薄壳 runBackfill 不在单测范围,靠端到端手验)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBackfill, DEFAULT_GOAL_ML } from '@cup/simulator';
import { UpstreamFrameSchema } from '@cup/contract';

const CUP = 'cup-A1B2C3';
const BASE = 'base-A1B2C3';
/** 固定"今天"本地 00:00,避免依赖真实时钟 */
const END = new Date(2026, 9, 14, 0, 0, 0).getTime(); // 2026-10-14

function plan(days: number, tier?: 'goal' | 'sparse', seed = 42) {
  return buildBackfill({ cupId: CUP, baseId: BASE, days, tier, seed, endMs: END });
}

test('可复现:同 seed 两次生成逐字节一致', () => {
  const a = plan(30);
  const b = plan(30);
  assert.deepEqual(a, b);
});

test('不同 seed → 不同饮水分配(确实吃了随机)', () => {
  const a = plan(30, 'goal', 1);
  const b = plan(30, 'goal', 2);
  assert.notDeepEqual(
    a.map((d) => d.events.map((e) => e.amount_ml)),
    b.map((d) => d.events.map((e) => e.amount_ml)),
  );
});

test('旧 → 新:日期升序,每天帧 ts 升序', () => {
  const p = plan(60);
  assert.equal(p.length, 60);
  for (let i = 1; i < p.length; i++) {
    assert.ok(p[i]!.atMs > p[i - 1]!.atMs, '日期必须升序(旧→新)');
  }
  for (const day of p) {
    const ts = day.events.map((e) => e.ts);
    const sorted = [...ts].sort((x, y) => x - y);
    assert.deepEqual(ts, sorted, `${day.date} 天内事件须按 ts 升序`);
  }
});

test('今天 = 最后一天:紧邻入参 endMs 那天', () => {
  const p = plan(7);
  assert.equal(p[p.length - 1]!.atMs, END, '最后一天应是注入的"今天"');
  assert.equal(p[0]!.atMs, END - 6 * 86_400_000, '首日应是 endMs-(days-1)天');
  assert.equal(p[0]!.date, '2026-10-08');
  assert.equal(p[6]!.date, '2026-10-14');
});

test('days=1:只有今天', () => {
  const p = plan(1);
  assert.equal(p.length, 1);
  assert.equal(p[0]!.date, '2026-10-14');
});

test('goal 档:每天喝水合计 ≥ goal(必达标)', () => {
  const p = plan(45, 'goal');
  for (const day of p) {
    const drank = day.events.filter((e) => e.type === 'drink').reduce((s, e) => s + (e.amount_ml ?? 0), 0);
    assert.ok(drank >= DEFAULT_GOAL_ML, `${day.date} drank ${drank} 应 ≥ ${DEFAULT_GOAL_ML}`);
  }
});

test('goal 档:隔天续杯(偶数天有 refill)', () => {
  const p = plan(10, 'goal');
  for (let i = 0; i < p.length; i++) {
    const refills = p[i]!.events.filter((e) => e.type === 'refill').length;
    assert.equal(refills, i % 2 === 0 ? 1 : 0, `第 ${i} 天 refill 数(隔天续杯)`);
  }
});

test('sparse 档:只有最早一天达标,今天只是轻饮(连击归零)', () => {
  const p = plan(20, 'sparse');
  const first = p[0]!.events.filter((e) => e.type === 'drink').reduce((s, e) => s + (e.amount_ml ?? 0), 0);
  assert.ok(first >= DEFAULT_GOAL_ML, '最早一天应达标(撑起跨度)');
  // 中间天全空
  for (let i = 1; i < p.length - 1; i++) {
    assert.equal(p[i]!.events.length, 0, `第 ${i} 天应为空`);
  }
  const today = p[p.length - 1]!.events.filter((e) => e.type === 'drink').reduce((s, e) => s + (e.amount_ml ?? 0), 0);
  assert.ok(today > 0 && today < DEFAULT_GOAL_ML, '今天轻度饮水,未达标');
});

test('契约合规:每个 frame 都过 UpstreamFrameSchema', () => {
  for (const tier of ['goal', 'sparse'] as const) {
    for (const day of plan(15, tier)) {
      for (const f of day.frames) {
        const r = UpstreamFrameSchema.safeParse(f);
        assert.ok(r.success, `${day.date} 帧不合契约: ${r.success ? '' : JSON.stringify(r.error.issues)}`);
      }
    }
  }
});

test('事件只含 drink/refill,且设备 id/cup id 正确', () => {
  for (const day of plan(15)) {
    for (const e of day.events) {
      assert.ok(e.type === 'drink' || e.type === 'refill', `意外事件类型 ${e.type}`);
      assert.equal(e.cup_id, CUP);
      assert.equal(e.device_id, BASE, '回填走底座派生(base.ts 口径)');
      assert.equal(e.derived_by, 'base');
      assert.ok((e.amount_ml ?? 0) > 0, 'drink/refill 必带正 amount_ml');
    }
  }
});
