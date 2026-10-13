/**
 * CloudSource 读路径的鉴权头(S4)—— 钉「读端点带会话令牌」这一条。
 *
 * 读端点(today/series/report/personality/…)现在后端要**登录会话 + 归属**;
 * 前端所有读都收口在 `getJson`,故只需钉它在有/无令牌时各带什么头:
 *   · 已登录(sessionStorage 有 cup.session)→ 带 `Authorization: Bearer <token>`;
 *   · 未登录 → **不带**该头(闸关时后端忽略;闸开时自然 401 → UI 走"请登录")。
 *
 * 白盒:直接驱动私有的 getJson(读的唯一收口),注入全局 fetch 捕获请求头,
 * 不真连后端、不起 WS。令牌真源 = sessionStorage(经 CloudSocial 读)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudSource } from '../src/data/cloud.ts';

/** 内存版 sessionStorage(替掉 jsdom 缺的全局) */
function memStorage(init: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

interface Cap {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** 换掉全局 fetch,捕获请求;回一份最小可用 JSON。返回还原函数。 */
function captureFetch(cap: Cap[]): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    cap.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    return Promise.resolve(
      new Response(JSON.stringify({ cup_id: 'cup-X' }), { status: 200 }),
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

/** 白盒驱动私有 getJson(读的唯一收口)。 */
function readJson(src: CloudSource, path: string): Promise<unknown> {
  return (src as unknown as { getJson<T>(p: string): Promise<T | null> }).getJson(path);
}

test('S4:已登录 → 读端点带 Authorization: Bearer <token>', async () => {
  const cap: Cap[] = [];
  const restore = captureFetch(cap);
  const hadSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  (globalThis as { sessionStorage?: unknown }).sessionStorage = memStorage({
    'cup.session': 'tok-abc-123',
  });
  try {
    const src = new CloudSource({ apiBase: 'http://localhost:8788', cupId: 'cup-X' });
    await readJson(src, '/cups/cup-X/today');
    assert.equal(cap.length, 1, '应发出一次读请求');
    assert.equal(cap[0]!.headers['authorization'], 'Bearer tok-abc-123', '读端点应带会话令牌');
  } finally {
    restore();
    if (hadSession) Object.defineProperty(globalThis, 'sessionStorage', hadSession);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }
});

test('S4:未登录 → 读端点不带 Authorization 头', async () => {
  const cap: Cap[] = [];
  const restore = captureFetch(cap);
  const hadSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  (globalThis as { sessionStorage?: unknown }).sessionStorage = memStorage(); // 无令牌
  try {
    const src = new CloudSource({ apiBase: 'http://localhost:8788', cupId: 'cup-X' });
    await readJson(src, '/cups/cup-X/today');
    assert.equal(cap.length, 1);
    assert.equal(cap[0]!.headers['authorization'], undefined, '无令牌不该带该头');
  } finally {
    restore();
    if (hadSession) Object.defineProperty(globalThis, 'sessionStorage', hadSession);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }
});
