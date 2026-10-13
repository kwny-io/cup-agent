/**
 * 成长庆祝下行 —— `core/growth-notify.ts`。
 *
 * 钉四件事:
 *   1. **今天新跨坎 → 入队一条 `remind`**,`payload.reason='milestone'` + id/label(固件只认这三样)。
 *   2. **今天没跨坎 → 一条都不发**(不天天庆祝)。
 *   3. **契约零改动**:复用 `remind`,payload 是自由键值(§2.1)。
 *   4. **纯旁路**:store 抛错只吞不抛 —— 庆祝失败绝不能影响 ingest 主路径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGrowthNotifier, CommandQueue, type GrowthNotifyStore } from '@cup/server';
import type { DailyAgg } from '@cup/server';
import type { CupEvent } from '@cup/contract';

const CUP = 'cup-A1B2C3';
const GOAL = 1500;

/** 一天"有活动"的聚合(drank>0 即有活动;streak 不参与 celebrate 的 together 类) */
function active(date: string, over: Partial<DailyAgg> = {}): DailyAgg {
  return {
    cup_id: CUP,
    date,
    drank_ml: 600,
    refill_ml: 0,
    drink_count: 1,
    goal_ml: GOAL,
    temp_min_c: null,
    temp_max_c: null,
    temp_avg_c: null,
    last_volume_ml: null,
    streak: 0,
    event_count: 1,
    updated_at: 1,
    ...over,
  };
}

function drinkEvent(ts: number): CupEvent {
  return { v: 1, cup_id: CUP, device_id: 'lid-A1B2C3', ts, type: 'drink', amount_ml: 300, confidence: 0.9, derived_by: 'lid' };
}

/** 假 store:只回一个固定窗口 */
function fakeStore(recent: DailyAgg[] | (() => Promise<DailyAgg[]>)): GrowthNotifyStore {
  return {
    recentAggs: async () => (typeof recent === 'function' ? await recent() : recent),
  };
}

/** 触发一次后等异步旁路跑完(event 回调是同步签名,内部 fire-and-forget) */
async function fire(notify: (e: CupEvent) => void): Promise<void> {
  notify(drinkEvent(Date.now()));
  await new Promise((r) => setTimeout(r, 10));
}

test('今天新跨坎 → 入队一条 remind(reason=milestone)', async () => {
  const cmdq = new CommandQueue();
  // 6 天有活动 + 今天也有 → days_together=7,昨天是 6 → together_7 今天刚解锁
  const window = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'].map((d) => active(d));
  const notify = makeGrowthNotifier({ store: fakeStore(window), commands: cmdq, now: () => 1_700_000_000_000 });

  await fire(notify);

  const q = cmdq.allCommands();
  assert.equal(q.length, 1, '应恰好入队一条');
  const cmd = q[0]!;
  assert.equal(cmd.type, 'remind', '复用 remind 下行');
  assert.equal(cmd.target, 'lid-A1B2C3', '默认目标设备');
  assert.equal(cmd.payload.reason, 'milestone');
  assert.equal(cmd.payload.id, 'together_7', '今天新解锁的是「一起一周」');
  assert.equal(cmd.payload.label, '一起一周');
  assert.ok(cmd.payload.threshold === 7);
});

test('今天没跨坎 → 一条不发', async () => {
  const cmdq = new CommandQueue();
  // 10 天全有活动:together_3 / together_7 昨天就已达成 → 今天没有"新"解锁
  const window = Array.from({ length: 10 }, (_, i) => active(`d${i + 1}`));
  const notify = makeGrowthNotifier({ store: fakeStore(window), commands: cmdq });

  await fire(notify);

  assert.equal(cmdq.allCommands().length, 0, '没跨坎不该发');
});

test('空窗口 → 不发', async () => {
  const cmdq = new CommandQueue();
  const notify = makeGrowthNotifier({ store: fakeStore([]), commands: cmdq });
  await fire(notify);
  assert.equal(cmdq.allCommands().length, 0);
});

test('store 抛错 → 只吞不抛(旁路不毁主路径)', async () => {
  const cmdq = new CommandQueue();
  const store: GrowthNotifyStore = {
    recentAggs: async () => {
      throw new Error('db down');
    },
  };
  const notify = makeGrowthNotifier({ store, commands: cmdq });
  // 不 throw 即为通过
  await fire(notify);
  assert.equal(cmdq.allCommands().length, 0);
});

test('同一天重复 ingest 同一道坎 → 只发一条(去重)', async () => {
  const cmdq = new CommandQueue();
  const window = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'].map((d) => active(d));
  const notify = makeGrowthNotifier({ store: fakeStore(window), commands: cmdq, now: () => 1_700_000_000_000 });

  // 关键:一次灌 7 条**不等待**(模拟真实 ingest 同步回调连发),证明去重挡住重复
  for (let i = 0; i < 7; i++) notify(drinkEvent(Date.now()));
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(cmdq.allCommands().length, 1, '同一天同一道坎只该发一条');
});

test('跨天可再庆祝:换天后同 id 是新 key', async () => {
  const cmdq = new CommandQueue();
  const window = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'].map((d) => active(d));
  let clock = 1_700_000_000_000;
  const notify = makeGrowthNotifier({ store: fakeStore(window), commands: cmdq, now: () => clock });

  await fire(notify); // 第一天跨 together_7 → 1 条
  clock += 24 * 3_600_000; // 挪到"明天"(窗口仍是同一份,celebrate 依旧 together_7)
  await fire(notify); // 新日期 → 新 key → 再发一条

  assert.equal(cmdq.allCommands().length, 2, '换天后应视为新的庆祝');
});

test('cmd_id 含杯与里程碑,可辨识', async () => {
  const cmdq = new CommandQueue();
  const window = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'].map((d) => active(d));
  const notify = makeGrowthNotifier({ store: fakeStore(window), commands: cmdq, now: () => 123 });
  await fire(notify);
  const cmd = cmdq.allCommands()[0]!;
  assert.match(cmd.cmd_id, /together_7/);
  assert.match(cmd.cmd_id, new RegExp(CUP));
});
