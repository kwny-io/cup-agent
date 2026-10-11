/**
 * 写端点鉴权测试(R10-B)—— **默认强制**。
 *
 * 语义(与 R10 的初版相反):写端点(`PUT goal` / `POST config` / `POST ask`)
 * **默认就要鉴权**。
 *   · env/opts 给了 key → 用该 key。
 *   · 没给 → createApp 生成随机 key(默认拒绝,不再是"未设即放行")。
 *   · `allowUnauth: true` → **显式**豁免(仅 dev/测试)。
 * 缺头 / 不匹配 / 无 key 又未豁免 → 401(小 JSON,非 HTML)。
 * 读端点(today/series/events/state/report)与 /healthz **永远开放**。
 *
 * 用 createApp 起真 HTTP,风格照 api-errors.test.ts(try/finally 关 server)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '@cup/server';

const CUP = 'cup-A1B2C3';
const KEY = 'sekret-key-123';

/** 起真后端;默认不豁免(强制鉴权)。可传 apiKey / allowUnauth / readAuth。 */
async function startApp(
  opts: { apiKey?: string; allowUnauth?: boolean; readAuth?: boolean } = {},
) {
  const app = createApp({ log: () => {}, ...opts });
  const port = await app.listen(0);
  return { app, base: `http://127.0.0.1:${port}` };
}

function putGoal(base: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/cups/${CUP}/goal`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ goal_ml: 1500 }),
  });
}

function postConfig(base: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/cups/${CUP}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ led: 'off' }),
  });
}

function postAsk(base: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/cups/${CUP}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ q: '今天喝了多少?' }),
  });
}

// ── 默认(不传 key、不豁免):写端点强制鉴权 ─────────────────────

test('默认:写端点缺 x-api-key → 401(三个端点全挡,且不留痕)', async () => {
  const { app, base } = await startApp(); // 不传 key、不豁免 → 强制
  try {
    for (const [name, r] of [
      ['PUT /goal', await putGoal(base)],
      ['POST /config', await postConfig(base)],
      ['POST /ask', await postAsk(base)],
    ] as const) {
      assert.equal(r.status, 401, `${name} 缺头应 401,实得 ${r.status}`);
    }
    assert.equal(app.commands.allCommands().length, 0, '401 后不应入队任何指令');
  } finally {
    await app.close();
  }
});

test('默认:未设 key → 生成随机 key(默认拒绝,不是放行)', async () => {
  const { app, base } = await startApp();
  try {
    assert.equal(app.apiKeyGenerated, true, '未设 key 时应生成随机 key');
    assert.ok(app.apiKey && app.apiKey.length >= 16, '生成的 key 应非空且足够长');

    // 缺头 → 401(证明默认拒绝)
    assert.equal((await putGoal(base)).status, 401);
    // 带上生成的 key → 放行(证明生成的就是生效的)
    assert.equal((await putGoal(base, { 'x-api-key': app.apiKey! })).status, 200);
    assert.equal(app.store.goal(CUP), 1500, '对 key 的写应真落地');
  } finally {
    await app.close();
  }
});

test('默认:错 key → 401', async () => {
  const { app, base } = await startApp({ apiKey: KEY });
  try {
    assert.equal(app.apiKeyGenerated, false, '显式给 key 不应标记为生成');
    assert.equal((await putGoal(base, { 'x-api-key': 'wrong-key' })).status, 401);
    assert.equal((await postConfig(base, { 'x-api-key': 'wrong-key' })).status, 401);
    assert.equal((await postAsk(base, { 'x-api-key': 'wrong-key' })).status, 401);
  } finally {
    await app.close();
  }
});

test('默认:对 key → 正常码(200 / 202 / 200)', async () => {
  const { app, base } = await startApp({ apiKey: KEY });
  try {
    const h = { 'x-api-key': KEY };
    assert.equal((await putGoal(base, h)).status, 200);
    assert.equal(app.store.goal(CUP), 1500, '对 key 的写应真落地');

    assert.equal((await postConfig(base, h)).status, 202);
    assert.equal(app.commands.allCommands().length, 1, '对 key 的写应真入队');

    assert.equal((await postAsk(base, h)).status, 200);
  } finally {
    await app.close();
  }
});

test('默认:空串 key 等同未设 → 生成随机 key 并强制', async () => {
  const { app, base } = await startApp({ apiKey: '' });
  try {
    assert.equal(app.apiKeyGenerated, true, '空串应视作未设 → 生成');
    assert.equal((await putGoal(base)).status, 401, '空串不应等于放行');
  } finally {
    await app.close();
  }
});

// ── 显式豁免(dev/测试)──────────────────────────────────────────

test('allowUnauth:写端点带不带头都放行(显式豁免)', async () => {
  const { app, base } = await startApp({ allowUnauth: true });
  try {
    assert.equal((await putGoal(base)).status, 200);
    assert.equal((await postConfig(base)).status, 202);
    assert.equal((await postAsk(base)).status, 200);
    assert.equal((await putGoal(base, { 'x-api-key': 'whatever' })).status, 200, '豁免时头是空气');
    assert.equal(app.apiKey, null, '豁免时不应生成 key');
  } finally {
    await app.close();
  }
});

// ── 读端点:默认强制下也不受影响(选项 B 的核心)─────────────────

test('默认:读端点不加头也 200(/today 与 /healthz 开放)', async () => {
  const { app, base } = await startApp({ apiKey: KEY });
  try {
    const today = await fetch(`${base}/cups/${CUP}/today`);
    assert.equal(today.status, 200, '/today 读端点不应被鉴权挡');

    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200, '/healthz 永远开放');
  } finally {
    await app.close();
  }
});

// ── 401 的体必须是 JSON(别返回 HTML)───────────────────────────

test('401 响应体是 JSON 且 error=unauthorized', async () => {
  const { app, base } = await startApp({ apiKey: KEY });
  try {
    const r = await putGoal(base);
    assert.equal(r.status, 401);
    assert.match(
      r.headers.get('content-type') ?? '',
      /application\/json/,
      '401 的 content-type 应为 JSON',
    );
    const j = (await r.json()) as { error: string };
    assert.equal(j.error, 'unauthorized');
  } finally {
    await app.close();
  }
});

// ── 读端点可选鉴权(readAuth,默认关)────────────────────────────

test('readAuth:默认关 → 读端点不加头也不被鉴权挡(与旧行为一致)', async () => {
  const { app, base } = await startApp({ apiKey: KEY }); // 不传 readAuth
  try {
    // today/series 无数据也 200;state 无数据是 404(数据原因,非鉴权)—— 关键是不是 401。
    assert.equal((await fetch(`${base}/cups/${CUP}/today`)).status, 200);
    assert.equal((await fetch(`${base}/cups/${CUP}/series`)).status, 200);
    assert.notEqual((await fetch(`${base}/cups/${CUP}/state`)).status, 401, '/state 不该被鉴权挡');
  } finally {
    await app.close();
  }
});

test('readAuth:开 → 读端点缺头 401,带头 200', async () => {
  const { app, base } = await startApp({ apiKey: KEY, readAuth: true });
  try {
    // 缺头 → 401
    assert.equal((await fetch(`${base}/cups/${CUP}/today`)).status, 401, '/today 缺头应 401');
    assert.equal((await fetch(`${base}/cups/${CUP}/series`)).status, 401);
    // 错头 → 401
    assert.equal(
      (await fetch(`${base}/cups/${CUP}/today`, { headers: { 'x-api-key': 'nope' } })).status,
      401,
    );
    // 对头 → 200
    assert.equal(
      (await fetch(`${base}/cups/${CUP}/today`, { headers: { 'x-api-key': KEY } })).status,
      200,
    );
  } finally {
    await app.close();
  }
});

test('readAuth:开 → /healthz 仍永久开放', async () => {
  const { app, base } = await startApp({ apiKey: KEY, readAuth: true });
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200, '健康检查不该要 key');
  } finally {
    await app.close();
  }
});

test('readAuth:开 + allowUnauth → 读端点也放行(显式豁免优先)', async () => {
  const { app, base } = await startApp({ readAuth: true, allowUnauth: true });
  try {
    assert.equal((await fetch(`${base}/cups/${CUP}/today`)).status, 200);
    assert.equal((await fetch(`${base}/cups/${CUP}/series`)).status, 200);
  } finally {
    await app.close();
  }
});
