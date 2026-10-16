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

test('回归:fetchImpl 必须被裸调,接收者不能是 CloudSocial(浏览器 fetch 会抛 Illegal invocation)', async () => {
  // 真浏览器里 window.fetch 只认 Window/undefined 接收者;`this.fetchImpl(...)`
  // 会把 this 绑成 CloudSocial → 抛 TypeError 被 catch 吞成 offline("连不上后端")。
  // 注入的假 fetch 默认不在乎 this,故这里**显式复刻**浏览器的检查,才挡得住回退。
  let receiver: unknown = 'not-called';
  const impl = function (this: unknown) {
    receiver = this;
    return Promise.resolve(new Response(JSON.stringify({ token: 't', user: {} }), { status: 200 }));
  } as unknown as typeof fetch;
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });
  await s.register('a@b.c', 'pw123456');
  assert.ok(
    receiver !== s,
    'fetch 不得以 CloudSocial 为接收者被调用(否则浏览器抛 Illegal invocation)',
  );
});

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

test('getActivePack / setActivePack / clearActivePack:命中 /cups/:id/pack(GET/PUT/DELETE)', async () => {
  const cap: Cap[] = [];
  const PACK = { pack_id: 'p-1', name: '温柔早八', tone: 'x', thresholds: {}, wave: {}, lines: [], status: 'approved' };
  const impl = router(
    [
      { match: (u, m) => u.includes('/cups/cup-X/pack') && m === 'GET', json: { pack: PACK } },
      { match: (u, m) => u.includes('/cups/cup-X/pack') && m === 'PUT', json: { pack: PACK } },
      { match: (u, m) => u.includes('/cups/cup-X/pack') && m === 'DELETE', json: { pack: null } },
    ],
    cap,
  );
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });

  const got = await s.getActivePack();
  assert.equal(got?.pack_id, 'p-1', 'GET 解出 pack 全文');
  const put = await s.setActivePack('p-1');
  assert.equal(put?.pack_id, 'p-1');
  const putReq = cap.find((c) => c.method === 'PUT');
  assert.equal(putReq?.url, `${BASE}/cups/cup-X/pack`);
  assert.equal(putReq?.body, JSON.stringify({ pack_id: 'p-1' }), 'PUT 体是 {pack_id}');
  assert.equal(await s.clearActivePack(), true, 'DELETE → true');
  assert.equal(cap.find((c) => c.method === 'DELETE')?.url, `${BASE}/cups/cup-X/pack`);
});

test('getActivePack:未装 / 失败 → null(不 reject);setActivePack:失败 → null', async () => {
  const impl = router([
    { match: (u, m) => u.includes('/cups/cup-X/pack') && m === 'GET', json: { pack: null } },
    { match: (u, m) => u.includes('/cups/cup-X/pack') && m === 'PUT', status: 503, json: { error: '未启用' } },
  ]);
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });
  assert.equal(await s.getActivePack(), null, '未装 → null');
  assert.equal(await s.setActivePack('p-1'), null, '503 → null');
});

test('submitPack:失败 → null(不让半截包进 UI)', async () => {
  const impl = router([{ match: (u) => u.includes('/market/packs'), status: 400, json: { error: '包名不能为空' } }]);
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });
  const out = await s.submitPack({ name: '', tone: '', thresholds: {}, wave: {}, lines: [] });
  assert.equal(out, null);
});

test('getMemory:默认无参 → 命中 /cups/:id/memory 不带 query;解出 days', async () => {
  const cap: Cap[] = [];
  const impl = router(
    [
      {
        match: (u) => u.includes('/cups/cup-X/memory') && !u.includes('?'),
        json: { cup_id: 'cup-X', days: [{ cup_id: 'cup-X', date: '2026-10-13', built_at: 1, details: { drank_ml: 1200, goal_ml: 1500, reached: false, notable_events: [] } }] },
      },
    ],
    cap,
  );
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });
  const cards = await s.getMemory();
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.date, '2026-10-13');
  assert.equal(cap[0]?.url, `${BASE}/cups/cup-X/memory`, '默认不带 query');
});

test('getMemory:{all:1} → ?all=1;{recent:30} → ?recent=30', async () => {
  const cap: Cap[] = [];
  const impl = router([{ match: (u) => u.includes('/cups/cup-X/memory'), json: { days: [] } }], cap);
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });
  await s.getMemory({ all: true });
  await s.getMemory({ recent: 30 });
  assert.equal(cap[0]?.url, `${BASE}/cups/cup-X/memory?all=1`);
  assert.equal(cap[1]?.url, `${BASE}/cups/cup-X/memory?recent=30`);
});

test('getMemory:{buildToday} → ?build=1 叠在窗口参数上(封存今天)', async () => {
  const cap: Cap[] = [];
  const impl = router([{ match: (u) => u.includes('/cups/cup-X/memory'), json: { days: [] } }], cap);
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });
  await s.getMemory({ all: true, buildToday: true });
  assert.equal(cap[0]?.url, `${BASE}/cups/cup-X/memory?all=1&build=1`);
});

test('getMemory:失败 → [](不 reject);形状不对的卡被守卫丢掉', async () => {
  const off = (() => Promise.reject(new TypeError('x'))) as unknown as typeof fetch;
  const s1 = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: off, storage: memStorage() });
  assert.deepEqual(await s1.getMemory({ all: true }), []);

  const impl = router([
    {
      match: (u) => u.includes('/cups/cup-X/memory'),
      // 第二张卡缺 details → 守卫丢;第一张合法 → 留
      json: { days: [{ date: '2026-10-13', details: { drank_ml: 1, goal_ml: 1, reached: true, notable_events: [] } }, { date: 'x' }] },
    },
  ]);
  const s2 = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });
  const cards = await s2.getMemory({ all: true });
  assert.equal(cards.length, 1, '半截卡被守卫丢掉');
});

test('deleteMemory:打到 DELETE /cups/:id/memory?scope=…;失败 → false', async () => {
  const cap: Cap[] = [];
  const impl = router(
    [{ match: (u, m) => u.includes('/cups/cup-X/memory') && m === 'DELETE', status: 204 }],
    cap,
  );
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });
  assert.equal(await s.deleteMemory('all'), true);
  assert.equal(cap[0]?.url, `${BASE}/cups/cup-X/memory?scope=all`);
  assert.equal(cap[0]?.method, 'DELETE');

  const off = (() => Promise.reject(new TypeError('x'))) as unknown as typeof fetch;
  const s2 = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: off, storage: memStorage() });
  assert.equal(await s2.deleteMemory('memory'), false);
});

test('getGrowth:GET /cups/:id/growth → 解出 growth 快照;失败 → null', async () => {
  const cap: Cap[] = [];
  const impl = router(
    [
      {
        match: (u) => u.includes('/cups/cup-X/growth'),
        json: {
          cup_id: 'cup-X',
          today: '2026-10-14',
          growth: {
            days_together: 10,
            best_streak: 3,
            total_achieved_days: 4,
            total_refill_days: 2,
            stage: { key: 'growing', name: '成长期', min_days: 7 },
            next_stage: { key: 'steady', name: '稳当', min_days: 30 },
            milestones: [],
            next_milestone: null,
            celebrate: null,
          },
        },
      },
    ],
    cap,
  );
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });
  const snap = await s.getGrowth();
  assert.equal(cap[0]?.url, `${BASE}/cups/cup-X/growth`);
  assert.equal(cap[0]?.method, 'GET');
  assert.equal(snap?.growth.days_together, 10);
  assert.equal(snap?.growth.stage.key, 'growing');

  // 形状不对(缺 stage)→ 归 null,不让半截快照进界面
  const bad = router([{ match: (u) => u.includes('/cups/cup-X/growth'), json: { cup_id: 'cup-X', today: 'x', growth: { days_together: 1 } } }]);
  const s2 = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: bad, storage: memStorage() });
  assert.equal(await s2.getGrowth(), null);

  const off = (() => Promise.reject(new TypeError('x'))) as unknown as typeof fetch;
  const s3 = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: off, storage: memStorage() });
  assert.equal(await s3.getGrowth(), null);
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

  assert.deepEqual(await s.bindCup('cup-Y'), { ok: true });
  assert.deepEqual(await s.unbindCup(), { ok: true });
  assert.equal(cap[0]?.method, 'POST');
  assert.equal(cap[0]?.body, JSON.stringify({ cup_id: 'cup-Y' }));
  assert.equal(cap[1]?.method, 'DELETE');
});

test('bindCup:给了 claim_code 才带上(可信绑定开关开时用)', async () => {
  const cap: Cap[] = [];
  const impl = router([{ match: (u) => u.includes('/social/cup'), json: { cup_id: 'cup-Y' } }], cap);
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });

  await s.bindCup('cup-Y', 'ABCD-2345');
  assert.equal(cap[0]?.body, JSON.stringify({ cup_id: 'cup-Y', claim_code: 'ABCD-2345' }));
  await s.bindCup('cup-Z', ''); // 空串 = 不带字段(与开关关时的旧形状一致)
  assert.equal(cap[1]?.body, JSON.stringify({ cup_id: 'cup-Z' }));
});

test('bindCup:403 → {ok:false, error:后端人话}(开关开的错码不吞成 boolean)', async () => {
  const impl = router([
    { match: (u) => u.includes('/social/cup'), status: 403, json: { error: '杯子绑定凭证无效' } },
  ]);
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });
  assert.deepEqual(await s.bindCup('cup-Y', 'WRONG'), { ok: false, error: '杯子绑定凭证无效' });
});

test('getBoundCup:GET /social/cup → cup_id;空/缺 → null', async () => {
  const cap: Cap[] = [];
  const impl = router([{ match: (u) => u.includes('/social/cup'), json: { cup_id: 'cup-Y' } }], cap);
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });
  assert.equal(await s.getBoundCup(), 'cup-Y');
  assert.equal(cap[0]?.method, 'GET');

  const impl2 = router([{ match: (u) => u.includes('/social/cup'), json: { cup_id: null } }]);
  const s2 = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl2, storage: memStorage() });
  assert.equal(await s2.getBoundCup(), null);
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

// ── P4.3 邀请码 ─────────────────────────────────────────────────

test('register:带 invite → 体里有 invite;不带 / 空串 → 不带字段', async () => {
  const cap: Cap[] = [];
  const impl = router(
    [{ match: (u) => u.endsWith('/auth/register'), json: { token: 't', user: { user_id: 'u1', email: 'a@b.c', nickname: '', role: 'user' } } }],
    cap,
  );
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });

  await s.register('a@b.c', 'pw123456', '绿', 'ABCDEFGHJK');
  assert.equal(cap[0]?.body, JSON.stringify({ email: 'a@b.c', password: 'pw123456', nickname: '绿', invite: 'ABCDEFGHJK' }));

  await s.register('a@b.c', 'pw123456');
  assert.equal(cap[1]?.body, JSON.stringify({ email: 'a@b.c', password: 'pw123456' }), '没码不带 invite 字段');

  await s.register('a@b.c', 'pw123456', undefined, '');
  assert.equal(cap[2]?.body, JSON.stringify({ email: 'a@b.c', password: 'pw123456' }), '空串 ≠ 有码');
});

test('mintInvite:POST /social/invite → 解出 code;失败 / 空码 → null', async () => {
  const cap: Cap[] = [];
  const impl = router(
    [{ match: (u, m) => u.includes('/social/invite') && !u.includes('/invite/') && m === 'POST', json: { code: 'ABCDEFGHJK' } }],
    cap,
  );
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });
  assert.equal(await s.mintInvite(), 'ABCDEFGHJK');
  assert.equal(cap[0]?.method, 'POST');
  assert.equal(cap[0]?.url, `${BASE}/social/invite`);

  const bad = router([{ match: (u) => u.includes('/social/invite'), json: { code: '' } }]);
  const s2 = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: bad, storage: memStorage() });
  assert.equal(await s2.mintInvite(), null, '空码 → null');

  const off = (() => Promise.reject(new TypeError('x'))) as unknown as typeof fetch;
  const s3 = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: off, storage: memStorage() });
  assert.equal(await s3.mintInvite(), null);
});

test('getInvite:GET /social/invite → {invited_count, invited_by};缺字段有兜底', async () => {
  const impl = router([
    { match: (u, m) => u.includes('/social/invite') && m === 'GET', json: { minted: [], invited_count: 2, invited_by: 'u9' } },
  ]);
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });
  assert.deepEqual(await s.getInvite(), { invited_count: 2, invited_by: 'u9' });

  const sparse = router([{ match: (u) => u.includes('/social/invite'), json: {} }]);
  const s2 = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: sparse, storage: memStorage() });
  assert.deepEqual(await s2.getInvite(), { invited_count: 0, invited_by: null }, '缺字段兜底');
});

test('previewInvite:GET /social/invite/:code(公开)→ 解出 inviter;无效码 → valid:false', async () => {
  const cap: Cap[] = [];
  const impl = router(
    [
      {
        match: (u) => u.includes('/social/invite/CODE123'),
        json: { valid: true, inviter: { nickname: '阿蓝', traits: { disposition: 'smug', level: 0.8, streak: 3, warmth: 0.5, refill_habit: 0.4, updated_at: 1 }, streak: 3 } },
      },
      { match: (u) => u.includes('/social/invite/BAD'), json: { valid: false, inviter: null } },
    ],
    cap,
  );
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });

  const p = await s.previewInvite('CODE123');
  assert.equal(p?.valid, true);
  assert.equal(p?.inviter?.nickname, '阿蓝');
  assert.equal(p?.inviter?.streak, 3);
  assert.equal(cap[0]?.url, `${BASE}/social/invite/CODE123`);
  assert.equal(cap[0]?.method, 'GET');
  // 公开端点:无令牌时不该带 Authorization(未被登录会话污染)
  assert.equal(cap[0]?.headers['authorization'], undefined);

  const bad = await s.previewInvite('BAD');
  assert.deepEqual(bad, { valid: false, inviter: null });
});

// ── P4.4 删好友 / 隐私开关 ──────────────────────────────────────

test('deleteFriend:DELETE /social/friends/:id(URL 转义);失败 → false', async () => {
  const cap: Cap[] = [];
  const impl = router(
    [{ match: (u, m) => u.includes('/social/friends/') && m === 'DELETE', json: { ok: true } }],
    cap,
  );
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });
  assert.equal(await s.deleteFriend('u2'), true);
  assert.equal(cap[0]?.method, 'DELETE');
  assert.equal(cap[0]?.url, `${BASE}/social/friends/u2`);

  const off = (() => Promise.reject(new TypeError('x'))) as unknown as typeof fetch;
  const s2 = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: off, storage: memStorage() });
  assert.equal(await s2.deleteFriend('u2'), false);
});

test('getPrivacy / setPrivacy:GET 解出 visible;PUT 带 {visible} 体', async () => {
  const cap: Cap[] = [];
  const impl = router(
    [
      { match: (u, m) => u.includes('/social/privacy') && m === 'GET', json: { visible: true } },
      { match: (u, m) => u.includes('/social/privacy') && m === 'PUT', json: { visible: false } },
    ],
    cap,
  );
  const s = new CloudSocial({ apiBase: BASE, cupId: 'cup-X', fetchImpl: impl, storage: memStorage() });
  assert.equal(await s.getPrivacy(), true);
  assert.equal(await s.setPrivacy(false), false);
  const put = cap.find((c) => c.method === 'PUT');
  assert.equal(put?.url, `${BASE}/social/privacy`);
  assert.equal(put?.body, JSON.stringify({ visible: false }));
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
