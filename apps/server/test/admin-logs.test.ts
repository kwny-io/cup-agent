/**
 * `/admin/logs` 读端点 —— 角色闸 + 筛选 + keyset 分页。零基建(内存日志 store)。
 *
 * 钉的是**权限边与分页语义**:
 *   · 读口 = admin/ops/reviewer(**200**);普通 user **403**;无会话 **401**;
 *   · 触发保留清理(`POST /admin/logs/retain`)= **admin/ops**;reviewer **403**(只读);
 *   · 级别/来源/关键词/时间范围筛选;limit 上限 500;cursor 翻页;
 *   · 无 serverLogs(无 PG)→ 200 空表(服务照常,不报错);
 *   · reviewer 无权动手,但读 partitions 应当可以(只读)。
 *
 * 起真 HTTP,风格照 market.test.ts / auth.test.ts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, MemoryServerLogStore, type LogRow, type ServerLogStore } from '@cup/server';
import type { PublicUser } from '@cup/server';

interface AuthOk {
  token: string;
  user: PublicUser;
}

const ADMIN = 'boss@x.com';
const OPS = 'ops@x.com';
const REVIEWER = 'rev@x.com';

async function startApp(opts: Parameters<typeof createApp>[0] = {}) {
  const app = createApp({ log: () => {}, allowUnauth: true, ...opts });
  const port = await app.listen(0);
  return { app, base: `http://127.0.0.1:${port}` };
}

function post(base: string, path: string, body: unknown, token?: string) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function get(base: string, path: string, token?: string) {
  return fetch(`${base}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function reg(base: string, email: string): Promise<string> {
  const r = await post(base, '/auth/register', { email, password: 'pw123456' });
  assert.equal(r.status, 200, `注册 ${email} 应成功`);
  return ((await r.json()) as AuthOk).token;
}

/** 造一个填了几行日志的内存 store。 */
function seededLogs(): ServerLogStore {
  const s = new MemoryServerLogStore();
  const rows: LogRow[] = [
    { ts: 1000, level: 'info', src: 'http', msg: 'GET /cups/a/today → 200', payload: {} },
    { ts: 2000, level: 'warn', src: 'http', msg: 'GET /cups/a/state → 404', payload: {} },
    { ts: 3000, level: 'error', src: 'mqtt', msg: 'broker disconnected', payload: {} },
    { ts: 4000, level: 'warn', src: 'http', msg: 'POST /auth/login → 401', payload: {} },
    { ts: 5000, level: 'info', src: 'mqtt', msg: 'uplink dev/lid-1/up', payload: {} },
  ];
  void s.append(rows);
  return s;
}

const ROLE_OPTS = { adminEmail: ADMIN, opsEmails: [OPS], reviewerEmails: [REVIEWER] } as const;

test('[admin/logs] admin / ops / reviewer 都能读(200)', async () => {
  const logs = seededLogs();
  const { app, base } = await startApp({ serverLogs: logs, ...ROLE_OPTS });
  try {
    for (const email of [ADMIN, OPS, REVIEWER]) {
      const token = await reg(base, email);
      const r = await get(base, '/admin/logs', token);
      assert.equal(r.status, 200, `${email} 应能读日志`);
      const body = (await r.json()) as { logs: LogRow[] };
      assert.equal(body.logs.length, 5);
      // 出口按 (ts,id) 倒序
      assert.equal(body.logs[0]?.ts, 5000);
    }
  } finally {
    await app.close();
  }
});

test('[admin/logs] 普通 user → 403;无会话 → 401', async () => {
  const { app, base } = await startApp({ serverLogs: seededLogs(), ...ROLE_OPTS });
  try {
    const userToken = await reg(base, 'plain@x.com');
    assert.equal((await get(base, '/admin/logs', userToken)).status, 403);
    assert.equal((await get(base, '/admin/logs')).status, 401);
  } finally {
    await app.close();
  }
});

test('[admin/logs] 按级别 / 来源 / 关键词 / 时间范围筛选', async () => {
  const { app, base } = await startApp({ serverLogs: seededLogs(), ...ROLE_OPTS });
  try {
    const token = await reg(base, ADMIN);

    const warn = (await (await get(base, '/admin/logs?level=warn', token)).json()) as { logs: LogRow[] };
    assert.equal(warn.logs.length, 2);
    assert.ok(warn.logs.every((r) => r.level === 'warn'));

    // 多级别(逗号分隔)
    const multi = (await (await get(base, '/admin/logs?level=warn,error', token)).json()) as { logs: LogRow[] };
    assert.equal(multi.logs.length, 3);

    const mqtt = (await (await get(base, '/admin/logs?src=mqtt', token)).json()) as { logs: LogRow[] };
    assert.equal(mqtt.logs.length, 2);
    assert.ok(mqtt.logs.every((r) => r.src === 'mqtt'));

    const kw = (await (await get(base, '/admin/logs?q=login', token)).json()) as { logs: LogRow[] };
    assert.equal(kw.logs.length, 1);
    assert.ok(kw.logs[0]!.msg.includes('login'));

    const range = (await (await get(base, '/admin/logs?from=2000&to=4000', token)).json()) as { logs: LogRow[] };
    assert.deepEqual(range.logs.map((r) => r.ts), [4000, 3000, 2000]);
  } finally {
    await app.close();
  }
});

test('[admin/logs] keyset 分页:cursor 翻页、末页 next_cursor=null', async () => {
  const { app, base } = await startApp({ serverLogs: seededLogs(), ...ROLE_OPTS });
  try {
    const token = await reg(base, ADMIN);
    const p1 = (await (await get(base, '/admin/logs?limit=2', token)).json()) as {
      logs: LogRow[];
      next_cursor: string | null;
    };
    assert.equal(p1.logs.length, 2);
    assert.deepEqual(p1.logs.map((r) => r.ts), [5000, 4000]);
    assert.ok(p1.next_cursor, '有下一页');

    const p2 = (await (await get(base, `/admin/logs?limit=2&cursor=${encodeURIComponent(p1.next_cursor!)}`, token)).json()) as {
      logs: LogRow[];
      next_cursor: string | null;
    };
    assert.deepEqual(p2.logs.map((r) => r.ts), [3000, 2000]);
    assert.ok(p2.next_cursor);

    const p3 = (await (await get(base, `/admin/logs?limit=2&cursor=${encodeURIComponent(p2.next_cursor!)}`, token)).json()) as {
      logs: LogRow[];
      next_cursor: string | null;
    };
    assert.deepEqual(p3.logs.map((r) => r.ts), [1000]);
    assert.equal(p3.next_cursor, null, '末页');
  } finally {
    await app.close();
  }
});

test('[admin/logs] limit 上限钳到 500(不炸、不越界)', async () => {
  const { app, base } = await startApp({ serverLogs: seededLogs(), ...ROLE_OPTS });
  try {
    const token = await reg(base, ADMIN);
    const r = await get(base, '/admin/logs?limit=99999', token);
    assert.equal(r.status, 200); // 钳制而非报错
  } finally {
    await app.close();
  }
});

test('[admin/logs] 无 serverLogs(无 PG)→ 200 空表', async () => {
  const { app, base } = await startApp(ROLE_OPTS);
  try {
    const token = await reg(base, ADMIN);
    const body = (await (await get(base, '/admin/logs', token)).json()) as {
      logs: LogRow[];
      next_cursor: string | null;
    };
    assert.deepEqual(body, { logs: [], next_cursor: null });
  } finally {
    await app.close();
  }
});

test('[admin/logs/partitions] 无 PG → 200 空数组;reviewer 也能读', async () => {
  const { app, base } = await startApp(ROLE_OPTS);
  try {
    const token = await reg(base, REVIEWER);
    const body = (await (await get(base, '/admin/logs/partitions', token)).json()) as { partitions: unknown[] };
    assert.deepEqual(body.partitions, []);
  } finally {
    await app.close();
  }
});

test('[admin/logs/retain] admin/ops 可动手(无 PG → dropped=[]);reviewer 403;user 403;无会话 401', async () => {
  const { app, base } = await startApp(ROLE_OPTS);
  try {
    const admin = await reg(base, ADMIN);
    const ops = await reg(base, OPS);
    const reviewer = await reg(base, REVIEWER);
    const user = await reg(base, 'plain2@x.com');

    for (const token of [admin, ops]) {
      const r = await post(base, '/admin/logs/retain', {}, token);
      assert.equal(r.status, 200);
      assert.deepEqual((await r.json()) as { dropped: string[] }, { dropped: [] });
    }
    assert.equal((await post(base, '/admin/logs/retain', {}, reviewer)).status, 403, 'reviewer 只读');
    assert.equal((await post(base, '/admin/logs/retain', {}, user)).status, 403);
    assert.equal((await post(base, '/admin/logs/retain', {})).status, 401);
  } finally {
    await app.close();
  }
});

test('[admin/logs] 角色 = 注册时按邮箱名单发一次(resolveRole)', async () => {
  const { app, base } = await startApp(ROLE_OPTS);
  try {
    const tokens: Record<string, string> = {
      [ADMIN]: await reg(base, ADMIN),
      [OPS]: await reg(base, OPS),
      [REVIEWER]: await reg(base, REVIEWER),
    };
    const expect: Record<string, string> = { [ADMIN]: 'admin', [OPS]: 'ops', [REVIEWER]: 'reviewer' };
    for (const [email, token] of Object.entries(tokens)) {
      const me = (await (await get(base, '/auth/me', token)).json()) as PublicUser;
      assert.equal(me.role, expect[email], `${email} → ${expect[email]}`);
    }
  } finally {
    await app.close();
  }
});
