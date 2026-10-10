/**
 * postJson 超时分支的回归 —— 靠注入假 fetch,在没有真实网络的情况下
 * 把"后端挂起不回包"这种最要命的路径跑出来(浏览器里不好复现)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postJson, putJson, jsonRequest } from '../src/data/http.ts';

/** 假 fetch:永远 pending,但认 abort 信号(模拟"连得上但不回包") */
function hangingFetch(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      });
    })) as unknown as typeof fetch;
}

/** 假 fetch:直接抛网络错(模拟"后端没起") */
const offlineFetch = (() => Promise.reject(new TypeError('failed to fetch'))) as unknown as typeof fetch;

test('postJson:挂起不回包 → 到点判 timeout,不会永远等', async () => {
  const t0 = Date.now();
  const res = await postJson('http://x/ask', { q: 'hi' }, 60, hangingFetch());
  const dt = Date.now() - t0;
  assert.equal(res.kind, 'timeout');
  assert.ok(dt >= 55 && dt < 1000, `应在约 60ms 超时,实际 ${dt}ms`);
});

test('postJson:网络异常 → offline(与 timeout 区分开)', async () => {
  const res = await postJson('http://x/ask', { q: 'hi' }, 1000, offlineFetch);
  assert.equal(res.kind, 'offline');
});

test('postJson:非 2xx → error', async () => {
  const errFetch = (() =>
    Promise.resolve(new Response('nope', { status: 500 }))) as unknown as typeof fetch;
  const res = await postJson('http://x/ask', { q: 'hi' }, 1000, errFetch);
  assert.equal(res.kind, 'error');
});

test('postJson:2xx → ok 且解出 JSON', async () => {
  const okFetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ answer: { text: '嗯' } }), { status: 200 }),
    )) as unknown as typeof fetch;
  const res = await postJson<{ answer: { text: string } }>('http://x/ask', { q: 'hi' }, 1000, okFetch);
  assert.equal(res.kind, 'ok');
  assert.equal(res.kind === 'ok' ? res.data.answer.text : '', '嗯');
});

test('putJson:用 PUT 方法、带 JSON 体,2xx → ok', async () => {
  let seenMethod: string | undefined;
  let seenBody: unknown;
  const spyFetch = ((_url: string, init?: RequestInit) => {
    seenMethod = init?.method;
    seenBody = init?.body;
    return Promise.resolve(
      new Response(JSON.stringify({ cup_id: 'cup-A1B2C3', goal_ml: 2000 }), { status: 200 }),
    );
  }) as unknown as typeof fetch;

  const res = await putJson<{ goal_ml: number }>(
    'http://x/cups/cup-A1B2C3/goal',
    { goal_ml: 2000 },
    1000,
    spyFetch,
  );
  assert.equal(seenMethod, 'PUT'); // 目标端点只认 PUT(后端非 PUT → 405)
  assert.equal(seenBody, JSON.stringify({ goal_ml: 2000 }));
  assert.equal(res.kind, 'ok');
  assert.equal(res.kind === 'ok' ? res.data.goal_ml : 0, 2000);
});

test('putJson:后端 400(越界)→ error,不会误当成功', async () => {
  const badFetch = (() =>
    Promise.resolve(new Response('{"error":"goal_ml 需为 0–10000 的正数"}', { status: 400 }))) as unknown as typeof fetch;
  const res = await putJson('http://x/cups/cup-A1B2C3/goal', { goal_ml: 99999 }, 1000, badFetch);
  assert.equal(res.kind, 'error');
});

/** 假 fetch:抓下 init.headers,回一个 200,好断言发了什么写请求头 */
function captureHeaders(): { seen: () => Record<string, string> | undefined; impl: typeof fetch } {
  let captured: Record<string, string> | undefined;
  const impl = ((_url: string, init?: RequestInit) => {
    captured = init?.headers as Record<string, string> | undefined;
    return Promise.resolve(new Response('{}', { status: 200 }));
  }) as unknown as typeof fetch;
  return { seen: () => captured, impl };
}

test('jsonRequest:传了 apiKey → 带 x-api-key,且 content-type 仍在(R10-B 写端点鉴权)', async () => {
  const cap = captureHeaders();
  const res = await jsonRequest('PUT', 'http://x/goal', { goal_ml: 2000 }, 1000, cap.impl, {
    'x-api-key': 'secret-key',
  });
  assert.equal(res.kind, 'ok');
  const h = cap.seen();
  assert.equal(h?.['x-api-key'], 'secret-key');
  assert.equal(h?.['content-type'], 'application/json'); // 合并不是覆盖
});

test('jsonRequest:未传 apiKey → 不带 x-api-key(与旧行为逐字一致)', async () => {
  const cap = captureHeaders();
  const res = await jsonRequest('POST', 'http://x/ask', { q: 'hi' }, 1000, cap.impl);
  assert.equal(res.kind, 'ok');
  const h = cap.seen();
  assert.equal(h === undefined || !('x-api-key' in h), true);
  assert.equal(h?.['content-type'], 'application/json');
});

test('postJson/putJson:extraHeaders 透传到 jsonRequest(新增末尾参数)', async () => {
  const cap = captureHeaders();
  const res = await postJson('http://x/ask', { q: 'hi' }, 1000, cap.impl, { 'x-api-key': 'k' });
  assert.equal(res.kind, 'ok');
  assert.equal(cap.seen()?.['x-api-key'], 'k');
});
