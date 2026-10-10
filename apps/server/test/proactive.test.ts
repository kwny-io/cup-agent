/**
 * P5 测试:主动开口 —— 全用注入时钟,不依赖真实时间。
 *
 * 钉死:
 *   · 下午 + 欠水 → 恰好开口一次
 *   · 冷却期内再 tick → 不说话
 *   · 非触发时段(早上/达标/没数据)→ 不说话
 *   · 模型缺席 → 仍说一句带真实数字的模板句(不空泡)
 *   · 同 FileChatStore 上新建调度器 → 冷却仍生效(重启存活)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProactiveScheduler,
  MemoryStore,
  MemoryChatStore,
  CommandQueue,
  MockChatLlm,
  NullChatLlm,
  LiveHub,
  FilePersistence,
  FileChatStore,
  callTool,
  say,
  type ChatStore,
  type LiveFrame,
} from '@cup/server';
import type { CupEvent } from '@cup/contract';

const CUP = 'cup-A1B2C3';
const GOAL = 1500;

// 本地 15:00(触发窗口内)
const T_1500 = new Date(2026, 9, 8, 15, 0, 0).getTime();
// 本地 09:00(窗口外)
const T_0900 = new Date(2026, 9, 8, 9, 0, 0).getTime();

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

/** 抓 LiveHub 广播的帧 */
function spyLive(): { live: LiveHub; frames: LiveFrame[] } {
  const live = new LiveHub();
  const frames: LiveFrame[] = [];
  live.broadcast = (f: LiveFrame) => {
    frames.push(f);
  };
  return { live, frames };
}

function makeScheduler(opts: {
  store: MemoryStore;
  memory: ChatStore;
  chat: MockChatLlm | NullChatLlm;
  live: LiveHub;
  cups?: string[];
}) {
  return new ProactiveScheduler({
    store: opts.store,
    commands: new CommandQueue(),
    chat: opts.chat,
    memory: opts.memory,
    live: opts.live,
    log: () => {},
    cups: () => opts.cups ?? [CUP],
    now: () => T_1500,
  });
}

test('主动:下午 15:00 + 欠水 → 恰好开口一次,并广播 proactive 帧', async () => {
  const store = new MemoryStore();
  store.applyEventToAgg(drink(T_1500, 400)); // 400 < 0.5*1500
  const { live, frames } = spyLive();
  const chat = new MockChatLlm([callTool('get_today', {}), say('才 400ml,该喝水啦。')]);
  const sch = makeScheduler({ store, memory: new MemoryChatStore(), chat, live });

  const fired = await sch.tick(T_1500);
  assert.equal(fired.length, 1);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.kind, 'proactive');
  assert.equal(frames[0]!.cup_id, CUP);
});

test('主动:冷却期内(30 分钟后)再 tick → 不说话', async () => {
  const store = new MemoryStore();
  store.applyEventToAgg(drink(T_1500, 400));
  const { live } = spyLive();
  const chat = new MockChatLlm([callTool('get_today', {}), say('该喝水了。')]);
  const sch = makeScheduler({ store, memory: new MemoryChatStore(), chat, live });

  await sch.tick(T_1500);
  const again = await sch.tick(T_1500 + 30 * 60_000); // 只过 30 分钟,冷却 2h 未到
  assert.equal(again.length, 0);
});

test('主动:冷却满 2 小时后 → 可以再开口', async () => {
  const store = new MemoryStore();
  store.applyEventToAgg(drink(T_1500, 400));
  const { live } = spyLive();
  const chat = new MockChatLlm([
    callTool('get_today', {}),
    say('该喝水了。'),
    callTool('get_today', {}),
    say('又该喝水了。'),
  ]);
  const sch = makeScheduler({ store, memory: new MemoryChatStore(), chat, live });

  await sch.tick(T_1500);
  const again = await sch.tick(T_1500 + 3 * 3_600_000); // 过 3 小时(但已到晚 18:00 后?15+3=18,仍在窗口)
  assert.equal(again.length, 1);
});

test('主动:达标了(喝够一半)→ 不说话', async () => {
  const store = new MemoryStore();
  store.applyEventToAgg(drink(T_1500, 1000)); // 1000 > 0.5*1500
  const { live } = spyLive();
  const sch = makeScheduler({
    store,
    memory: new MemoryChatStore(),
    chat: new MockChatLlm([say('x')]),
    live,
  });
  assert.equal((await sch.tick(T_1500)).length, 0);
});

test('主动:时段外(早上 9 点)→ 不说话', async () => {
  const store = new MemoryStore();
  store.applyEventToAgg(drink(T_0900, 100));
  const { live } = spyLive();
  const sch = makeScheduler({
    store,
    memory: new MemoryChatStore(),
    chat: new MockChatLlm([say('x')]),
    live,
  });
  assert.equal((await sch.tick(T_0900)).length, 0);
});

test('主动:今天没数据 → 不说话', async () => {
  const store = new MemoryStore();
  const { live } = spyLive();
  const sch = makeScheduler({
    store,
    memory: new MemoryChatStore(),
    chat: new MockChatLlm([say('x')]),
    live,
  });
  assert.equal((await sch.tick(T_1500)).length, 0);
});

test('主动:模型缺席(NullChatLlm)→ 仍出一句带真实数字的模板句', async () => {
  const store = new MemoryStore();
  store.applyEventToAgg(drink(T_1500, 400));
  const { live, frames } = spyLive();
  const sch = makeScheduler({ store, memory: new MemoryChatStore(), chat: new NullChatLlm(), live });

  const fired = await sch.tick(T_1500);
  assert.equal(fired.length, 1);
  assert.equal(fired[0]!.source, 'fallback');
  assert.match(fired[0]!.text, /400/); // 数字来自真实聚合
  assert.ok(!fired[0]!.text.includes('（自己开口')); // 提示词没泄漏进回答
});

test('主动:冷却跨重启存活 —— 同 FileChatStore 上新建调度器仍闭嘴', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cup-proactive-'));
  try {
    const store = new MemoryStore();
    store.applyEventToAgg(drink(T_1500, 400));

    const p1 = new FilePersistence(dir);
    const sch1 = makeScheduler({
      store,
      memory: new FileChatStore(p1),
      chat: new MockChatLlm([callTool('get_today', {}), say('该喝水了。')]),
      live: spyLive().live,
    });
    await sch1.tick(T_1500);
    await p1.flush(); // 模拟正常关停(app.close() 会 flush)

    // "重启":新持久化实例读回同一个文件,proactive 轮还在 → 冷却仍生效
    const p2 = new FilePersistence(dir);
    const sch2 = makeScheduler({
      store,
      memory: new FileChatStore(p2),
      chat: new MockChatLlm([say('不该说')]),
      live: spyLive().live,
    });
    assert.equal((await sch2.tick(T_1500 + 10 * 60_000)).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
