/**
 * 对话 agent 测试 —— 全部由 MockChatLlm 驱动,确定性、不联网。
 *
 * 钉死的是**安全不变量**(不是"AI 回答得好不好"):
 *   · 循环有界收敛到 MAX_TURNS
 *   · 工具参数校验:越界/未知工具 → {ok:false},不抛
 *   · 写预算:每次对话至多一次写
 *   · 设备指令元数据(target/cmd_id)只能由服务端填,模型碰不到
 *   · 数字守卫:凭空数字 → 确定性回退,绝不给空泡
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runChat,
  dispatch,
  MAX_TURNS,
  MemoryStore,
  MemoryChatStore,
  MockChatLlm,
  NullChatLlm,
  callTool,
  say,
  CommandQueue,
  DEFAULT_DEVICE_TARGET,
  type ChatDeps,
  type ChatModelTurn,
  type ToolCtx,
} from '@cup/server';
import type { CupEvent } from '@cup/contract';

const CUP = 'cup-A1B2C3';
// 一个固定的"现在",让 dayKey 稳定
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

function makeDeps(script: ChatModelTurn[]) {
  const store = new MemoryStore();
  const commands = new CommandQueue();
  const memory = new MemoryChatStore();
  const log = () => {};
  const deps: ChatDeps = {
    store,
    commands,
    chat: new MockChatLlm(script),
    memory,
    log,
    now: () => NOW,
  };
  return { deps, store, commands, memory };
}

const ctx = (store: MemoryStore, commands: CommandQueue): ToolCtx => ({
  store,
  commands,
  now: () => NOW,
});

// ── 循环 ─────────────────────────────────────────────────────────

test('循环:模型调 get_today 后说一句 → source=llm,tools_used 记到', async () => {
  const { deps, store } = makeDeps([
    callTool('get_today', {}),
    say('今天才喝了 720ml,哼。'),
  ]);
  store.applyEventToAgg(drink(NOW, 720));

  const a = await runChat(deps, { cupId: CUP, question: '我今天喝得怎么样?' });
  assert.equal(a.source, 'llm');
  assert.ok(a.tools_used.includes('get_today'));
  assert.equal(a.turns, 2);
});

test('循环:模型一直只调工具不收敛 → 到 MAX_TURNS 停止并回退', async () => {
  // 脚本里塞满工具调用,loop 每轮调一个 → 用完 MAX_TURNS
  const script = Array.from({ length: MAX_TURNS + 2 }, () => callTool('get_today', {}));
  const { deps, store } = makeDeps(script);
  store.applyEventToAgg(drink(NOW, 500));

  const a = await runChat(deps, { cupId: CUP, question: '在吗' });
  assert.equal(a.source, 'fallback');
  assert.equal(a.turns, MAX_TURNS);
});

// ── 守卫 ─────────────────────────────────────────────────────────

test('守卫:模型凭空说出工具里没有的数字 → 回退', async () => {
  const { deps, store } = makeDeps([
    callTool('get_today', {}),
    say('你已经喝了 9999ml,超标啦!'), // 9999 不在工具结果里
  ]);
  store.applyEventToAgg(drink(NOW, 720));

  const a = await runChat(deps, { cupId: CUP, question: '我喝了多少' });
  assert.equal(a.source, 'fallback');
  assert.ok(!a.text.includes('9999'));
});

test('守卫:合法派生数字(工具预计算的 remaining_ml)不被误伤', async () => {
  const { deps, store } = makeDeps([callTool('get_today', {}), say('还差 780ml,加油。')]);
  store.applyEventToAgg(drink(NOW, 720)); // 目标默认 1500 → 还差 780

  const a = await runChat(deps, { cupId: CUP, question: '还差多少' });
  assert.equal(a.source, 'llm');
});

test('守卫:LLM 抛错 → 确定性回退,带真实数字', async () => {
  const store = new MemoryStore();
  store.applyEventToAgg(drink(NOW, 720));
  const deps: ChatDeps = {
    store,
    commands: new CommandQueue(),
    chat: new NullChatLlm(),
    memory: new MemoryChatStore(),
    log: () => {},
    now: () => NOW,
  };

  const a = await runChat(deps, { cupId: CUP, question: '今天怎么样' });
  assert.equal(a.source, 'fallback');
  assert.match(a.text, /720/); // 数字来自真实聚合
});

// ── 工具参数收口 ─────────────────────────────────────────────────

test('工具:未知工具名 → {ok:false},不抛', async () => {
  const store = new MemoryStore();
  const commands = new CommandQueue();
  const r = await dispatch(ctx(store, commands), CUP, 'delete_everything', {}, false);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /未知工具/);
});

test('工具:set_goal 越界(99999)→ {ok:false},store 未改,队列为空', async () => {
  const store = new MemoryStore();
  const commands = new CommandQueue();
  const r = await dispatch(ctx(store, commands), CUP, 'set_goal', { goal_ml: 99999 }, false);
  assert.equal(r.ok, false);
  assert.equal(await store.goal(CUP), 1500); // 默认值没被改
});

test('工具:push_device 忽略模型夹带的 target/cmd_id(zod 剥掉未知键)', async () => {
  const store = new MemoryStore();
  const commands = new CommandQueue();
  const r = await dispatch(
    ctx(store, commands),
    CUP,
    'push_device',
    { kind: 'remind', text: '喝水', target: 'lid-EVIL', cmd_id: 'forged' },
    false,
  );
  // 参数本身合法(text 合规)→ 通过;但夹带的 target/cmd_id 被 schema 剥掉
  assert.equal(r.ok, true);
  assert.equal(commands.peek('lid-EVIL').length, 0); // 模型指定的目标没有生效
  const q = commands.peek(DEFAULT_DEVICE_TARGET);
  assert.equal(q.length, 1);
  assert.match(q[0]!.cmd_id, /^chat-\d+$/); // 服务端生成的,不是 'forged'
});

// ── 写预算 + 服务端填元数据 ──────────────────────────────────────

test('写:合法 set_goal → 目标真的改了', async () => {
  const { deps, store } = makeDeps([callTool('set_goal', { goal_ml: 2000 }), say('行吧,目标 2000。')]);

  const a = await runChat(deps, { cupId: CUP, question: '把目标改成 2000' });
  assert.ok(a.tools_used.includes('set_goal'));
  assert.equal(await store.goal(CUP), 2000);
});

test('写:合法 push_device → 恰好一条 Command,target/cmd_id 是服务端值', async () => {
  const { deps, commands } = makeDeps([callTool('push_device', { kind: 'remind', text: '该喝水了' }), say('催你了啊。')]);

  await runChat(deps, { cupId: CUP, question: '提醒我喝水' });
  const q = commands.peek(DEFAULT_DEVICE_TARGET);
  assert.equal(q.length, 1);
  assert.equal(q[0]!.target, DEFAULT_DEVICE_TARGET);
  assert.match(q[0]!.cmd_id, /^chat-\d+$/); // 服务端生成,非模型
  assert.equal(q[0]!.type, 'remind');
});

test('push_device:省略 led → 服务端兜默认 breath_blue(契约 §5 payload 含 led)', async () => {
  const store = new MemoryStore();
  const commands = new CommandQueue();
  const r = await dispatch(ctx(store, commands), CUP, 'push_device', { kind: 'remind', text: '喝水' }, false);
  assert.equal(r.ok, true);
  const q = commands.peek(DEFAULT_DEVICE_TARGET);
  assert.equal((q[0]!.payload as { led?: string }).led, 'breath_blue');
});

test('push_device:模型给的白名单 led 原样下发(固件认得的名字)', async () => {
  const store = new MemoryStore();
  const commands = new CommandQueue();
  const r = await dispatch(
    ctx(store, commands),
    CUP,
    'push_device',
    { kind: 'remind', text: '快点喝', led: 'blink_red' },
    false,
  );
  assert.equal(r.ok, true);
  assert.equal((commands.peek(DEFAULT_DEVICE_TARGET)[0]!.payload as { led?: string }).led, 'blink_red');
});

test('push_device:白名单外的 led 名 → 拒,不入队(不许模型瞎编灯效)', async () => {
  const store = new MemoryStore();
  const commands = new CommandQueue();
  const r = await dispatch(
    ctx(store, commands),
    CUP,
    'push_device',
    { kind: 'remind', text: '喝水', led: 'disco_rainbow' },
    false,
  );
  assert.equal(r.ok, false);
  assert.equal(commands.peek(DEFAULT_DEVICE_TARGET).length, 0);
});

test('写预算:一次对话里第二次写被拒,只落一条草', async () => {
  const { deps, store, commands } = makeDeps([
    callTool('set_goal', { goal_ml: 2000 }),
    callTool('push_device', { kind: 'remind', text: '再喝' }), // 第二次写 → 应被拒
    say('改好了。'),
  ]);

  await runChat(deps, { cupId: CUP, question: '改目标并提醒我' });
  assert.equal(await store.goal(CUP), 2000);
  assert.equal(commands.peek(DEFAULT_DEVICE_TARGET).length, 0); // 第二次写没落
});

// ── 记忆 ─────────────────────────────────────────────────────────

test('记忆:一轮问答后,历史里有一条 user + 一条 assistant', async () => {
  const { deps, memory, store } = makeDeps([callTool('get_today', {}), say('喝了 300ml。')]);
  store.applyEventToAgg(drink(NOW, 300));

  await runChat(deps, { cupId: CUP, question: '多少了' });
  const turns = await memory.recentTurns(CUP, 10);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.role, 'user');
  assert.equal(turns[1]!.role, 'assistant');
});
