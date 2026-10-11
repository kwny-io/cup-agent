/**
 * REST API 错误路径测试 —— 补上 M1/M4 验收只走"好路径"留下的空缺。
 *
 * 验收测试验的是"对的输入得到对的输出";这里反过来钉**坏输入**:
 *   · PUT /goal 越界/非数/缺字段 → 400,且**目标不变**(拒绝要真拒绝)
 *   · 非法方法 → 405(不许 GET 去改目标)
 *   · 坏 JSON 体 → 不 500、不抛,行为确定
 *   · 未知路由 → 404
 *   · /state 无数据 → 404(不编空状态)
 *   · POST /config → 202 + 入队一条指令,**target 由服务端定死**(不信客户端)
 *
 * 用 createApp 起真 HTTP(与 acceptance.test.ts 同法),不开 sim/mqtt。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, DEFAULT_GOAL_ML } from '@cup/server';

const CUP = 'cup-A1B2C3';

/** 起真后端,返回 base URL 与句柄。R10-B:写端点默认强制鉴权,本文件验错误路径故显式豁免。 */
async function startApp() {
  const app = createApp({ log: () => {}, allowUnauth: true });
  const port = await app.listen(0);
  return { app, base: `http://127.0.0.1:${port}` };
}

async function putGoal(base: string, body: string, contentType = 'application/json') {
  return fetch(`${base}/cups/${CUP}/goal`, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body,
  });
}

// ── PUT /goal:坏输入一律 400,且不改状态 ─────────────────────────

test('PUT /goal:越界/非数/缺字段 → 400,目标保持默认', async () => {
  const { app, base } = await startApp();
  try {
    const bad = ['0', '-5', '10001', '"abc"', 'null', '{}', ''];
    for (const g of bad) {
      const r = await putGoal(base, JSON.stringify({ goal_ml: g === '' ? undefined : JSON.parse(g) }));
      assert.equal(r.status, 400, `goal_ml=${g} 应 400,实得 ${r.status}`);
    }
    // 关键:被拒的请求**不能**留下痕迹
    assert.equal(await app.store.goal(CUP), DEFAULT_GOAL_ML, '拒绝后目标应仍是默认值');
  } finally {
    await app.close();
  }
});

test('PUT /goal:坏 JSON 体 → 400(不抛、不 500)', async () => {
  const { app, base } = await startApp();
  try {
    const r = await putGoal(base, '{ not valid json');
    assert.equal(r.status, 400);
    assert.equal(await app.store.goal(CUP), DEFAULT_GOAL_ML);
  } finally {
    await app.close();
  }
});

test('PUT /goal:边界值 1 与 10000 被接受', async () => {
  const { app, base } = await startApp();
  try {
    assert.equal((await putGoal(base, JSON.stringify({ goal_ml: 1 }))).status, 200);
    assert.equal(await app.store.goal(CUP), 1);
    assert.equal((await putGoal(base, JSON.stringify({ goal_ml: 10000 }))).status, 200);
    assert.equal(await app.store.goal(CUP), 10_000);
  } finally {
    await app.close();
  }
});

test('PUT /goal:用 GET 改目标 → 405', async () => {
  const { app, base } = await startApp();
  try {
    const r = await fetch(`${base}/cups/${CUP}/goal`);
    assert.equal(r.status, 405);
    assert.equal(await app.store.goal(CUP), DEFAULT_GOAL_ML);
  } finally {
    await app.close();
  }
});

// ── POST /config:方法 + 服务端定 target ───────────────────────

test('POST /config:GET → 405', async () => {
  const { app, base } = await startApp();
  try {
    const r = await fetch(`${base}/cups/${CUP}/config`);
    assert.equal(r.status, 405);
  } finally {
    await app.close();
  }
});

test('POST /config:202 + 入队一条指令,target/cmd_id 由服务端定死(不信客户端)', async () => {
  const { app, base } = await startApp();
  try {
    const r = await fetch(`${base}/cups/${CUP}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 恶意 body:试图指定 target/cmd_id —— 只能进 payload,碰不到指令字段
      body: JSON.stringify({ target: 'evil-device', cmd_id: 'evil-1', led: 'off' }),
    });
    assert.equal(r.status, 202);
    const j = (await r.json()) as { queued: { target: string; cmd_id: string; type: string } };

    assert.equal(app.commands.allCommands().length, 1, '应恰好入队一条');
    assert.equal(j.queued.type, 'config');
    // 关键:客户端给的 target/cmd_id 被无视
    assert.notEqual(j.queued.target, 'evil-device');
    assert.notEqual(j.queued.cmd_id, 'evil-1');
    // 恶意字段只落在 payload 里
    const queued = app.commands.peek(j.queued.target)[0]!;
    assert.deepEqual((queued.payload as Record<string, unknown>).led, 'off');
  } finally {
    await app.close();
  }
});

// ── 路由边界 ─────────────────────────────────────────────────────

test('未知路由 → 404(带 path 便于排查)', async () => {
  const { app, base } = await startApp();
  try {
    const r = await fetch(`${base}/cups/${CUP}/nope`);
    assert.equal(r.status, 404);
    const j = (await r.json()) as { error: string };
    assert.equal(j.error, 'not found');
    const r2 = await fetch(`${base}/totally/unknown`);
    assert.equal(r2.status, 404);
  } finally {
    await app.close();
  }
});

test('GET /state:无数据 → 404(不编空状态)', async () => {
  const { app, base } = await startApp();
  try {
    const r = await fetch(`${base}/cups/cup-EMPTY01/state`);
    assert.equal(r.status, 404);
  } finally {
    await app.close();
  }
});

test('GET /healthz 永远 200(存活探针)', async () => {
  const { app, base } = await startApp();
  try {
    const r = await fetch(`${base}/healthz`);
    assert.equal(r.status, 200);
    const j = (await r.json()) as { ok: boolean };
    assert.equal(j.ok, true);
  } finally {
    await app.close();
  }
});

// ── CORS 预检 ────────────────────────────────────────────────────

test('OPTIONS 预检 → 204 + 放行头', async () => {
  const { app, base } = await startApp();
  try {
    const r = await fetch(`${base}/cups/${CUP}/today`, { method: 'OPTIONS' });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  } finally {
    await app.close();
  }
});
