/**
 * P1 测试:账号 / 会话(多用户地基)。
 *
 * 覆盖计划 §七 P1 的四条硬要求:
 *   1. 口令哈希**不可逆**(salt/hash 绝不出口)
 *   2. 错口令 / 未知邮箱 → 401(且不区分"邮箱存在与否")
 *   3. 会话令牌过期 → 401
 *   4. 重名邮箱 → 409
 * 另测:管理员引导、禁用用户失效、logout 幂等、持久化(重启会话仍在)。
 *
 * 起真 HTTP,风格照 api-auth.test.ts(createApp → listen(0) → fetch → finally close)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createApp,
  FileAccountsStore,
  MemoryAccountsStore,
  hashPassword,
  verifyPassword,
  register,
  resolveSession,
  SESSION_TTL_MS,
} from '@cup/server';
import type { PublicUser } from '@cup/server';

interface AuthOk {
  token: string;
  user: PublicUser;
}

async function startApp(opts: Parameters<typeof createApp>[0] = {}) {
  const app = createApp({ log: () => {}, ...opts });
  const port = await app.listen(0);
  return { app, base: `http://127.0.0.1:${port}` };
}

function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function reg(base: string, body: unknown) {
  return post(base, '/auth/register', body);
}

function login(base: string, body: unknown) {
  return post(base, '/auth/login', body);
}

// ── 口令哈希(纯函数,不经 HTTP)──────────────────────────────────

test('口令哈希:同口令两次哈希不同(salt 随机),且都能验过', () => {
  const a = hashPassword('hunter2!');
  const b = hashPassword('hunter2!');
  assert.notEqual(a.salt, b.salt, '盐应随机 —— 否则彩虹表一次打穿');
  assert.notEqual(a.hash, b.hash, '盐不同 → 派生不同');
  assert.equal(verifyPassword('hunter2!', a), true);
  assert.equal(verifyPassword('hunter2!', b), true);
  assert.equal(verifyPassword('wrong', a), false);
});

test('口令哈希:hash 长度固定且不含明文', () => {
  const h = hashPassword('my-secret-pw');
  assert.equal(h.hash.length, 128, '64 字节 hex = 128 字符');
  assert.ok(!h.hash.includes('my-secret-pw'), '派生里不该出现明文');
});

// ── 注册 ─────────────────────────────────────────────────────────

test('注册:成功 → 200 + token + user(不含 salt/hash)', async () => {
  const { app, base } = await startApp();
  try {
    const r = await reg(base, { email: 'A@B.com', password: 'pw123456', nickname: '小明' });
    assert.equal(r.status, 200);
    const j = (await r.json()) as AuthOk;
    assert.ok(j.token.length > 10, '应有会话令牌');
    assert.equal(j.user.email, 'a@b.com', '邮箱应归一化为小写');
    assert.equal(j.user.nickname, '小明');
    assert.equal(j.user.role, 'user');
    // 出口视图绝不带盐/哈希
    assert.ok(!('salt' in j.user) && !('hash' in j.user), '出口不应含 salt/hash');
  } finally {
    await app.close();
  }
});

test('注册:重名邮箱(大小写不同)→ 409', async () => {
  const { app, base } = await startApp();
  try {
    assert.equal((await reg(base, { email: 'dup@x.com', password: 'pw123456' })).status, 200);
    assert.equal((await reg(base, { email: 'DUP@X.com', password: 'pw999999' })).status, 409);
  } finally {
    await app.close();
  }
});

test('注册:邮箱形状不对 / 口令过短 → 400', async () => {
  const { app, base } = await startApp();
  try {
    assert.equal((await reg(base, { email: 'not-an-email', password: 'pw123456' })).status, 400);
    assert.equal((await reg(base, { email: 'ok@x.com', password: '123' })).status, 400);
  } finally {
    await app.close();
  }
});

// ── 登录 ─────────────────────────────────────────────────────────

test('登录:对口令 → 200 新令牌;错口令 / 未知邮箱 → 401(不区分)', async () => {
  const { app, base } = await startApp();
  try {
    await reg(base, { email: 'u@x.com', password: 'pw123456' });

    const ok = await login(base, { email: 'u@x.com', password: 'pw123456' });
    assert.equal(ok.status, 200);
    const j = (await ok.json()) as AuthOk;
    assert.ok(j.token.length > 10);

    assert.equal((await login(base, { email: 'u@x.com', password: 'nope' })).status, 401, '错口令 401');
    assert.equal((await login(base, { email: 'ghost@x.com', password: 'pw123456' })).status, 401, '未知邮箱 401');
  } finally {
    await app.close();
  }
});

// ── /auth/me + 会话 ───────────────────────────────────────────────

test('/auth/me:带令牌 → 200 当前用户;无令牌 → 401', async () => {
  const { app, base } = await startApp();
  try {
    const j = (await (await reg(base, { email: 'me@x.com', password: 'pw123456' })).json()) as AuthOk;

    const me = await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${j.token}` } });
    assert.equal(me.status, 200);
    assert.equal(((await me.json()) as PublicUser).email, 'me@x.com');

    assert.equal((await fetch(`${base}/auth/me`)).status, 401, '无令牌应 401');
    assert.equal(
      (await fetch(`${base}/auth/me`, { headers: { authorization: 'Bearer garbage' } })).status,
      401,
      '坏令牌应 401',
    );
  } finally {
    await app.close();
  }
});

test('logout:令牌作废(幂等)', async () => {
  const { app, base } = await startApp();
  try {
    const j = (await (await reg(base, { email: 'lo@x.com', password: 'pw123456' })).json()) as AuthOk;
    const h = { authorization: `Bearer ${j.token}` };

    assert.equal((await post(base, '/auth/logout', {}, h)).status, 204);
    assert.equal((await fetch(`${base}/auth/me`, { headers: h })).status, 401, '登出后令牌应失效');
    // 再登出一次也 204(幂等,不抛)
    assert.equal((await post(base, '/auth/logout', {}, h)).status, 204);
  } finally {
    await app.close();
  }
});

test('会话过期:resolveSession 认出过期并清掉', () => {
  // 走纯函数层(可注入时钟),不起 HTTP —— 过期判定不依赖网络。
  const store = new MemoryAccountsStore();
  let clock = 1_000_000;
  const deps = { store, now: () => clock };

  const r = register(deps, { email: 'exp@x.com', password: 'pw123456' });
  assert.equal(r.ok, true, '注册应成功');
  const token = r.ok ? r.token : '';
  assert.ok(resolveSession(deps, token), '未过期时应能解析出用户');

  // 推过 7 天 TTL → 过期
  clock += SESSION_TTL_MS + 1;
  assert.equal(resolveSession(deps, token), null, '过期后应解析失败');
  assert.equal(store.session(token), null, '过期会话应被顺手清掉');
});

// ── 管理员引导 ────────────────────────────────────────────────────

test('首个管理员:注册邮箱 == CUP_ADMIN_EMAIL → role=admin', async () => {
  const { app, base } = await startApp({ adminEmail: 'boss@x.com' });
  try {
    const admin = (await (await reg(base, { email: 'boss@x.com', password: 'pw123456' })).json()) as AuthOk;
    assert.equal(admin.user.role, 'admin');

    const pleb = (await (await reg(base, { email: 'joe@x.com', password: 'pw123456' })).json()) as AuthOk;
    assert.equal(pleb.user.role, 'user', '非引导邮箱是普通用户');
  } finally {
    await app.close();
  }
});

// ── 禁用 ─────────────────────────────────────────────────────────

test('禁用用户:已有会话与再登录都失效', async () => {
  const { app, base } = await startApp();
  try {
    const j = (await (await reg(base, { email: 'ban@x.com', password: 'pw123456' })).json()) as AuthOk;
    const h = { authorization: `Bearer ${j.token}` };
    assert.equal((await fetch(`${base}/auth/me`, { headers: h })).status, 200, '禁用前可用');

    app.accounts.setDisabled(j.user.user_id, true);

    assert.equal((await fetch(`${base}/auth/me`, { headers: h })).status, 401, '禁用后旧会话失效');
    assert.equal((await login(base, { email: 'ban@x.com', password: 'pw123456' })).status, 401, '禁用后不能再登录');
  } finally {
    await app.close();
  }
});

// ── 持久化 ───────────────────────────────────────────────────────

test('持久化:注册 → flush → 新实例仍能登录(重启不丢)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cup-auth-'));
  try {
    // 第一次"进程"
    const app1 = createApp({ log: () => {}, accounts: new FileAccountsStore(dir) });
    const port1 = await app1.listen(0);
    const base1 = `http://127.0.0.1:${port1}`;
    assert.equal((await reg(base1, { email: 'keep@x.com', password: 'pw123456' })).status, 200);
    await app1.close(); // close 里 flush

    // 第二次"进程":同一目录新 store
    const app2 = createApp({ log: () => {}, accounts: new FileAccountsStore(dir) });
    const port2 = await app2.listen(0);
    const base2 = `http://127.0.0.1:${port2}`;
    assert.equal(
      (await login(base2, { email: 'keep@x.com', password: 'pw123456' })).status,
      200,
      '重启后口令仍可验',
    );
    await app2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('持久化:被禁用的状态也落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cup-auth-'));
  try {
    const s1 = new FileAccountsStore(dir);
    const { salt, hash } = hashPassword('pw123456');
    s1.createAccount({
      user_id: 'u_x',
      email: 'd@x.com',
      nickname: 'd',
      salt,
      hash,
      role: 'user',
      created_at: 1,
    });
    s1.setDisabled('u_x', true);
    await s1.flush();

    const s2 = new FileAccountsStore(dir);
    assert.equal(s2.accountById('u_x')?.disabled, true, '禁用状态应随文件恢复');
    assert.equal(s2.accountByEmail('D@X.COM')?.user_id, 'u_x', '邮箱归一化后仍能命中');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
