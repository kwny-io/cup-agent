/**
 * 端点鉴权测试(R10-B / S4)—— **两条轴,默认都强制**。
 *
 * 写端点(`PUT goal` / `POST config` / `POST ask`)→ **设备钥**(`x-api-key`):
 *   · env/opts 给了 key → 用该 key;没给 → 生成随机 key(默认拒绝)。
 *   · 缺头 / 不匹配 / 无 key 又未豁免 → 401(小 JSON,非 HTML)。
 * 读端点(`GET today/series/events/state/report/personality/memory/profile`)→
 *   **账号会话 + 归属**(S4):未登录 401;登录了但杯不归你 403。
 *   · `allowUnauth: true` → **显式**豁免读+写(仅 dev/测试)。
 * `/healthz` 与 `OPTIONS` 预检**永远开放**。
 *
 * 用 createApp 起真 HTTP,风格照 api-errors.test.ts(try/finally 关 server)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '@cup/server';

const CUP = 'cup-A1B2C3';
const KEY = 'sekret-key-123';

/** 起真后端;默认不豁免(强制鉴权)。可传 apiKey / allowUnauth。 */
async function startApp(opts: { apiKey?: string; allowUnauth?: boolean } = {}) {
  const app = createApp({ log: () => {}, ...opts });
  const port = await app.listen(0);
  return { app, base: `http://127.0.0.1:${port}` };
}

/** 注册一个用户并返回令牌(S4 读端点要会话)。 */
async function register(base: string, email = 'u@example.com'): Promise<string> {
  const r = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'pw-123456' }),
  });
  assert.equal(r.status, 200, '注册应成功');
  return ((await r.json()) as { token: string }).token;
}

/** 把杯子绑到当前会话用户名下(S4 读端点还要归属)。 */
async function bindCup(base: string, token: string, cupId = CUP): Promise<void> {
  const r = await fetch(`${base}/social/cup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ cup_id: cupId }),
  });
  assert.equal(r.status, 200, '绑杯应成功');
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
    assert.equal(await app.store.goal(CUP), 1500, '对 key 的写应真落地');
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
    assert.equal(await app.store.goal(CUP), 1500, '对 key 的写应真落地');

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

// ── 读端点:S4 会话 + 归属(默认强制)───────────────────────────

test('S4:读端点无会话 → 401(不再"不加头也 200")', async () => {
  const { app, base } = await startApp({ apiKey: KEY });
  try {
    for (const p of ['today', 'series', 'events', 'state', 'report/latest', 'report/history', 'personality/history', 'memory']) {
      const r = await fetch(`${base}/cups/${CUP}/${p}`);
      assert.equal(r.status, 401, `/${p} 无会话应 401,实得 ${r.status}`);
    }
    // 读端点也不该被写钥"蒙混":带 x-api-key 但无会话,仍是 401
    const withKey = await fetch(`${base}/cups/${CUP}/today`, { headers: { 'x-api-key': KEY } });
    assert.equal(withKey.status, 401, '读端点只认会话,不认设备钥');
  } finally {
    await app.close();
  }
});

test('S4:登录但未绑该杯 → 403(证明不是 404、更不是放行)', async () => {
  const { app, base } = await startApp({ apiKey: KEY });
  try {
    const token = await register(base, 'nobody@example.com');
    const r = await fetch(`${base}/cups/${CUP}/today`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(r.status, 403, '非主人应 403');
    const j = (await r.json()) as { error?: string };
    assert.equal(j.error, '无权操作该杯');
  } finally {
    await app.close();
  }
});

test('S4:登录且已绑该杯 → 200,且数据是这只杯的', async () => {
  const { app, base } = await startApp({ apiKey: KEY });
  try {
    const token = await register(base, 'owner@example.com');
    await bindCup(base, token, CUP);
    const r = await fetch(`${base}/cups/${CUP}/today`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(r.status, 200, '主人应放行');
    const j = (await r.json()) as { cup_id: string };
    assert.equal(j.cup_id, CUP, '读到的应是这只杯的数据');
  } finally {
    await app.close();
  }
});

test('S4:allowUnauth → 无会话也放行(豁免优先于读闸)', async () => {
  const { app, base } = await startApp({ allowUnauth: true });
  try {
    assert.equal((await fetch(`${base}/cups/${CUP}/today`)).status, 200);
    assert.equal((await fetch(`${base}/cups/${CUP}/series`)).status, 200);
  } finally {
    await app.close();
  }
});

test('S4:/healthz 永久开放;OPTIONS 预检不受闸影响', async () => {
  const { app, base } = await startApp({ apiKey: KEY });
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200, '/healthz 永远开放');
    const pre = await fetch(`${base}/cups/${CUP}/today`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204, 'OPTIONS 预检应 204');
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /authorization/);
  } finally {
    await app.close();
  }
});

test('S4:写端点仍走设备钥 —— 读闸改动未波及写支', async () => {
  const { app, base } = await startApp({ apiKey: KEY });
  try {
    assert.equal((await putGoal(base)).status, 401, '缺 key → 401');
    assert.equal((await putGoal(base, { 'x-api-key': KEY })).status, 200, '对 key → 200');
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
