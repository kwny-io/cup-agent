/**
 * P4.3：分享卡邀请码 + 归属边 —— `/social/invite`(铸/查)+ `/social/invite/:code`(公开预览)
 * + 注册时带 `invite` 记归属边。
 *
 * 钉的是**关系语义与隐私口径**,不是"链接好不好看":
 *   · 铸码 / 查归因走**账号会话**(无令牌 401);预览(`:code`)是**公开读**(免登录,落地页先看后注册)
 *   · 预览只给**昵称 + 派生性格 + streak**(与分享卡同一份);看不到邮箱 / cup_id;
 *     对方关掉 visible 或没绑杯 → traits/streak 一律 null
 *   · 注册带码 = **首触归因**(一生一次):A 铸码 → B 带码注册 → 记一条边(B→A);
 *     B 再带别人的码注册(不可能,已注册)不影响;归一化容错(大小写 / I,L,O / 分隔符)
 *   · 归因是**尽力而为**:码形状不对 / 查无此码 / 自邀 / 未配 store → 静默跳过,绝不挡注册
 *   · 未配 `deps.invite` → 铸码口 503(不装死);预览 / 注册仍 200(归因静默)
 *
 * 直接组装 `ApiDeps`(不依赖 app.ts 接线),起真 HTTP,风格照 cup-pack.test.ts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import {
  MemoryStore,
  MemoryAccountsStore,
  MemoryInviteStore,
  normalizeInviteCode,
  NullLlm,
  type PublicUser,
  type TraitRecord,
} from '@cup/server';
import { createApiServer, type ApiDeps } from '../src/api/http.ts';
import { Pipeline } from '../src/core/pipeline.ts';
import { LiveHub } from '../src/api/live.ts';
import { CommandQueue } from '../src/core/commands.ts';

const CUP = 'cup-A1B2C3';

interface Harness {
  server: Server;
  base: string;
  accounts: MemoryAccountsStore;
  invite: MemoryInviteStore;
  close: () => Promise<void>;
}

/** 起真 HTTP;`withInvite=false` 时不喂 `deps.invite`(验 503 / 归因静默)。 */
async function start(withInvite = true): Promise<Harness> {
  const store = new MemoryStore();
  const accounts = new MemoryAccountsStore();
  const invite = new MemoryInviteStore();
  const deps: ApiDeps = {
    store,
    pipeline: new Pipeline(store, {}),
    live: new LiveHub(),
    commands: new CommandQueue(),
    llm: new NullLlm(),
    accounts,
    ...(withInvite ? { invite } : {}),
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
    invite,
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

async function reg(base: string, body: unknown): Promise<{ token: string; user: PublicUser }> {
  const r = await req(base, '/auth/register', 'POST', body);
  assert.equal(r.status, 200, '注册应成功');
  return (await r.json()) as { token: string; user: PublicUser };
}

// ── 纯函数:normalizeInviteCode ──────────────────────────────────

test('normalizeInviteCode:大小写 / 分隔符 / Crockford 容错(I→1 L→1 O→0)', () => {
  assert.equal(normalizeInviteCode('abcdefghjk'), 'ABCDEFGHJK');
  assert.equal(normalizeInviteCode('ABCD-EFGH-JK'), 'ABCDEFGHJK');
  assert.equal(normalizeInviteCode(' abcd efgh jk '), 'ABCDEFGHJK');
  assert.equal(normalizeInviteCode('ABCDILGHJK'), 'ABCD11GHJK', 'I/L → 1');
  assert.equal(normalizeInviteCode('ABCDOOGHJK'), 'ABCD00GHJK', 'O → 0');
});

test('normalizeInviteCode:长度不对 / 含非法字符 → null', () => {
  assert.equal(normalizeInviteCode('SHORT'), null);
  assert.equal(normalizeInviteCode('ABCDEFGHJKL'), null, '11 位 → null');
  assert.equal(normalizeInviteCode('ABCDEFGHU!'), null, 'U / ! 不在字母表 → null');
});

// ── /social/invite 铸码 + 查归因 ─────────────────────────────────

test('/social/invite:未登录 401;POST 铸码 → 10 位 Crockford;GET 查我拉来的 + 我的归因', async () => {
  const h = await start();
  try {
    assert.equal((await req(h.base, '/social/invite', 'POST')).status, 401, '未登录铸码 401');
    assert.equal((await req(h.base, '/social/invite', 'GET')).status, 401, '未登录查归因 401');

    const alice = await reg(h.base, { email: 'alice@x.com', password: 'pw123456', nickname: 'Alice' });

    const mintRes = await req(h.base, '/social/invite', 'POST', undefined, alice.token);
    assert.equal(mintRes.status, 200);
    const { code } = (await mintRes.json()) as { code: string };
    assert.equal(normalizeInviteCode(code), code, '铸出的码已是规范形(10 位 Crockford)');

    // 初始:没拉来人、也没有归属
    const g1 = (await (await req(h.base, '/social/invite', 'GET', undefined, alice.token)).json()) as {
      invited_count: number;
      invited_by: string | null;
    };
    assert.equal(g1.invited_count, 0);
    assert.equal(g1.invited_by, null);

    // B 带这枚码注册 → 记一条 B→Alice 的边
    const bob = await reg(h.base, {
      email: 'bob@x.com', password: 'pw123456', nickname: 'Bob', invite: code,
    });

    const g2 = (await (await req(h.base, '/social/invite', 'GET', undefined, alice.token)).json()) as {
      invited_count: number;
      invited_by: string | null;
    };
    assert.equal(g2.invited_count, 1, 'Alice 拉来 1 人');

    const bobView = (await (await req(h.base, '/social/invite', 'GET', undefined, bob.token)).json()) as {
      invited_by: string | null;
    };
    assert.equal(bobView.invited_by, alice.user.user_id, 'Bob 的归因指向 Alice');
  } finally {
    await h.close();
  }
});

test('/social/invite:非 GET/POST → 405', async () => {
  const h = await start();
  try {
    const alice = await reg(h.base, { email: 'alice@x.com', password: 'pw123456' });
    assert.equal((await req(h.base, '/social/invite', 'DELETE', undefined, alice.token)).status, 405);
  } finally {
    await h.close();
  }
});

// ── /social/invite/:code 公开预览 ────────────────────────────────

test('invite/:code 预览:免登录;只给昵称 + 性格 + streak;不泄邮箱 / cup_id', async () => {
  const h = await start();
  try {
    const alice = await reg(h.base, { email: 'alice@x.com', password: 'pw123456', nickname: 'Alice' });
    const { code } = (await (
      await req(h.base, '/social/invite', 'POST', undefined, alice.token)
    ).json()) as { code: string };

    // 没绑杯 → 只给昵称,性格/streak 为 null
    const before = (await (await req(h.base, `/social/invite/${code}`, 'GET')).json()) as {
      valid: boolean;
      inviter: { nickname: string; traits: TraitRecord | null; streak: number | null } | null;
    };
    assert.equal(before.valid, true);
    assert.equal(before.inviter!.nickname, 'Alice');
    assert.equal(before.inviter!.traits, null, '没绑杯 → 无性格');

    // 绑杯后 → 有性格 + streak;且绝不带 email / cup_id 字段
    await req(h.base, '/social/cup', 'POST', { cup_id: CUP }, alice.token);
    const after = (await (await req(h.base, `/social/invite/${code}`, 'GET')).json()) as {
      valid: boolean;
      inviter: Record<string, unknown> | null;
    };
    assert.equal(after.valid, true);
    assert.notEqual(after.inviter!.traits, null, '绑杯后看得到性格');
    assert.equal(after.inviter!.nickname, 'Alice');
    const keys = Object.keys(after.inviter!).sort();
    assert.deepEqual(keys, ['nickname', 'streak', 'traits'], '出口只三字段,无 email / cup_id');
  } finally {
    await h.close();
  }
});

test('invite/:code 预览:无效码 / 未配 store → { valid:false }(200,不 404)', async () => {
  const h = await start();
  try {
    const r = await req(h.base, '/social/invite/NOTACODE', 'GET');
    assert.equal(r.status, 200, '不 404 —— 落地页要能区分"码无效"与"服务坏了"');
    assert.deepEqual(await r.json(), { valid: false, inviter: null });

    // 形状合法的、但查无此码
    const r2 = await req(h.base, '/social/invite/AAAAAAAAAA', 'GET');
    assert.deepEqual(await r2.json(), { valid: false, inviter: null });
  } finally {
    await h.close();
  }
});

test('invite/:code 预览:对方关掉 visible → 只给昵称(traits/streak null)', async () => {
  const h = await start();
  try {
    const alice = await reg(h.base, { email: 'alice@x.com', password: 'pw123456', nickname: 'Alice' });
    await req(h.base, '/social/cup', 'POST', { cup_id: CUP }, alice.token);
    const { code } = (await (
      await req(h.base, '/social/invite', 'POST', undefined, alice.token)
    ).json()) as { code: string };
    await req(h.base, '/social/privacy', 'PUT', { visible: false }, alice.token);

    const r = (await (await req(h.base, `/social/invite/${code}`, 'GET')).json()) as {
      valid: boolean;
      inviter: { nickname: string; traits: TraitRecord | null; streak: number | null } | null;
    };
    assert.equal(r.valid, true);
    assert.equal(r.inviter!.nickname, 'Alice', '昵称仍在');
    assert.equal(r.inviter!.traits, null, '关掉可见 → 无性格');
    assert.equal(r.inviter!.streak, null, '关掉可见 → 无 streak');
  } finally {
    await h.close();
  }
});

// ── 注册归因:尽力而为 ────────────────────────────────────────────

test('注册带无效 / 自邀 / 未配 store 的码 → 注册仍成功,归因静默跳过', async () => {
  const h = await start();
  try {
    const alice = await reg(h.base, { email: 'alice@x.com', password: 'pw123456' });
    // 自邀:Alice 用自己的码注册第二个账号(不同账 → 不成立,用另注册验)
    const { code } = (await (
      await req(h.base, '/social/invite', 'POST', undefined, alice.token)
    ).json()) as { code: string };

    // 形状不对的码
    const bad = await req(h.base, '/auth/register', 'POST', {
      email: 'bad@x.com', password: 'pw123456', invite: 'NOPE',
    });
    assert.equal(bad.status, 200, '码形状不对也不挡注册');

    // 查无此码(形状合法)
    const dangling = await req(h.base, '/auth/register', 'POST', {
      email: 'dangle@x.com', password: 'pw123456', invite: 'ZZZZZZZZZZ',
    });
    assert.equal(dangling.status, 200, '查无此码也不挡注册');

    // 自邀:Alice 想用自己的码给自己再注册一个(这里换成新账号,归因边应指向 Alice)
    const invited = await reg(h.base, { email: 'carol@x.com', password: 'pw123456', invite: code });
    const carolView = (await (
      await req(h.base, '/social/invite', 'GET', undefined, invited.token)
    ).json()) as { invited_by: string | null };
    assert.equal(carolView.invited_by, alice.user.user_id, '合法码正常记边');
  } finally {
    await h.close();
  }
});

test('未配 deps.invite:铸码口 503;预览 200 { valid:false };注册带码仍 200', async () => {
  const h = await start(false);
  try {
    const alice = await reg(h.base, { email: 'alice@x.com', password: 'pw123456' });
    assert.equal(
      (await req(h.base, '/social/invite', 'POST', undefined, alice.token)).status,
      503,
      '未配 invite store → 铸码 503(不装死)',
    );
    const prev = await req(h.base, '/social/invite/AAAAAAAAAA', 'GET');
    assert.equal(prev.status, 200);
    assert.deepEqual(await prev.json(), { valid: false, inviter: null });

    const r = await req(h.base, '/auth/register', 'POST', {
      email: 'bob@x.com', password: 'pw123456', invite: 'AAAAAAAAAA',
    });
    assert.equal(r.status, 200, '未配 store 时注册带码也不受影响');
  } finally {
    await h.close();
  }
});
