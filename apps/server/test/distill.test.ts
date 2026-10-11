/**
 * 画像蒸馏(distill.ts)测试 —— profile() 的**写端**。
 *
 * 钉死:
 *   · 没攒够新轮 → 不蒸(不白跑)
 *   · 攒够 + 模型给合法画像 → 采用(source='llm')
 *   · 模型给凭空数字 → 守卫拦下 → 落确定性模板(source='template')
 *   · 模型不可用(NullChatLlm)→ 模板兜底,数字来自真实日聚合
 *   · 蒸馏后水位推进,再蒸要等新轮;画像 + 水位跨重启存活
 *   · ProactiveScheduler.tick 会顺带推进蒸馏
 *   · 闭环:蒸馏出的画像交给读端,复述画像数字能过守卫(不是白写)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryStore,
  MemoryChatStore,
  CommandQueue,
  NullChatLlm,
  MockChatLlm,
  LiveHub,
  FilePersistence,
  FileChatStore,
  ProactiveScheduler,
  distillProfile,
  acceptProfile,
  distillDue,
  templateProfile,
  runChat,
  callTool,
  say,
  type ChatDeps,
  type ChatStore,
  type DistillDeps,
} from '@cup/server';
import type { CupEvent } from '@cup/contract';

const CUP = 'cup-A1B2C3';
const NOW = new Date(2026, 9, 8, 15, 0, 0).getTime();

function drink(ts: number, ml: number): CupEvent {
  return {
    v: 1,
    cup_id: CUP,
    device_id: 'base-A1B2C3',
    ts,
    type: 'drink',
    amount_ml: ml,
    confidence: 0.9,
    derived_by: 'base',
  };
}

/** 塞 n 条无数字的对话轮(数字留白,好让守卫测试干净) */
async function seedTurns(memory: ChatStore, n: number, ts = NOW): Promise<void> {
  for (let i = 0; i < n; i++) {
    await memory.appendTurn({ cup_id: CUP, ts, role: i % 2 === 0 ? 'user' : 'assistant', text: i % 2 === 0 ? '今天喝得怎么样' : '还行吧' });
  }
}

function deps(opts: { chat?: ChatDeps['chat']; memory?: MemoryChatStore; store?: MemoryStore } = {}) {
  const store = opts.store ?? new MemoryStore();
  const memory = opts.memory ?? new MemoryChatStore();
  return {
    store,
    memory,
    deps: {
      store,
      memory,
      chat: opts.chat ?? new MockChatLlm([say('主人喜欢小口慢饮,常在下午犯懒。')]),
      log: () => {},
      now: () => NOW,
    } satisfies DistillDeps,
  };
}

// ── 攒够没 ───────────────────────────────────────────────────────

test('蒸馏:没攒够新轮 → 返回 null,不写画像', async () => {
  const { memory, deps: d } = deps();
  await seedTurns(memory, 3); // < 默认阈值 8
  const r = await distillProfile(d, { cupId: CUP, nowMs: NOW });
  assert.equal(r, null);
  assert.equal(await memory.profile(CUP), null);
});

test('蒸馏:攒够 + 模型给合法画像 → 采用,source=llm,水位推进', async () => {
  const { memory, deps: d } = deps();
  await seedTurns(memory, 8);
  const r = await distillProfile(d, { cupId: CUP, nowMs: NOW });
  assert.equal(r?.source, 'llm');
  assert.equal(await memory.profile(CUP), '主人喜欢小口慢饮,常在下午犯懒。');
  assert.equal(await memory.lastDistilledAt(CUP), NOW);
});

test('蒸馏:再蒸要等新轮 —— 水位推进后,same 时刻再蒸 → null', async () => {
  const { memory, deps: d } = deps();
  await seedTurns(memory, 8);
  assert.ok(await distillProfile(d, { cupId: CUP, nowMs: NOW }));
  assert.equal(await distillProfile(d, { cupId: CUP, nowMs: NOW + 60_000 }), null);
});

test('蒸馏:水位之后又有新轮 → 可以再蒸', async () => {
  const { memory, deps: d } = deps({
    chat: new MockChatLlm([say('a'), say('b')]),
  });
  await seedTurns(memory, 8);
  assert.ok(await distillProfile(d, { cupId: CUP, nowMs: NOW }));
  await seedTurns(memory, 8, NOW + 60_000); // 新轮,ts 晚于水位
  const r = await distillProfile(d, { cupId: CUP, nowMs: NOW + 120_000 });
  assert.equal(r?.source, 'llm');
});

// ── 守卫 + 兜底 ──────────────────────────────────────────────────

test('蒸馏:模型给凭空数字 → 守卫拦下,落模板(source=template)', async () => {
  const { memory, deps: d } = deps({ chat: new MockChatLlm([say('主人昨天喝了 8888ml,很能喝。')]) });
  await seedTurns(memory, 8); // 历史里没有 8888
  const r = await distillProfile(d, { cupId: CUP, nowMs: NOW });
  assert.equal(r?.source, 'template');
  assert.ok(!(await memory.profile(CUP))?.includes('8888'));
});

test('蒸馏:模型不可用(NullChatLlm)→ 模板兜底,数字来自真实日聚合', async () => {
  const store = new MemoryStore();
  store.applyEventToAgg(drink(NOW, 400));
  const memory = new MemoryChatStore();
  const d: DistillDeps = { store, memory, chat: new NullChatLlm(), log: () => {}, now: () => NOW };
  await seedTurns(memory, 8);

  const r = await distillProfile(d, { cupId: CUP, nowMs: NOW });
  assert.equal(r?.source, 'template');
  assert.match((await memory.profile(CUP)) ?? '', /400ml/); // 数字来自真实聚合
  assert.match((await memory.profile(CUP)) ?? '', /1500ml/); // 目标
});

test('蒸馏:模型可复述历史里的数字(不误伤)', async () => {
  const memory = new MemoryChatStore();
  memory.appendTurn({ cup_id: CUP, ts: NOW, role: 'user', text: '我一般一次喝 250ml' });
  for (let i = 0; i < 8; i++) {
    memory.appendTurn({ cup_id: CUP, ts: NOW, role: 'assistant', text: '哦' });
  }
  const d: DistillDeps = {
    store: new MemoryStore(),
    memory,
    chat: new MockChatLlm([say('主人习惯一次喝 250ml。')]),
    log: () => {},
    now: () => NOW,
  };
  const r = await distillProfile(d, { cupId: CUP, nowMs: NOW });
  assert.equal(r?.source, 'llm'); // 250 来自历史 → 不算凭空
  assert.match((await memory.profile(CUP)) ?? '', /250/);
});

// ── 纯函数单测 ───────────────────────────────────────────────────

test('acceptProfile:空 / 多行 / 过长 一律拒', () => {
  const empty = new Set<string>();
  assert.equal(acceptProfile('  ', empty).ok, false);
  assert.equal(acceptProfile('一行\n两行', empty).ok, false);
  assert.equal(acceptProfile('x'.repeat(2001), empty).ok, false);
  assert.equal(acceptProfile('正常一句画像。', empty).ok, true);
});

test('acceptProfile:含不在 allow 里的数字 → 拒', () => {
  assert.equal(acceptProfile('喝了 777ml', new Set(['250'])).ok, false);
  assert.equal(acceptProfile('喝了 250ml', new Set(['250'])).ok, true);
});

test('distillDue:按 ts 阈值数新轮', async () => {
  const memory = new MemoryChatStore();
  await seedTurns(memory, 4, NOW);
  assert.equal(await distillDue(memory, CUP, 0, 4), true);
  assert.equal(await distillDue(memory, CUP, NOW, 1), false); // 没有 ts > NOW 的
  assert.equal(await distillDue(memory, CUP, 0, 5), false);
});

test('templateProfile:含真实数字;无数据也不空', async () => {
  const store = new MemoryStore();
  const t0 = await templateProfile(store, CUP, NOW); // 没有任何事件
  assert.ok(t0.length > 0);
  assert.match(t0, /1500ml/); // 目标仍在
  store.applyEventToAgg(drink(NOW, 300));
  assert.match(await templateProfile(store, CUP, NOW), /300ml/);
});

// ── 跨重启存活 ───────────────────────────────────────────────────

test('蒸馏:画像 + 水位跨重启存活(FileChatStore)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cup-distill-'));
  try {
    const store = new MemoryStore();
    store.applyEventToAgg(drink(NOW, 400));

    const p1 = new FilePersistence(dir);
    const m1 = new FileChatStore(p1);
    const d1: DistillDeps = { store, memory: m1, chat: new NullChatLlm(), log: () => {}, now: () => NOW };
    await seedTurns(m1, 8);
    assert.ok(await distillProfile(d1, { cupId: CUP, nowMs: NOW }));
    const before = await m1.profile(CUP);
    await p1.flush();

    const p2 = new FilePersistence(dir);
    const m2 = new FileChatStore(p2);
    assert.equal(await m2.profile(CUP), before); // 画像读回
    assert.equal(await m2.lastDistilledAt(CUP), NOW); // 水位读回
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 接线:调度器顺带蒸馏 ─────────────────────────────────────────

test('接线:ProactiveScheduler.tick 顺带推进蒸馏(无需开口也蒸)', async () => {
  const store = new MemoryStore();
  const memory = new MemoryChatStore();
  await seedTurns(memory, 8);
  const sch = new ProactiveScheduler({
    store,
    commands: new CommandQueue(),
    chat: new MockChatLlm([say('主人小口慢饮。')]),
    memory,
    live: new LiveHub(),
    log: () => {},
    cups: () => [CUP],
    now: () => NOW,
    minNewTurns: 1,
  });
  const fired = await sch.tick(NOW); // 没事件 → 不开口
  assert.equal(fired.length, 0);
  assert.equal(await memory.profile(CUP), '主人小口慢饮。'); // 但蒸馏发生了
});

// ── 闭环:蒸馏 → 读端守卫 ────────────────────────────────────────

test('闭环:蒸馏出的画像交给读端,复述画像数字能过守卫', async () => {
  const memory = new MemoryChatStore();
  await memory.appendTurn({ cup_id: CUP, ts: NOW, role: 'user', text: '我一般一次喝 250ml' });
  for (let i = 0; i < 8; i++) await memory.appendTurn({ cup_id: CUP, ts: NOW, role: 'assistant', text: '哦' });

  const store = new MemoryStore();
  const d: ChatDeps = {
    store,
    memory,
    commands: new CommandQueue(),
    chat: new MockChatLlm([say('主人习惯一次喝 250ml。')]),
    log: () => {},
    now: () => NOW,
  };
  await distillProfile(d, { cupId: CUP, nowMs: NOW });

  // 新的问答:模型复述画像里的 250 —— 应先被并入 allow,不被判凭空
  const d2: ChatDeps = {
    ...d,
    chat: new MockChatLlm([callTool('get_today', {}), say('又是 250ml 呀,真稳。')]),
  };
  const a = await runChat(d2, { cupId: CUP, question: '我记得我怎么喝水吗' });
  assert.equal(a.source, 'llm');
});
