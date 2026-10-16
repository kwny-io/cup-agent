/**
 * #73 UGC 人格市场 + 管理后台 —— `/market/*` 与 `/admin/*` 端点。
 *
 * 钉的是**内容安全边与权限边**,不是"包好不好用":
 *   · 投稿只带数值 + 文本,**逐项钳制**(k:1e9 / 10 万字台词进不来)
 *   · 市场读口默认只看**已上架**;未上架的包订阅不了(404)
 *   · 管理端要 `role==='admin'`:未登录 401,普通用户 403
 *   · 出口**绝不含 salt/hash**
 *   · 管理员引导走 CUP_ADMIN_EMAIL → 注册,不新增注册口子
 *
 * 起真 HTTP,风格照 auth.test.ts / profile.test.ts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, normalizePack, makePack } from '@cup/server';
import { MemoryAccountsStore, seedOfficialPacks, OFFICIAL_PACKS } from '@cup/server';
import type { AdminUser, PersonaPack, PublicUser } from '@cup/server';

interface AuthOk {
  token: string;
  user: PublicUser;
}

async function startApp(opts: Parameters<typeof createApp>[0] = {}) {
  // 市场默认**关**(未设=关);本文件钉的是市场行为,故默认开。关态另起测试(不传 marketOpen)。
  const app = createApp({ log: () => {}, marketOpen: true, ...opts });
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

async function reg(base: string, body: unknown): Promise<AuthOk> {
  const r = await post(base, '/auth/register', body);
  assert.equal(r.status, 200, '注册应成功');
  return (await r.json()) as AuthOk;
}

const DRAFT = { name: '暴躁模式', tone: '说话冲一点', lines: ['快点喝水!', '别摸鱼'] };

// ── 纯函数:normalizePack ─────────────────────────────────────────

test('normalizePack:空名 / 无语气且无台词 → 报错', () => {
  assert.equal(normalizePack({ name: '', tone: 'x' }).ok, false);
  assert.equal(normalizePack({ name: 'x' }).ok, false, '既没语气也没台词');
});

test('normalizePack:数值逐项钳制,未知键与非法值静默丢弃', () => {
  const r = normalizePack({
    name: 'n',
    tone: 't',
    thresholds: { REFUSE_S: 1e9, SULK_LEVEL: -5, BOGUS: 1, CONTENT_S: 'x' },
    wave: { k: 999999, c: 0.5 },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.draft.thresholds.REFUSE_S! <= 3600, '越界上钳');
  assert.ok(r.draft.thresholds.SULK_LEVEL! >= 0, '越界下钳');
  assert.ok(!('BOGUS' in r.draft.thresholds), '未知键丢弃');
  assert.ok(!('CONTENT_S' in r.draft.thresholds), '非数丢弃');
  assert.ok(r.draft.wave.k! <= 10_000, '水波也钳');
});

test('normalizePack:台词逐条截断 + 数量封顶 + 丢空串', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `L${i}`);
  const r = normalizePack({ name: 'n', lines: ['', '  ', ...lines] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.draft.lines.length, 20, '最多 20 句');
  assert.ok(!r.draft.lines.includes(''), '空串丢弃');
});

test('makePack:作者 / 时间 / 状态由服务端填,初始 pending', () => {
  const r = normalizePack(DRAFT);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const p = makePack(r.draft, 'u_author', 12345);
  assert.equal(p.author_user_id, 'u_author');
  assert.equal(p.created_at, 12345);
  assert.equal(p.status, 'pending');
  assert.ok(p.pack_id.length > 0);
});

// ── 市场端点 ─────────────────────────────────────────────────────

test('市场:未登录投稿 → 401;登录投稿 → 200 且 pending', async () => {
  const { app, base } = await startApp();
  try {
    assert.equal((await post(base, '/market/packs', DRAFT)).status, 401, '未登录不能投稿');

    const u = await reg(base, { email: 'a@x.com', password: 'pw123456' });
    const r = await post(base, '/market/packs', DRAFT, u.token);
    assert.equal(r.status, 200);
    const { pack } = (await r.json()) as { pack: PersonaPack };
    assert.equal(pack.status, 'pending');
    assert.equal(pack.author_user_id, u.user.user_id);
  } finally {
    await app.close();
  }
});

test('市场:GET 默认只返回已上架 —— 刚投稿的 pending 看不到', async () => {
  const { app, base } = await startApp();
  try {
    const u = await reg(base, { email: 'a@x.com', password: 'pw123456' });
    await post(base, '/market/packs', DRAFT, u.token);

    const r = await get(base, '/market/packs', u.token);
    assert.equal(r.status, 200);
    const { packs } = (await r.json()) as { packs: PersonaPack[] };
    assert.equal(packs.length, 0, 'pending 不上架');
  } finally {
    await app.close();
  }
});

test('市场:非管理员 ?status=pending → 403', async () => {
  const { app, base } = await startApp();
  try {
    const u = await reg(base, { email: 'a@x.com', password: 'pw123456' });
    assert.equal((await get(base, '/market/packs?status=pending', u.token)).status, 403);
    assert.equal((await get(base, '/market/packs?status=pending')).status, 401, '未登录 401');
  } finally {
    await app.close();
  }
});

test('市场:订阅未上架的包 → 404;审核通过后 → 200', async () => {
  const { app, base } = await startApp({ adminEmail: 'boss@x.com' });
  try {
    const admin = await reg(base, { email: 'boss@x.com', password: 'pw123456' });
    const u = await reg(base, { email: 'a@x.com', password: 'pw123456' });

    const { pack } = (await (
      await post(base, '/market/packs', DRAFT, admin.token)
    ).json()) as { pack: PersonaPack };

    assert.equal(
      (await post(base, `/market/packs/${pack.pack_id}/subscribe`, {}, u.token)).status,
      404,
      '未上架不能订阅',
    );

    await post(base, `/admin/packs/${pack.pack_id}/approve`, {}, admin.token);

    assert.equal(
      (await post(base, `/market/packs/${pack.pack_id}/subscribe`, {}, u.token)).status,
      200,
    );
    const { packs } = (await (await get(base, '/market/packs', u.token)).json()) as {
      packs: PersonaPack[];
    };
    assert.equal(packs.length, 1, '上架后市场可见');
    assert.equal(packs[0]!.pack_id, pack.pack_id);
  } finally {
    await app.close();
  }
});

test('市场:投稿非法形状(空名)→ 400', async () => {
  const { app, base } = await startApp();
  try {
    const u = await reg(base, { email: 'a@x.com', password: 'pw123456' });
    assert.equal((await post(base, '/market/packs', { name: '' }, u.token)).status, 400);
  } finally {
    await app.close();
  }
});

// ── 市场灰度开关(D3;未设=关)─────────────────────────────────────

test('市场开关:未设(默认关)→ 公开货架空,投稿 503', async () => {
  // 不传 marketOpen → 关(未设=关)
  const app = createApp({ log: () => {} });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const u = await reg(base, { email: 'a@x.com', password: 'pw123456' });

    const r = await get(base, '/market/packs', u.token);
    assert.equal(r.status, 200);
    assert.deepEqual(((await r.json()) as { packs: PersonaPack[] }).packs, [], '关时货架为空');

    assert.equal((await post(base, '/market/packs', DRAFT, u.token)).status, 503, '关时不能投稿');
  } finally {
    await app.close();
  }
});

test('市场开关:关时管理员 ?status= 审读口不受影响', async () => {
  const app = createApp({ log: () => {}, adminEmail: 'boss@x.com' }); // 关(未设)
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const admin = await reg(base, { email: 'boss@x.com', password: 'pw123456' });
    // 直接往 store 造一个 pending(关闭态投不了稿,故绕开路由)
    const r = normalizePack(DRAFT);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    await app.accounts.createPack(makePack(r.draft, admin.user.user_id, Date.now()));

    const q = await get(base, '/market/packs?status=pending', admin.token);
    assert.equal(q.status, 200, '管理员审读口不受开关影响');
    assert.equal(((await q.json()) as { packs: PersonaPack[] }).packs.length, 1);

    // 非管理员带 ?status= 仍 403(权限优先于开关)
    const pleb = await reg(base, { email: 'joe@x.com', password: 'pw123456' });
    assert.equal((await get(base, '/market/packs?status=pending', pleb.token)).status, 403);
  } finally {
    await app.close();
  }
});

test('market/status:免登录回开关;开时 true,关时 false', async () => {
  const on = await startApp({ marketOpen: true });
  try {
    const r = await get(on.base, '/market/status'); // 无令牌
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { open: true });
  } finally {
    await on.app.close();
  }

  const off = createApp({ log: () => {} });
  const port = await off.listen(0);
  try {
    const r = await get(`http://127.0.0.1:${port}`, '/market/status');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { open: false });
  } finally {
    await off.close();
  }
});

// ── 管理后台:用户 ────────────────────────────────────────────────

test('admin/users:未登录 401,普通用户 403,管理员 200 且不含 salt/hash', async () => {
  const { app, base } = await startApp({ adminEmail: 'boss@x.com' });
  try {
    const admin = await reg(base, { email: 'boss@x.com', password: 'pw123456' });
    const pleb = await reg(base, { email: 'joe@x.com', password: 'pw123456' });

    assert.equal((await get(base, '/admin/users')).status, 401, '未登录');
    assert.equal((await get(base, '/admin/users', pleb.token)).status, 403, '非管理员');

    const r = await get(base, '/admin/users', admin.token);
    assert.equal(r.status, 200);
    const { users } = (await r.json()) as { users: AdminUser[] };
    assert.equal(users.length, 2);
    for (const u of users) {
      assert.ok(!('salt' in u) && !('hash' in u), '出口绝不含 salt/hash');
      assert.equal(u.disabled, false, '管理视图带 disabled');
    }
  } finally {
    await app.close();
  }
});

test('admin:禁用用户 → 该用户登录/会话失效;不能禁用自己', async () => {
  const { app, base } = await startApp({ adminEmail: 'boss@x.com' });
  try {
    const admin = await reg(base, { email: 'boss@x.com', password: 'pw123456' });
    const u = await reg(base, { email: 'a@x.com', password: 'pw123456' });

    // 不能禁用自己
    assert.equal(
      (await post(base, `/admin/users/${admin.user.user_id}/disable`, {}, admin.token)).status,
      400,
    );

    const r = await post(base, `/admin/users/${u.user.user_id}/disable`, {}, admin.token);
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { user: AdminUser }).user.disabled, true);

    // 禁用后该用户旧会话失效 + 不能再登录
    assert.equal((await get(base, '/auth/me', u.token)).status, 401, '旧会话失效');
    assert.equal((await post(base, '/auth/login', { email: 'a@x.com', password: 'pw123456' })).status, 401);

    // 未知用户 → 404
    assert.equal((await post(base, '/admin/users/nope/disable', {}, admin.token)).status, 404);
  } finally {
    await app.close();
  }
});

// ── 管理后台:审核队列 ────────────────────────────────────────────

test('admin/packs:pending 队列 → approve → 上架;reject → 驳回', async () => {
  const { app, base } = await startApp({ adminEmail: 'boss@x.com' });
  try {
    const admin = await reg(base, { email: 'boss@x.com', password: 'pw123456' });
    const p1 = ((await (await post(base, '/market/packs', DRAFT, admin.token)).json()) as {
      pack: PersonaPack;
    }).pack;
    const p2 = ((await (
      await post(base, '/market/packs', { name: '另一个', tone: 't' }, admin.token)
    ).json()) as { pack: PersonaPack }).pack;

    const q = await get(base, '/admin/packs?status=pending', admin.token);
    assert.equal(q.status, 200);
    assert.equal(((await q.json()) as { packs: PersonaPack[] }).packs.length, 2, '两件待审');

    assert.equal((await post(base, `/admin/packs/${p1.pack_id}/approve`, {}, admin.token)).status, 200);
    assert.equal((await post(base, `/admin/packs/${p2.pack_id}/reject`, {}, admin.token)).status, 200);

    const approved = (await (await get(base, '/admin/packs?status=approved', admin.token)).json()) as {
      packs: PersonaPack[];
    };
    assert.deepEqual(approved.packs.map((p) => p.pack_id), [p1.pack_id]);

    const rejected = (await (await get(base, '/admin/packs?status=rejected', admin.token)).json()) as {
      packs: PersonaPack[];
    };
    assert.deepEqual(rejected.packs.map((p) => p.pack_id), [p2.pack_id]);

    // 未知包 → 404
    assert.equal((await post(base, '/admin/packs/nope/approve', {}, admin.token)).status, 404);
  } finally {
    await app.close();
  }
});

test('admin:*:非管理员一律 403(审核也一样)', async () => {
  const { app, base } = await startApp({ adminEmail: 'boss@x.com' });
  try {
    await reg(base, { email: 'boss@x.com', password: 'pw123456' });
    const pleb = await reg(base, { email: 'joe@x.com', password: 'pw123456' });
    assert.equal((await get(base, '/admin/packs', pleb.token)).status, 403);
    assert.equal((await post(base, '/admin/packs/x/approve', {}, pleb.token)).status, 403);
  } finally {
    await app.close();
  }
});

// ── 官方种子包(P4-D3 冷启动)─────────────────────────────────────

test('seedOfficialPacks:种入 5 个官方包,全 approved;重跑幂等不再种', async () => {
  const store = new MemoryAccountsStore();
  const first = await seedOfficialPacks(store, 1000);
  assert.equal(first, OFFICIAL_PACKS.length, '首次全种');
  assert.equal(first, 5);

  const packs = await store.listPacks('approved');
  assert.equal(packs.length, 5, '5 个都上架');
  for (const p of packs) {
    assert.equal(p.author_user_id, 'official', '作者是官方哨兵');
    assert.equal(p.status, 'approved', '不走审核队列');
    assert.equal(p.created_at, 1000);
  }
  assert.deepEqual(
    packs.map((p) => p.pack_id).sort(),
    OFFICIAL_PACKS.map((s) => s.id).sort(),
    'pack_id 稳定可断言',
  );

  const again = await seedOfficialPacks(store, 2000);
  assert.equal(again, 0, '幂等:第二次不种');
  assert.equal((await store.listPacks('approved')).length, 5, '数量不变');
});

test('市场:种子包在真启动的 app 里可见且可订阅', async () => {
  const { app, base } = await startApp();
  try {
    // cli 才种子,测试里手动种(createApp 同步、且数包断言要求市场默认为空)
    const added = await seedOfficialPacks(app.accounts, Date.now());
    assert.equal(added, 5);

    const u = await reg(base, { email: 'a@x.com', password: 'pw123456' });
    const { packs } = (await (await get(base, '/market/packs', u.token)).json()) as {
      packs: PersonaPack[];
    };
    assert.equal(packs.length, 5, '官方包在架');

    const r = await post(base, '/market/packs/official-hothead/subscribe', {}, u.token);
    assert.equal(r.status, 200, '官方包可订阅');
  } finally {
    await app.close();
  }
});

// ── 订阅读回(P4-D1 装包生效的前置)────────────────────────────────

test('market/subscriptions:未登录 401;登录回已订的包', async () => {
  const { app, base } = await startApp();
  try {
    await seedOfficialPacks(app.accounts, Date.now());
    assert.equal((await get(base, '/market/subscriptions')).status, 401, '未登录');

    const u = await reg(base, { email: 'a@x.com', password: 'pw123456' });
    let r = await get(base, '/market/subscriptions', u.token);
    assert.equal(r.status, 200);
    assert.deepEqual(((await r.json()) as { pack_ids: string[] }).pack_ids, [], '没订过 → 空');

    await post(base, '/market/packs/official-genki/subscribe', {}, u.token);
    await post(base, '/market/packs/official-aloof/subscribe', {}, u.token);
    r = await get(base, '/market/subscriptions', u.token);
    const ids = ((await r.json()) as { pack_ids: string[] }).pack_ids;
    assert.deepEqual(ids.sort(), ['official-aloof', 'official-genki'], '回读两件');
  } finally {
    await app.close();
  }
});

test('market/subscriptions:订过的包被下架后,读回不再列表(不返回死 id)', async () => {
  const { app, base } = await startApp({ adminEmail: 'boss@x.com' });
  try {
    const admin = await reg(base, { email: 'boss@x.com', password: 'pw123456' });
    const u = await reg(base, { email: 'a@x.com', password: 'pw123456' });

    const { pack } = (await (
      await post(base, '/market/packs', DRAFT, admin.token)
    ).json()) as { pack: PersonaPack };
    await post(base, `/admin/packs/${pack.pack_id}/approve`, {}, admin.token);
    await post(base, `/market/packs/${pack.pack_id}/subscribe`, {}, u.token);

    let r = await get(base, '/market/subscriptions', u.token);
    assert.deepEqual(((await r.json()) as { pack_ids: string[] }).pack_ids, [pack.pack_id]);

    // 驳回下架后,订阅记录还在,但读口不再返回它
    await post(base, `/admin/packs/${pack.pack_id}/reject`, {}, admin.token);
    r = await get(base, '/market/subscriptions', u.token);
    assert.deepEqual(((await r.json()) as { pack_ids: string[] }).pack_ids, [], '下架包不返回');
  } finally {
    await app.close();
  }
});
