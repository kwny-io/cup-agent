/**
 * 身体语料(§5.1 #2)测试 —— 杯子对**身上真实发生的事**(被摔/烫/没电/被忘)有反应。
 *
 * 分两层钉:
 *   · 纯函数:`bodyCueFromEvents` / `abandonedCue` 的选择与阈值;
 *   · 接线:调度器把 cue 变成一句走"主动开口"通道的话(与欠水提醒**共用冷却**),
 *     并且 get_self 的产出把身体数字带进数字守卫(模型说"12%"不算凭空)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryStore,
  MemoryChatStore,
  CommandQueue,
  MockChatLlm,
  LiveHub,
  ProactiveScheduler,
  getTool,
  runChat,
  bodyCueFromEvents,
  abandonedCue,
  ABANDON_HOURS,
  BODY_PROMPT_INTRO,
  callTool,
  say,
  type ToolCtx,
  type LiveFrame,
  type ChatStore,
  type FusedSample,
  type TelemetryPoint,
} from '@cup/server';
import type { CupEvent, LidTelemetry } from '@cup/contract';

const CUP = 'cup-A1B2C3';
const HOUR = 3_600_000;
// 20:00 —— 既不在欠水窗口(14–18),也不在夜间静默(22–7):只可能被身体 cue 触发
const T_2000 = new Date(2026, 9, 8, 20, 0, 0).getTime();
// 15:00 —— 欠水窗口内
const T_1500 = new Date(2026, 9, 8, 15, 0, 0).getTime();
// 03:00 —— 夜间静默内
const T_0300 = new Date(2026, 9, 8, 3, 0, 0).getTime();

function ev(ts: number, type: 'shake' | 'temp_alert' | 'low_battery', extra: Partial<CupEvent> = {}): CupEvent {
  return { v: 1, cup_id: CUP, device_id: 'lid-A1B2C3', ts, type, confidence: 0.9, derived_by: 'lid', ...extra };
}
function drink(ts: number, ml: number): CupEvent {
  return { v: 1, cup_id: CUP, device_id: 'base-A1B2C3', ts, type: 'drink', amount_ml: ml, confidence: 0.9, derived_by: 'base' };
}
function lidAt(ts: number, battery_pct: number, temp_c: number): TelemetryPoint {
  const lid: LidTelemetry = {
    v: 1,
    device_id: 'lid-A1B2C3',
    cup_id: CUP,
    ts,
    seq: 1,
    sample_ms: 1000,
    temp_c,
    level_mm: 100,
    level_pct: 50,
    motion: 'idle',
    tilt_deg: 0,
    tilt_dir: 0,
    battery_pct,
    charging: false,
  };
  return { cup_id: CUP, device_id: 'lid-A1B2C3', kind: 'lid', ts, seq: 1, lid };
}
function fusedAt(ts: number, present = true): FusedSample {
  return {
    cup_id: CUP,
    ts,
    volume_ml: 400,
    level_pct: 30,
    temp_c: 45,
    confidence: 0.9,
    derived_by: 'base',
    present,
    stable: true,
  };
}

function spyLive(): { live: LiveHub; frames: LiveFrame[] } {
  const live = new LiveHub();
  const frames: LiveFrame[] = [];
  live.broadcast = (f: LiveFrame) => {
    frames.push(f);
  };
  return { live, frames };
}

function makeScheduler(opts: { store: MemoryStore; memory: ChatStore; chat: MockChatLlm; live: LiveHub; now: number }) {
  return new ProactiveScheduler({
    store: opts.store,
    commands: new CommandQueue(),
    chat: opts.chat,
    memory: opts.memory,
    live: opts.live,
    log: () => {},
    cups: () => [CUP],
    now: () => opts.now,
  });
}

// ── 纯函数 ───────────────────────────────────────────────────────

test('bodyCue: shake→hurt / temp_alert→hot / low_battery→tired;取最新一条', () => {
  assert.equal(bodyCueFromEvents([ev(1000, 'shake')])!.cue, 'hurt');
  assert.equal(bodyCueFromEvents([ev(1000, 'temp_alert')])!.cue, 'hot');
  assert.equal(bodyCueFromEvents([ev(1000, 'low_battery')])!.cue, 'tired');
  // 多条时取 ts 最大的
  assert.equal(bodyCueFromEvents([ev(1000, 'shake'), ev(2000, 'temp_alert')])!.cue, 'hot');
  // 不相关的事件 → null
  assert.equal(bodyCueFromEvents([drink(1000, 200)]), null);
  assert.equal(bodyCueFromEvents([]), null);
});

test('abandonedCue:从未见过 → null(新杯子不该装幽闭)', () => {
  assert.equal(abandonedCue(null, T_2000), null);
});

test('abandonedCue:静默不足阈值 → null;超过 → hit', () => {
  assert.equal(abandonedCue(T_2000 - 1 * HOUR, T_2000), null);
  assert.equal(abandonedCue(T_2000 - (ABANDON_HOURS - 1) * HOUR, T_2000), null);
  assert.equal(abandonedCue(T_2000 - (ABANDON_HOURS + 1) * HOUR, T_2000)!.cue, 'abandoned');
});

// ── 接线:调度器 ─────────────────────────────────────────────────

test('身体:被摔(shake)→ 主动开口一次,且问句带身体提示、不含数字', async () => {
  const store = new MemoryStore();
  store.appendEvent(ev(T_2000 - 60_000, 'shake')); // 一分钟前被摔
  const { live, frames } = spyLive();
  const sch = makeScheduler({ store, memory: new MemoryChatStore(), chat: new MockChatLlm([callTool('get_self', {}), say('喂!摔疼我了,小心点。')]), live, now: T_2000 });

  const fired = await sch.tick(T_2000);
  assert.equal(fired.length, 1);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.kind, 'proactive');
  // 记的是 proactive 轮(与欠水提醒同通道,故共用冷却)
  assert.equal(fired[0]!.text, '喂!摔疼我了,小心点。');
});

test('身体:提示词不含任何数字(免得凭空数字污染守卫)', () => {
  assert.ok(!/\d/.test(BODY_PROMPT_INTRO), '身体提示前缀不该含数字');
});

test('身体:与欠水提醒**共用冷却** → 开口后 2h 内不再说', async () => {
  const store = new MemoryStore();
  store.appendEvent(ev(T_2000 - 60_000, 'shake'));
  const { live } = spyLive();
  const sch = makeScheduler({ store, memory: new MemoryChatStore(), chat: new MockChatLlm([callTool('get_self', {}), say('疼。')]), live, now: T_2000 });

  await sch.tick(T_2000);
  assert.equal((await sch.tick(T_2000 + 10 * 60_000)).length, 0); // 仅过 10 分钟
});

test('身体:旧的 shake 被讲过之后不再重提(只看上次开口之后的事件)', async () => {
  const store = new MemoryStore();
  // 14:00 的 shake,已被 15:00 那次开口讲掉
  store.appendEvent(ev(T_1500 - HOUR, 'shake'));
  const { live } = spyLive();
  const mem = new MemoryChatStore();
  mem.appendTurn({ cup_id: CUP, ts: T_1500, role: 'proactive', text: '摔疼我了。' });
  const sch = makeScheduler({ store, memory: mem, chat: new MockChatLlm([say('不该说')]), live, now: T_2000 });

  // 20:00 再看:那次 shake 在"上次开口"之前 → 不该重提;20:00 也不是欠水窗口 → 无话
  assert.equal((await sch.tick(T_2000)).length, 0);
});

test('身体:被忘(静默超 6h)→ 主动开口一次', async () => {
  const store = new MemoryStore();
  store.setLatestSample(fusedAt(T_2000 - (ABANDON_HOURS + 1) * HOUR)); // 7 小时前最后一次被感知
  const { live, frames } = spyLive();
  const sch = makeScheduler({ store, memory: new MemoryChatStore(), chat: new MockChatLlm([callTool('get_self', {}), say('哼,你就把我晾这儿?')]), live, now: T_2000 });

  const fired = await sch.tick(T_2000);
  assert.equal(fired.length, 1);
  assert.equal(frames[0]!.kind, 'proactive');
});

test('身体:夜间静默(03:00 被摔)→ 不开口', async () => {
  const store = new MemoryStore();
  store.appendEvent(ev(T_0300 - 60_000, 'shake'));
  const { live } = spyLive();
  const sch = makeScheduler({ store, memory: new MemoryChatStore(), chat: new MockChatLlm([say('x')]), live, now: T_0300 });

  assert.equal((await sch.tick(T_0300)).length, 0);
});

test('身体:没有 cue 时不抢占欠水提醒(15:00 欠水照常开口)', async () => {
  const store = new MemoryStore();
  store.applyEventToAgg(drink(T_1500, 400)); // 只喝了 400 < 0.5*1500
  const { live } = spyLive();
  const sch = makeScheduler({ store, memory: new MemoryChatStore(), chat: new MockChatLlm([callTool('get_today', {}), say('才 400ml,该喝水了。')]), live, now: T_1500 });

  const fired = await sch.tick(T_1500);
  assert.equal(fired.length, 1);
  assert.match(fired[0]!.text, /400/);
});

// ── get_self:把身体数字带进数字守卫 ─────────────────────────────

test('get_self:产出电量/水温/姿态等真实身体事实', () => {
  const store = new MemoryStore();
  store.appendTelemetry(lidAt(T_2000, 12, 72));
  store.setLatestSample({ ...fusedAt(T_2000), temp_c: null }); // 融合样本无水温 → 退到杯盖遥测
  const ctx: ToolCtx = { store, commands: new CommandQueue(), now: () => T_2000 };

  const out = getTool('get_self')!.run(ctx, CUP, {}).output as {
    battery_pct: number;
    temp_c: number;
    low_battery: boolean;
    too_hot: boolean;
    on_base: boolean;
    neglected: boolean;
  };
  assert.equal(out.battery_pct, 12);
  assert.equal(out.temp_c, 72);
  assert.equal(out.low_battery, true);
  assert.equal(out.too_hot, true);
  assert.equal(out.on_base, true);
  assert.equal(out.neglected, false);
});

test('get_self:模型复述电量数字(12%)→ 过守卫,source=llm', async () => {
  const store = new MemoryStore();
  store.appendTelemetry(lidAt(T_2000, 12, 45));
  store.setLatestSample(fusedAt(T_2000));
  const deps = {
    store,
    commands: new CommandQueue(),
    chat: new MockChatLlm([callTool('get_self', {}), say('电量就剩 12% 了,哼,快给我充电。')]),
    memory: new MemoryChatStore(),
    log: () => {},
    now: () => T_2000,
  };
  const a = await runChat(deps, { cupId: CUP, question: '你还有电吗' });
  assert.equal(a.source, 'llm');
  assert.match(a.text, /12/);
});
