/**
 * P2/P4 测试:
 *   · FetchChatLlm 对**本地假 Messages server** 的解析(不联网)
 *   · ChatTurn[] → Anthropic messages[] 的映射(尤其 tool_result 归并)
 *   · POST /ask 端到端:起真 HTTP,断言回答、400、写入
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import {
  FetchChatLlm,
  toWireMessages,
  fromWireResponse,
  MemoryStore,
  CommandQueue,
  MockChatLlm,
  MemoryChatStore,
  callTool,
  say,
  type ChatModelTurn,
  type ChatTurn,
} from '@cup/server';
import { createApiServer } from '../src/api/http.ts';
import { Pipeline } from '../src/core/pipeline.ts';
import { LiveHub } from '../src/api/live.ts';
import { NullLlm } from '../src/core/llm.ts';

const CUP = 'cup-A1B2C3';

// ── 映射:ChatTurn[] ↔ Anthropic 形状 ────────────────────────────

test('映射:连续 tool 轮归并成一条 user 消息(Anthropic 要求)', () => {
  const turns: ChatTurn[] = [
    { role: 'user', text: '喝得怎么样' },
    { role: 'assistant', text: '', toolCalls: [{ id: 't1', name: 'get_today', input: {} }, { id: 't2', name: 'get_history', input: { days: 7 } }] },
    { role: 'tool', callId: 't1', name: 'get_today', output: { drank_ml: 720 }, ok: true },
    { role: 'tool', callId: 't2', name: 'get_history', output: { total_ml: 5000 }, ok: true },
  ];
  const wire = toWireMessages(turns);
  assert.equal(wire.length, 3); // user / assistant / 归并后的 user
  assert.equal(wire[0]!.role, 'user');
  assert.equal(wire[1]!.role, 'assistant');
  assert.equal(wire[2]!.role, 'user');
  const results = wire[2]!.content as { type: string; tool_use_id: string }[];
  assert.equal(results.length, 2); // 两条 tool_result 在同一条消息里
  assert.equal(results[0]!.tool_use_id, 't1');
  assert.equal(results[1]!.tool_use_id, 't2');
});

test('映射:失败的 tool 轮带 is_error', () => {
  const wire = toWireMessages([
    { role: 'assistant', text: '', toolCalls: [{ id: 'x1', name: 'set_goal', input: {} }] },
    { role: 'tool', callId: 'x1', name: 'set_goal', output: { error: '参数不合法' }, ok: false },
  ]);
  const results = wire[1]!.content as { is_error?: boolean }[];
  assert.equal(results[0]!.is_error, true);
});

test('映射:Anthropic 响应 → ChatModelTurn(text + toolCalls)', () => {
  const t = fromWireResponse({
    content: [
      { type: 'text', text: '让我看看……' },
      { type: 'tool_use', id: 'u1', name: 'get_today', input: { a: 1 } },
    ],
    stop_reason: 'tool_use',
  });
  assert.equal(t.text, '让我看看……');
  assert.equal(t.toolCalls.length, 1);
  assert.equal(t.toolCalls[0]!.name, 'get_today');
  assert.equal(t.stopReason, 'tool_use');
});

// ── FetchChatLlm 对本地假 server ─────────────────────────────────

/** 起一个只回固定 JSON 的假 Messages server,返回其 URL 与句柄 */
async function fakeMessages(json: unknown): Promise<{ url: string; server: Server; lastBody: () => unknown }> {
  let body: unknown = null;
  const server = createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      try {
        body = JSON.parse(buf);
      } catch {
        body = null;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}/v1/messages`, server, lastBody: () => body };
}

test('FetchChatLlm:解析假 server 的 tool_use 响应,并把 tools 带进请求体', async () => {
  const fake = await fakeMessages({
    content: [{ type: 'tool_use', id: 'tu1', name: 'get_today', input: {} }],
    stop_reason: 'tool_use',
  });
  try {
    const llm = new FetchChatLlm({ url: fake.url, apiKey: 'test-key', model: 'claude-test' });
    const turn = await llm.turn({
      system: 'sys',
      turns: [{ role: 'user', text: 'hi' }],
      tools: toolStub(),
    });
    assert.equal(turn.toolCalls[0]!.name, 'get_today');
    const sent = fake.lastBody() as { model: string; tools: unknown[]; messages: unknown[] };
    assert.equal(sent.model, 'claude-test');
    assert.equal(sent.tools.length, 1);
    assert.equal(sent.messages.length, 1);
  } finally {
    fake.server.close();
  }
});

test('FetchChatLlm:HTTP 非 2xx → 抛错(由循环回退)', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(500);
    res.end('boom');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const llm = new FetchChatLlm({ url: `http://127.0.0.1:${port}/v1/messages`, apiKey: 'k', model: 'm' });
    await assert.rejects(() => llm.turn({ system: 's', turns: [], tools: [] }));
  } finally {
    server.close();
  }
});

function toolStub() {
  return [{ name: 'get_today', description: 'x', inputSchema: { type: 'object', properties: {} } }];
}

// ── POST /ask 端到端 ─────────────────────────────────────────────

async function startApi(chatScript: ChatModelTurn[]) {
  const store = new MemoryStore();
  const commands = new CommandQueue();
  const live = new LiveHub();
  const pipeline = new Pipeline(store, {});
  const server = createApiServer({
    store,
    pipeline,
    live,
    commands,
    llm: new NullLlm(),
    chatLlm: new MockChatLlm(chatScript),
    chatMemory: new MemoryChatStore(),
    allowUnauth: true, // R10-B:本文件验 /ask 语义,显式豁免写鉴权
    log: () => {},
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { base: `http://127.0.0.1:${port}`, server, store };
}

test('POST /ask:正常一问一答,返回 ChatAnswer,数字来自真实数据', async () => {
  const { base, server, store } = await startApi([callTool('get_today', {}), say('才 720ml 呀。')]);
  store.applyEventToAgg({
    v: 1,
    cup_id: CUP,
    device_id: 'base-A1B2C3',
    ts: Date.now(),
    type: 'drink',
    amount_ml: 720,
    confidence: 0.9,
    derived_by: 'base',
  });
  try {
    const r = await fetch(`${base}/cups/${CUP}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: '我今天喝得怎么样' }),
    });
    assert.equal(r.status, 200);
    const j = (await r.json()) as { cup_id: string; answer: { text: string; source: string } };
    assert.equal(j.cup_id, CUP);
    assert.equal(j.answer.source, 'llm');
    assert.match(j.answer.text, /720/);
  } finally {
    server.close();
  }
});

test('POST /ask:空问句 → 400', async () => {
  const { base, server } = await startApi([say('hi')]);
  try {
    const r = await fetch(`${base}/cups/${CUP}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: '   ' }),
    });
    assert.equal(r.status, 400);
  } finally {
    server.close();
  }
});

test('POST /ask:超长问句(>500)→ 400,不进提示词', async () => {
  const { base, server } = await startApi([say('hi')]);
  try {
    const r = await fetch(`${base}/cups/${CUP}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'x'.repeat(501) }),
    });
    assert.equal(r.status, 400);
  } finally {
    server.close();
  }
});

test('POST /ask:GET → 405', async () => {
  const { base, server } = await startApi([say('hi')]);
  try {
    const r = await fetch(`${base}/cups/${CUP}/ask`);
    assert.equal(r.status, 405);
  } finally {
    server.close();
  }
});

test('POST /ask:模型缺席(NullChatLlm)→ 仍出确定性答复,不空白', async () => {
  const store = new MemoryStore();
  store.applyEventToAgg({
    v: 1,
    cup_id: CUP,
    device_id: 'base-A1B2C3',
    ts: Date.now(),
    type: 'drink',
    amount_ml: 300,
    confidence: 0.9,
    derived_by: 'base',
  });
  const server = createApiServer({
    store,
    pipeline: new Pipeline(store, {}),
    live: new LiveHub(),
    commands: new CommandQueue(),
    llm: new NullLlm(),
    chatMemory: new MemoryChatStore(),
    allowUnauth: true, // R10-B:显式豁免写鉴权
    log: () => {},
    // 故意不传 chatLlm → 走默认 NullChatLlm
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/cups/${CUP}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: '喝得怎样' }),
    });
    const j = (await r.json()) as { answer: { text: string; source: string } };
    assert.equal(j.answer.source, 'fallback');
    assert.ok(j.answer.text.length > 0);
    assert.match(j.answer.text, /300/);
  } finally {
    server.close();
  }
});
