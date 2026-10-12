/**
 * 记忆卡 + recall 测试(第 3 阶段)。
 *
 * 三层都钉:
 *   · 纯函数:buildCardDetails / turnsSummary 从真实来源拼卡、线索去重、封顶;
 *   · 封存:closeDayCard 幂等 UPSERT、不建空卡;maybeCloseDay 天翻页水位;
 *   · 接线:proactive.tick 天翻页封昨天、recall 工具把卡喂回 agent 且数字进守卫。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryStore,
  MemoryChatStore,
  CommandQueue,
  LiveHub,
  ProactiveScheduler,
  getTool,
  runChat,
  buildCardDetails,
  closeDayCard,
  maybeCloseDay,
  turnsSummary,
  dayKey,
  shiftDay,
  callTool,
  say,
  MockChatLlm,
  type ChatDeps,
  type ToolCtx,
  type DailyAgg,
} from '@cup/server';
import type { CupEvent } from '@cup/contract';

const CUP = 'cup-A1B2C3';
const DAY = new Date(2026, 9, 8, 15, 0, 0).getTime(); // 2026-10-08 15:00 本地
const TODAY = dayKey(DAY);

function ev(ts: number, type: CupEvent['type'], over: Partial<CupEvent> = {}): CupEvent {
  return {
    v: 1,
    cup_id: CUP,
    device_id: 'lid-A1B2C3',
    ts,
    type,
    confidence: 0.9,
    derived_by: 'lid',
    ...over,
  };
}

function agg(over: Partial<DailyAgg> = {}): DailyAgg {
  return {
    cup_id: CUP,
    date: TODAY,
    drank_ml: 1200,
    refill_ml: 500,
    drink_count: 4,
    goal_ml: 1500,
    temp_min_c: 38,
    temp_max_c: 55,
    temp_avg_c: 46,
    last_volume_ml: 300,
    streak: 3,
    event_count: 6,
    updated_at: DAY,
    ...over,
  };
}

// ── 纯函数:buildCardDetails ─────────────────────────────────────

test('build: 数值/达标/续杯次数/水温区间全来自真实来源', () => {
  const events = [
    ev(DAY, 'drink', { amount_ml: 300 }),
    ev(DAY + 1, 'refill', { amount_ml: 500 }),
    ev(DAY + 2, 'refill', { amount_ml: 400 }),
  ];
  const d = buildCardDetails(agg(), events, []);
  assert.equal(d.drank_ml, 1200);
  assert.equal(d.goal_ml, 1500);
  assert.equal(d.reached, false);
  assert.equal(d.streak, 3);
  assert.equal(d.refill_count, 2); // 两条 refill
  assert.deepEqual(d.temp_range, [38, 55]);
});

test('build: reached 达标判定(goal>0 且 drank>=goal)', () => {
  const d = buildCardDetails(agg({ drank_ml: 1500 }), [], []);
  assert.equal(d.reached, true);
  const noGoal = buildCardDetails(agg({ goal_ml: 0, drank_ml: 0 }), [], []);
  assert.equal(noGoal.reached, false); // goal=0 不算达标
});

test('build: 显著事件只收身体/交互类,drink/refill 不进 notable,按 ts 升序', () => {
  const events = [
    ev(DAY + 300, 'shake'),
    ev(DAY + 100, 'drink', { amount_ml: 200 }),
    ev(DAY + 200, 'temp_alert'),
  ];
  const d = buildCardDetails(agg(), events, []);
  assert.deepEqual(d.notable_events, [
    { type: 'temp_alert', ts: DAY + 200 },
    { type: 'shake', ts: DAY + 300 },
  ]);
});

test('build: body_cues 由事件类型映射,同 cue 去重取最早证据', () => {
  const events = [
    ev(DAY + 100, 'shake'),
    ev(DAY + 200, 'shake'), // 同 cue → 只留一条(最早)
    ev(DAY + 300, 'low_battery'),
  ];
  const d = buildCardDetails(agg(), events, []);
  assert.deepEqual(d.body_cues, [
    { cue: 'hurt', evidence: `shake@${DAY + 100}` },
    { cue: 'tired', evidence: `low_battery@${DAY + 300}` },
  ]);
});

test('build: 无水温 → temp_range=null', () => {
  const d = buildCardDetails(agg({ temp_min_c: null, temp_max_c: null }), [], []);
  assert.equal(d.temp_range, null);
});

test('turnsSummary: 有 user 轮 → 首句主人的话;只有主动 → 记主动那句;空 → null', () => {
  assert.equal(
    turnsSummary([
      { cup_id: CUP, ts: DAY, role: 'proactive', text: '喂,喝水' },
      { cup_id: CUP, ts: DAY + 1, role: 'user', text: '今天喝得怎么样' },
    ]),
    '主人问过「今天喝得怎么样」',
  );
  assert.equal(
    turnsSummary([{ cup_id: CUP, ts: DAY, role: 'proactive', text: '喂,喝水' }]),
    '杯子主动说过「喂,喝水」',
  );
  assert.equal(turnsSummary([]), null);
  assert.equal(turnsSummary([{ cup_id: CUP, ts: DAY, role: 'assistant', text: '哼' }]), null); // 只有 assistant → null
});

// ── 封存:closeDayCard / maybeCloseDay ───────────────────────────

test('closeDayCard: 有事件 → 建卡;同天再封 → 幂等覆盖(不新增)', async () => {
  const store = new MemoryStore();
  const memory = new MemoryChatStore();
  await store.applyEventToAgg(ev(DAY, 'drink', { amount_ml: 800 }));
  const c1 = await closeDayCard(store, memory, CUP, TODAY, DAY);
  assert.ok(c1);
  assert.equal(c1.details.drank_ml, 800);
  // 再封一次(数据没变)→ 覆盖,仍只一张
  await closeDayCard(store, memory, CUP, TODAY, DAY + 1000);
  const recent = await store.recentMemoryCards(CUP, TODAY, 3);
  assert.equal(recent.length, 1);
  assert.equal(recent[0]!.built_at, DAY + 1000); // built_at 被更新
});

test('closeDayCard: 那天既无事件又无对话 → 不建空卡(null)', async () => {
  const store = new MemoryStore();
  const memory = new MemoryChatStore();
  const empty = dayKey(new Date(2026, 0, 1).getTime());
  assert.equal(await closeDayCard(store, memory, CUP, empty, DAY), null);
  assert.equal(await store.memoryCard(CUP, empty), null);
});

test('closeDayCard: 只有对话没事件 → 仍建卡(留住了那天的聊天)', async () => {
  const store = new MemoryStore();
  const memory = new MemoryChatStore();
  await memory.appendTurn({ cup_id: CUP, ts: DAY, role: 'user', text: '你好呀' });
  const c = await closeDayCard(store, memory, CUP, TODAY, DAY);
  assert.ok(c);
  assert.equal(c.details.turn_count, 1);
  assert.match(c.details.turns_summary!, /你好呀/);
});

test('maybeCloseDay: 首次封昨天;同一天再调 → 无操作(水位)', async () => {
  const store = new MemoryStore();
  const memory = new MemoryChatStore();
  const yesterday = shiftDay(TODAY, -1);
  // 昨天有数据
  const yTs = new Date(2026, 9, 7, 15, 0, 0).getTime();
  await store.applyEventToAgg(ev(yTs, 'drink', { amount_ml: 900 }));

  const d1 = await maybeCloseDay(store, memory, CUP, DAY, null);
  assert.equal(d1, TODAY);
  const card = await store.memoryCard(CUP, yesterday);
  assert.ok(card, '昨天应被封卡');
  assert.equal(card.details.drank_ml, 900);

  // 同一天再调 → 直接返回,不重复封
  const d2 = await maybeCloseDay(store, memory, CUP, DAY + 60_000, d1);
  assert.equal(d2, TODAY);
  // 已封过 → 再调水位是 TODAY,里面 no-op(卡还在)
  assert.ok(await store.memoryCard(CUP, yesterday));
});

// ── 接线:proactive.tick 天翻页 ─────────────────────────────────

test('接线: tick 天翻页 → 封昨天那张卡', async () => {
  const store = new MemoryStore();
  const memory = new MemoryChatStore();
  const yTs = new Date(2026, 9, 7, 15, 0, 0).getTime();
  const yesterday = shiftDay(TODAY, -1);
  await store.applyEventToAgg(ev(yTs, 'drink', { amount_ml: 700 }));

  const sch = new ProactiveScheduler({
    store,
    commands: new CommandQueue(),
    chat: new MockChatLlm([]),
    memory,
    live: new LiveHub(),
    log: () => {},
    cups: () => [CUP],
    now: () => DAY,
  });
  await sch.tick(DAY);
  assert.ok(await store.memoryCard(CUP, yesterday), 'tick 应封昨天');
});

// ── recall 工具 ─────────────────────────────────────────────────

test('recall: 无参数默认最近 7 天,只含已有卡的天', async () => {
  const store = new MemoryStore();
  await store.applyEventToAgg(ev(DAY, 'drink', { amount_ml: 1000 }));
  await closeDayCard(store, new MemoryChatStore(), CUP, TODAY, DAY);
  const ctx: ToolCtx = { store, commands: new CommandQueue(), now: () => DAY };
  const out = (await getTool('recall')!.run(ctx, CUP, {})).output as { days: number; cards: unknown[] };
  assert.equal(out.days, 1);
  assert.equal(out.cards.length, 1);
});

test('recall: 指定 day → 只取那天;没有 → 空', async () => {
  const store = new MemoryStore();
  await store.applyEventToAgg(ev(DAY, 'drink', { amount_ml: 1000 }));
  await closeDayCard(store, new MemoryChatStore(), CUP, TODAY, DAY);
  const ctx: ToolCtx = { store, commands: new CommandQueue(), now: () => DAY };
  const hit = (await getTool('recall')!.run(ctx, CUP, { day: TODAY })).output as { days: number };
  assert.equal(hit.days, 1);
  const miss = (await getTool('recall')!.run(ctx, CUP, { day: '2000-01-01' })).output as { days: number };
  assert.equal(miss.days, 0);
});

test('recall: 参数收口 —— 非法 day / recent 越界 → {ok:false}', async () => {
  const store = new MemoryStore();
  const ctx: ToolCtx = { store, commands: new CommandQueue(), now: () => DAY };
  const tool = getTool('recall')!;
  assert.equal(tool.parse({ day: '2026/10/08' }), null); // 非 YYYY-MM-DD
  assert.equal(tool.parse({ recent: 0 }), null); // < 1
  assert.equal(tool.parse({ recent: 31 }), null); // > 30
  assert.ok(tool.parse({}) !== null); // 空参合法(默认 7 天)
  assert.ok(tool.parse({ recent: 30 }) !== null); // 边界合法
  void ctx;
});

test('recall 是读工具:不在写预算里(可与写工具同轮)', () => {
  assert.equal(getTool('recall')!.isWrite, false);
});

test('闭环: recall 喂回的数字进数字守卫(模型复述卡里的数不算凭空)', async () => {
  const store = new MemoryStore();
  const memory = new MemoryChatStore();
  // 昨天喝了 900ml,今天问"前天/最近怎么样"
  const yTs = new Date(2026, 9, 7, 15, 0, 0).getTime();
  await store.applyEventToAgg(ev(yTs, 'drink', { amount_ml: 900 }));
  await closeDayCard(store, memory, CUP, shiftDay(TODAY, -1), DAY);

  const deps: ChatDeps = {
    store,
    commands: new CommandQueue(),
    chat: new MockChatLlm([callTool('recall', { recent: 7 }), say('我记得那天你喝了 900ml 呢。')]),
    memory,
    log: () => {},
    now: () => DAY,
  };
  const a = await runChat(deps, { cupId: CUP, question: '我前几天喝得怎么样' });
  assert.equal(a.source, 'llm'); // 900 来自 recall 的卡 → 过守卫
  assert.ok(a.tools_used.includes('recall'));
});
