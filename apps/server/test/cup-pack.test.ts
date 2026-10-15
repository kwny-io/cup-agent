/**
 * P4.2：「当前生效的人格包」—— `/cups/:id/pack` 路由(get/set/clear 三法)。
 *
 * 钉的是**权限边与语义边**,不是"界面好不好看":
 *   · 走**账号会话**(无令牌 401)+ **归属**(别人的杯 403)—— 与 /llm 同款,**不是**设备 x-api-key
 *   · 出口恒为**包全文**(前端渲染要 thresholds/wave);没装 → `pack: null`
 *   · PUT 只落**杯级**那一行(`cup_id → pack_id`),**不写回** per-user 的 subscriptions(订了 ≠ 穿着)
 *   · 未上架 / 不存在的包 PUT → 404;缺 pack_id → 400;非 GET/PUT/DELETE → 405
 *   · 包被下架/删掉 → GET 视同没装(null),不给前端悬垂 id
 *   · 未配 `deps.activePack` → 503(不装死、不静默丢配置)
 *
 * 直接组装 `ApiDeps`(不依赖 app.ts 的接线),起真 HTTP,风格照 cup-llm.test.ts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import {
  MemoryStore,
  MemoryAccountsStore,
  MemoryActivePackStore,
  makePack,
  normalizePack,
  NullLlm,
  type PersonaPack,
  type PublicUser,
} from '@cup/server';
import { createApiServer, type ApiDeps } from '../src/api/http.ts';
import { Pipeline } from '../src/core/pipeline.ts';
import { LiveHub } from '../src/api/live.ts';
import { CommandQueue } from '../src/core/commands.ts';

const CUP = 'cup-A1B2C3';
const CUP_OTHER = 'cup-B1B2C3';

interface Harness {
  server: Server;
  base: string;
  accounts: MemoryAccountsStore;
  activePack: MemoryActivePackStore;
  close: () => Promise<void>;
}

/** 起真 HTTP;`withActivePack=false` 时不喂 `deps.activePack`(验 503)。 */
async function start(withActivePack = true): Promise<Harness> {
  const store = new MemoryStore();
  const accounts = new MemoryAccountsStore();
  const activePack = new MemoryActivePackStore();
  const deps: ApiDeps = {
    store,
    pipeline: new Pipeline(store, {}),
    live: new LiveHub(),
    commands: new CommandQueue(),
    llm: new NullLlm(),
    accounts,
    ...(withActivePack ? { activePack } : {}),
    log: () => {},
  };
  const server = createApiServer(deps);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    accounts,
    activePack,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function req(base: string, path: string, method: string, body?: unknown, token?: string) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function registerAndBind(base: string, cup = CUP): Promise<string> {
  const r = await req(base, '/auth/register', 'POST', {
    email: `u${Math.random().toString(36).slice(2)}@x.com`, password: 'pw123456',
  });
  assert.equal(r.status, 200, '注册应成功');
  const { token } = (await r.json()) as { token: string; user: PublicUser };
  const b = await req(base, '/social/cup', 'POST', { cup_id: cup }, token);
  assert.equal(b.status, 200, '绑杯应成功');
  return token;
}

/** 种一个已上架的包进 accounts store,返回它。 */
async function seedApprovedPack(h: Harness, name = '温柔早八'): Promise<PersonaPack> {
  const n = normalizePack({ name, tone: '轻轻地', thresholds: {}, wave: {}, lines: ['喝口水吧'] });
  assert.equal(n.ok, true);
  const pack = makePack(n.ok ? n.draft : { name, tone: '', thresholds: {}, wave: {}, lines: [] }, 'author-1', Date.now());
  await h.accounts.createPack(pack);
  await h.accounts.setPackStatus(pack.pack_id, 'approved');
  return { ...pack, status: 'approved' };
}

// ── 权限边 ────────────────────────────────────────────────────────

test('/pack:无令牌 → 401(走会话闸,不走 x-api-key)', async () => {
  const h = await start();
  try {
    assert.equal((await req(h.base, `/cups/${CUP}/pack`, 'GET')).status, 401);
    assert.equal((await req(h.base, `/cups/${CUP}/pack`, 'PUT', { pack_id: 'p1' })).status, 401);
    assert.equal((await req(h.base, `/cups/${CUP}/pack`, 'DELETE')).status, 401);
  } finally {
    await h.close();
  }
});

test('/pack:登录但非主人 → 403(别人的杯不能碰)', async () => {
  const h = await start();
  try {
    const token = await registerAndBind(h.base, CUP); // 绑的是 CUP
    assert.equal((await req(h.base, `/cups/${CUP_OTHER}/pack`, 'GET', undefined, token)).status, 403);
    assert.equal((await req(h.base, `/cups/${CUP_OTHER}/pack`, 'PUT', { pack_id: 'p1' }, token)).status, 403);
    assert.equal((await req(h.base, `/cups/${CUP_OTHER}/pack`, 'DELETE', undefined, token)).status, 403);
  } finally {
    await h.close();
  }
});

// ── get/set/clear 往返 ───────────────────────────────────────────

test('/pack:主人 GET 未装 → null;PUT → 回全文;GET 读回全文;DELETE → 回 null', async () => {
  const h = await start();
  try {
    const token = await registerAndBind(h.base);
    const pack = await seedApprovedPack(h);

    const g0 = await req(h.base, `/cups/${CUP}/pack`, 'GET', undefined, token);
    assert.equal(g0.status, 200);
    assert.equal(((await g0.json()) as { pack: unknown }).pack, null, '未装 → null(出厂体质)');

    const put = await req(h.base, `/cups/${CUP}/pack`, 'PUT', { pack_id: pack.pack_id }, token);
    assert.equal(put.status, 200);
    const putPack = ((await put.json()) as { pack: PersonaPack }).pack;
    assert.equal(putPack.pack_id, pack.pack_id);
    assert.equal(putPack.name, pack.name);
    assert.deepEqual(putPack.thresholds, pack.thresholds, '回**全文**,不是仅 id');

    const g1 = ((await (await req(h.base, `/cups/${CUP}/pack`, 'GET', undefined, token)).json()) as {
      pack: PersonaPack | null;
    }).pack;
    assert.equal(g1?.pack_id, pack.pack_id, 'GET 读回同一件');
    assert.equal(g1?.status, 'approved');

    const del = await req(h.base, `/cups/${CUP}/pack`, 'DELETE', undefined, token);
    assert.equal(del.status, 200);
    assert.equal(
      ((await (await req(h.base, `/cups/${CUP}/pack`, 'GET', undefined, token)).json()) as { pack: unknown }).pack,
      null, 'DELETE 后 → null',
    );
  } finally {
    await h.close();
  }
});

test('/pack:PUT 只落杯级那一行,**不写回** subscriptions(订了 ≠ 穿着)', async () => {
  const h = await start();
  try {
    const token = await registerAndBind(h.base);
    const pack = await seedApprovedPack(h);

    await req(h.base, `/cups/${CUP}/pack`, 'PUT', { pack_id: pack.pack_id }, token);

    // 订阅列表不受影响(PUT 碰的是 active-pack,不是 per-user subscriptions)
    const subs = ((await (await req(h.base, '/market/subscriptions', 'GET', undefined, token)).json()) as {
      pack_ids: string[];
    }).pack_ids;
    assert.equal(subs.includes(pack.pack_id), false, '生效包不写回订阅');
  } finally {
    await h.close();
  }
});

// ── 校验边 ────────────────────────────────────────────────────────

test('/pack:缺 pack_id → 400;不存在 / 未上架 → 404;非 GET/PUT/DELETE → 405', async () => {
  const h = await start();
  try {
    const token = await registerAndBind(h.base);
    // 造一个**未上架**(pending)的包
    const n = normalizePack({ name: '待审包', tone: 'x', thresholds: {}, wave: {}, lines: [] });
    const pending = makePack(n.ok ? n.draft : { name: '待审包', tone: 'x', thresholds: {}, wave: {}, lines: [] }, 'a', Date.now());
    await h.accounts.createPack(pending);

    assert.equal((await req(h.base, `/cups/${CUP}/pack`, 'PUT', {}, token)).status, 400, '缺 pack_id');
    assert.equal((await req(h.base, `/cups/${CUP}/pack`, 'PUT', { pack_id: '  ' }, token)).status, 400, '空白 pack_id');
    assert.equal(
      (await req(h.base, `/cups/${CUP}/pack`, 'PUT', { pack_id: 'nope' }, token)).status,
      404, '不存在的包',
    );
    assert.equal(
      (await req(h.base, `/cups/${CUP}/pack`, 'PUT', { pack_id: pending.pack_id }, token)).status,
      404, '未上架的包装不了',
    );
    assert.equal((await req(h.base, `/cups/${CUP}/pack`, 'POST', {}, token)).status, 405);
  } finally {
    await h.close();
  }
});

test('/pack:已装的包被下架 → GET 视同没装(不给前端悬垂 id)', async () => {
  const h = await start();
  try {
    const token = await registerAndBind(h.base);
    const pack = await seedApprovedPack(h);
    await req(h.base, `/cups/${CUP}/pack`, 'PUT', { pack_id: pack.pack_id }, token);

    // 下架该包(状态离开 approved)
    await h.accounts.setPackStatus(pack.pack_id, 'pending');

    assert.equal(
      ((await (await req(h.base, `/cups/${CUP}/pack`, 'GET', undefined, token)).json()) as { pack: unknown }).pack,
      null, '包下架 → GET null',
    );
  } finally {
    await h.close();
  }
});

// ── 未配 store ───────────────────────────────────────────────────

test('/pack:未配 deps.activePack → 503(不装死,也不静默丢配置)', async () => {
  const h = await start(false);
  try {
    const token = await registerAndBind(h.base);
    assert.equal((await req(h.base, `/cups/${CUP}/pack`, 'GET', undefined, token)).status, 503);
    assert.equal((await req(h.base, `/cups/${CUP}/pack`, 'PUT', { pack_id: 'p' }, token)).status, 503);
    assert.equal((await req(h.base, `/cups/${CUP}/pack`, 'DELETE', undefined, token)).status, 503);
  } finally {
    await h.close();
  }
});
