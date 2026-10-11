/**
 * CloudSocial —— 前端这半的账号 / 市场 / 社交客户端(#72/#73/#74)。
 *
 * 不连真后端:注入假 fetch + 假存储,把关键约定钉死 ——
 *   · 注册/登录成功后**带 Bearer 令牌**发后续请求;
 *   · 令牌过期(401)→ 清本地令牌,不留死令牌;
 *   · 失败一律 resolve(不 reject)、归成可区分原因,列表端点退化成空数组;
 *   · 管理动作打到对的路径(approve/reject)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudSocial } from '../src/data/social.ts';

/** 内存版 sessionStorage(测试用;真浏览器里用真的) */
function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    size: () => m.size,
    raw: m,
  };
}

interface Cap {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
}

/** 记录每次请求;按 (method, urlSuffix) 匹配给回包 */
function router(
  routes: { match: (url: string, method: string) => boolean; status?: number; json?: unknown }[],
  cap: Cap[] = [],
): typeof fetch {
  return ((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    cap.push({
      url,
      method: init?.method,
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body as string | undefined,
    });
    const r = routes.find((x) => x.match(url, method));
    if (!r) return Promise.resolve(new Response('{}', { status: 404 }));
    const status = r.status ?? 200;
    if (status === 204) return Promise.resolve(new Response(null, { status }));
    return Promise.resolve(new Response(JSON.stringify(r.json ?? {}), { status }));
  }) as unknown as typeof fetch;
}

const BASE = 'http://localhost:8788';

test('register:成功后存令牌,后续请求带 Authorization: Bearer', async () => {
  const cap: Cap[] = [];
  const store = memStorage();
  const impl = router(
    [
      { match: (u) => u.endsWith('/auth/register'), json: { token: 'tok-1', user: { user_id: 'u1', email: 'a@b.c', nickname: '绿', role: 'user' } } },
      { match: (u) => u.includes('/market/packs'), json: { packs: [] } },
    ],
    cap,
  );
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: store });

  assert.equal(s.hasSession(), false, '登录前无会话');
  const out = await s.register('a@b.c', 'pw123456', '绿');
  assert.equal(out.ok, true);
  assert.equal(out.ok ? out.user.user_id : '', 'u1');
  assert.equal(s.hasSession(), true);
  assert.equal(store.getItem('cup.session'), 'tok-1', '令牌落在注入的存储里');

  await s.listPacks();
  const after = cap.filter((c) => c.url.includes('/market/packs'));
  assert.equal(after[0]?.headers['authorization'], 'Bearer tok-1', '后续请求带 Bearer');
});

test('login:错口令(401)→ ok:false,带后端人话,不存令牌', async () => {
  const store = memStorage();
  const impl = router([
    { match: (u) => u.endsWith('/auth/login'), status: 401, json: { error: '邮箱或口令不对' } },
  ]);
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: store });
  const out = await s.login('a@b.c', 'wrong');
  assert.equal(out.ok, false);
  assert.equal(out.ok === false ? out.reason : '', 'error');
  assert.equal(out.ok === false ? out.error : '', '邮箱或口令不对');
  assert.equal(s.hasSession(), false, '失败不存令牌');
});

test('login:网络异常 → offline(与 401 区分)', async () => {
  const impl = (() => Promise.reject(new TypeError('failed to fetch'))) as unknown as typeof fetch;
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });
  const out = await s.login('a@b.c', 'pw');
  assert.equal(out.ok === false ? out.reason : '', 'offline');
});

test('me:无令牌 → null 且不发请求;401 → 清掉死令牌', async () => {
  const cap: Cap[] = [];
  const store = memStorage();
  const impl = router([{ match: (u) => u.endsWith('/auth/me'), status: 401 }], cap);
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: store });

  assert.equal(await s.me(), null);
  assert.equal(cap.length, 0, '无令牌不该发请求');

  store.setItem('cup.session', 'stale');
  assert.equal(await s.me(), null);
  assert.equal(s.hasSession(), false, '401 后本地令牌被清');
});

test('me:有效令牌 → 返回用户', async () => {
  const store = memStorage();
  store.setItem('cup.session', 'good');
  const impl = router([
    { match: (u) => u.endsWith('/auth/me'), json: { user_id: 'u1', email: 'a@b.c', nickname: '绿', role: 'admin' } },
  ]);
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: store });
  const me = await s.me();
  assert.equal(me?.role, 'admin');
});

test('listPacks:失败退化成空数组(不 reject);成功解出 packs', async () => {
  const off = (() => Promise.reject(new TypeError('x'))) as unknown as typeof fetch;
  const s1 = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: off, storage: memStorage() });
  assert.deepEqual(await s1.listPacks(), []);

  const impl = router([
    { match: (u) => u.includes('/market/packs'), json: { packs: [{ pack_id: 'p1' }, { pack_id: 'p2' }] } },
  ]);
  const s2 = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });
  const packs = await s2.listPacks();
  assert.deepEqual(packs.map((p) => p.pack_id), ['p1', 'p2']);
});

test('getProfile / saveProfile:命中 /cups/:id/profile,PUT 带 nickname 体', async () => {
  const cap: Cap[] = [];
  const impl = router(
    [
      { match: (u, m) => u.includes('/cups/cup-X/profile') && m === 'GET', json: { cup_id: 'cup-X', nickname: '小绿', traits: {} } },
      { match: (u, m) => u.includes('/cups/cup-X/profile') && m === 'PUT', json: { cup_id: 'cup-X', nickname: '新名', traits: {} } },
    ],
    cap,
  );
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });

  assert.equal((await s.getProfile())?.nickname, '小绿');
  const saved = await s.saveProfile('新名');
  assert.equal(saved?.nickname, '新名');
  const put = cap.find((c) => c.method === 'PUT');
  assert.equal(put?.url, `${BASE}/cups/cup-X/profile`);
  assert.equal(put?.body, JSON.stringify({ nickname: '新名' }));
});

test('submitPack:失败 → null(不让半截包进 UI)', async () => {
  const impl = router([{ match: (u) => u.includes('/market/packs'), status: 400, json: { error: '包名不能为空' } }]);
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });
  const out = await s.submitPack({ name: '', tone: '', thresholds: {}, wave: {}, lines: [] });
  assert.equal(out, null);
});

test('adminVerdict:approve/reject 打到对的路径', async () => {
  const cap: Cap[] = [];
  const impl = router(
    [
      { match: (u) => u.includes('/approve'), json: { pack: { pack_id: 'p1', status: 'approved' } } },
      { match: (u) => u.includes('/reject'), json: { pack: { pack_id: 'p1', status: 'rejected' } } },
    ],
    cap,
  );
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });

  assert.equal((await s.adminVerdict('p1', true))?.status, 'approved');
  assert.equal((await s.adminVerdict('p1', false))?.status, 'rejected');
  assert.equal(cap[0]?.url, `${BASE}/admin/packs/p1/approve`);
  assert.equal(cap[1]?.url, `${BASE}/admin/packs/p1/reject`);
});

test('adminListPacks:带 ?status=pending', async () => {
  const cap: Cap[] = [];
  const impl = router([{ match: (u) => u.includes('/admin/packs'), json: { packs: [] } }], cap);
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });
  await s.adminListPacks('pending');
  assert.equal(cap[0]?.url, `${BASE}/admin/packs?status=pending`);
});

test('unbindCup:用 DELETE;bindCup:POST 带 cup_id', async () => {
  const cap: Cap[] = [];
  const impl = router([{ match: (u) => u.includes('/social/cup'), json: { cup_id: null } }], cap);
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });

  await s.bindCup('cup-Y');
  await s.unbindCup();
  assert.equal(cap[0]?.method, 'POST');
  assert.equal(cap[0]?.body, JSON.stringify({ cup_id: 'cup-Y' }));
  assert.equal(cap[1]?.method, 'DELETE');
});

test('addFriend / getTeam / listFriends:形状对不对', async () => {
  const impl = router([
    { match: (u, m) => u.includes('/social/friends') && m === 'POST', json: { friend: { user_id: 'u2', nickname: '阿蓝', traits: null, streak: null } } },
    { match: (u) => u.includes('/social/friends'), json: { friends: [{ user_id: 'u2', nickname: '阿蓝', traits: null, streak: 3 }] } },
    { match: (u) => u.includes('/social/team'), json: { members: 2, friends: 1, streak: 3, days: ['2026-10-10', '2026-10-12'] } },
  ]);
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });

  assert.equal((await s.addFriend('b@b.c'))?.nickname, '阿蓝');
  assert.equal((await s.listFriends())[0]?.streak, 3);
  const team = await s.getTeam();
  assert.equal(team?.streak, 3);
  assert.deepEqual(team?.days, ['2026-10-10', '2026-10-12']);
});

test('logout:清掉本地令牌', async () => {
  const store = memStorage();
  store.setItem('cup.session', 'tok');
  const impl = router([{ match: (u) => u.includes('/auth/logout'), status: 204 }]);
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: store });
  await s.logout();
  assert.equal(s.hasSession(), false);
});

test('storage 传 null(隐私模式)→ 不炸;登录成败仍返回,只是不保会话', async () => {
  const impl = router([
    { match: (u) => u.endsWith('/auth/login'), json: { token: 'tok', user: { user_id: 'u1', email: 'a@b.c', nickname: 'n', role: 'user' } } },
  ]);
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: null });
  const out = await s.login('a@b.c', 'pw');
  assert.equal(out.ok, true);
  assert.equal(s.hasSession(), false, '无存储 → 令牌不保,但不抛');
});
