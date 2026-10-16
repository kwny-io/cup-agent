/**
 * #74 杯子社交 —— 好友图 + 组队 streak 纯函数 + `/social/*` 端点。
 *
 * 钉的是**共同达标口径与隐私口径**,不是"分享卡好不好看":
 *   · 组队 streak:某天要**全员**达标才算;今天没全员达标不算断链(从昨天数)
 *   · 好友互见**只看派生结论**(昵称 + 派生性格 + streak),未绑杯子 → traits/streak 为 null
 *   · 加好友:未知邮箱 404 / 加自己 400 / 重复幂等
 *   · 全要登录会话(无令牌 401)
 *
 * 起真 HTTP,数据走真实聚合路径(同 personality-history.test.ts)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, teamStreak, dayKey, shiftDay } from '@cup/server';
import type { PublicUser, TraitRecord } from '@cup/server';
import type { CupEvent } from '@cup/contract';

const CUP_A = 'cup-A1B2C3';
const CUP_B = 'cup-B1B2C3';
const GOAL = 1500;

interface AuthOk {
  token: string;
  user: PublicUser;
}

interface FriendView {
  user_id: string;
  nickname: string;
  traits: TraitRecord | null;
  streak: number | null;
}

async function startApp() {
  const app = createApp({ log: () => {}, allowUnauth: true });
  const port = await app.listen(0);
  return { app, base: `http://127.0.0.1:${port}` };
}

function seedDrink(
  app: Awaited<ReturnType<typeof startApp>>['app'],
  cup: string,
  date: string,
  ml: number,
): void {
  const ts = new Date(`${date}T12:00:00`).getTime();
  const e: CupEvent = {
    v: 1,
    cup_id: cup,
    device_id: 'base',
    ts,
    type: 'drink',
    amount_ml: ml,
    confidence: 1,
    derived_by: 'base',
  };
  app.store.applyEventToAgg(e);
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

async function reg(base: string, body: unknown): Promise<AuthOk> {
  const r = await req(base, '/auth/register', 'POST', body);
  assert.equal(r.status, 200, '注册应成功');
  return (await r.json()) as AuthOk;
}

// ── 纯函数:teamStreak ───────────────────────────────────────────

function mkAgg(cup: string, date: string, drank: number, goalMl = GOAL) {
  return {
    cup_id: cup,
    date,
    drank_ml: drank,
    refill_ml: 0,
    drink_count: drank > 0 ? 1 : 0,
    goal_ml: goalMl,
    temp_min_c: null,
    temp_max_c: null,
    temp_avg_c: null,
    last_volume_ml: null,
    streak: 0,
    event_count: 1,
    updated_at: 1,
  };
}

test('teamStreak:空队伍 → 0', () => {
  assert.deepEqual(teamStreak([], '2026-10-12'), { streak: 0, members: 0, days: [] });
});

test('teamStreak:某天要全员达标才算共同达标', () => {
  const today = '2026-10-12';
  const a = [mkAgg('a', '2026-10-11', GOAL), mkAgg('a', today, GOAL)];
  const b = [mkAgg('b', '2026-10-11', GOAL), mkAgg('b', today, 100)]; // 今天欠水
  const r = teamStreak([a, b], today);
  assert.equal(r.streak, 1, '只有 10-11 全员达标');
  assert.deepEqual(r.days, ['2026-10-11']);
  assert.equal(r.members, 2);
});

test('teamStreak:今天未全员达标 → 从昨天起算(不算断链)', () => {
  const today = '2026-10-12';
  const a = [mkAgg('a', '2026-10-10', GOAL), mkAgg('a', '2026-10-11', GOAL), mkAgg('a', today, 0)];
  const b = [mkAgg('b', '2026-10-10', GOAL), mkAgg('b', '2026-10-11', GOAL), mkAgg('b', today, 0)];
  const r = teamStreak([a, b], today);
  assert.equal(r.streak, 2, '今天还没喝不算断,数到昨天');
  assert.deepEqual(r.days, ['2026-10-10', '2026-10-11']);
});

test('teamStreak:全员今天也达标 → 把今天算进去', () => {
  const today = '2026-10-12';
  const a = [mkAgg('a', '2026-10-11', GOAL), mkAgg('a', today, GOAL)];
  const b = [mkAgg('b', '2026-10-11', GOAL), mkAgg('b', today, GOAL)];
  assert.equal(teamStreak([a, b], today).streak, 2);
});

test('teamStreak:中间断一天 → 只数最近那段', () => {
  const today = '2026-10-12';
  const a = [
    mkAgg('a', '2026-10-09', GOAL),
    mkAgg('a', '2026-10-10', 0), // 断
    mkAgg('a', '2026-10-11', GOAL),
    mkAgg('a', today, GOAL),
  ];
  const b = [
    mkAgg('b', '2026-10-09', GOAL),
    mkAgg('b', '2026-10-10', GOAL),
    mkAgg('b', '2026-10-11', GOAL),
    mkAgg('b', today, GOAL),
  ];
  assert.equal(teamStreak([a, b], today).streak, 2, '10-10 一人没喝 → 断在 10-10');
});

// ── 好友图端点 ───────────────────────────────────────────────────

test('social/friends:未登录 401;加好友 → 列表可见', async () => {
  const { app, base } = await startApp();
  try {
    assert.equal((await req(base, '/social/friends', 'GET')).status, 401);

    const alice = await reg(base, { email: 'alice@x.com', password: 'pw123456', nickname: 'Alice' });
    const bob = await reg(base, { email: 'bob@x.com', password: 'pw123456', nickname: 'Bob' });

    const r = await req(base, '/social/friends', 'POST', { email: 'BOB@x.com' }, alice.token);
    assert.equal(r.status, 200);

    const list = (await (await req(base, '/social/friends', 'GET', undefined, alice.token)).json()) as {
      friends: FriendView[];
    };
    assert.equal(list.friends.length, 1);
    assert.equal(list.friends[0]!.nickname, 'Bob');
    assert.equal(list.friends[0]!.user_id, bob.user.user_id);

    // 反向也看得到(alice 在 bob 的列表里)
    const rlist = (await (await req(base, '/social/friends', 'GET', undefined, bob.token)).json()) as {
      friends: FriendView[];
    };
    assert.equal(rlist.friends[0]!.nickname, 'Alice');
  } finally {
    await app.close();
  }
});

test('social/friends:未知邮箱 404 / 加自己 400 / 重复幂等', async () => {
  const { app, base } = await startApp();
  try {
    const alice = await reg(base, { email: 'alice@x.com', password: 'pw123456' });
    assert.equal((await req(base, '/social/friends', 'POST', { email: 'ghost@x.com' }, alice.token)).status, 404);
    assert.equal((await req(base, '/social/friends', 'POST', { email: 'alice@x.com' }, alice.token)).status, 400);

    await reg(base, { email: 'bob@x.com', password: 'pw123456' });
    assert.equal((await req(base, '/social/friends', 'POST', { email: 'bob@x.com' }, alice.token)).status, 200);
    assert.equal((await req(base, '/social/friends', 'POST', { email: 'bob@x.com' }, alice.token)).status, 200, '重复幂等');
    const list = (await (await req(base, '/social/friends', 'GET', undefined, alice.token)).json()) as {
      friends: FriendView[];
    };
    assert.equal(list.friends.length, 1, '不重复');
  } finally {
    await app.close();
  }
});

// ── 互见:绑杯子才看得到 traits/streak ───────────────────────────

test('互见:好友未绑杯子 → traits/streak 为 null', async () => {
  const { app, base } = await startApp();
  try {
    const alice = await reg(base, { email: 'alice@x.com', password: 'pw123456' });
    await reg(base, { email: 'bob@x.com', password: 'pw123456', nickname: 'Bob' });
    await req(base, '/social/friends', 'POST', { email: 'bob@x.com' }, alice.token);

    const list = (await (await req(base, '/social/friends', 'GET', undefined, alice.token)).json()) as {
      friends: FriendView[];
    };
    assert.equal(list.friends[0]!.traits, null, 'Bob 没绑杯子 → 看不到性格');
    assert.equal(list.friends[0]!.streak, null);
  } finally {
    await app.close();
  }
});

test('互见:好友绑了杯子 → 看得到派生性格(不含原始曲线)', async () => {
  const { app, base } = await startApp();
  try {
    const alice = await reg(base, { email: 'alice@x.com', password: 'pw123456' });
    const bob = await reg(base, { email: 'bob@x.com', password: 'pw123456', nickname: 'Bob' });

    // Bob 绑杯子 + 种数据
    assert.equal((await req(base, '/social/cup', 'POST', { cup_id: CUP_B }, bob.token)).status, 200);
    seedDrink(app, CUP_B, shiftDay(dayKey(Date.now()), -1), GOAL);
    seedDrink(app, CUP_B, dayKey(Date.now()), GOAL); // 连 2 天 → smug

    await req(base, '/social/friends', 'POST', { email: 'bob@x.com' }, alice.token);
    const list = (await (await req(base, '/social/friends', 'GET', undefined, alice.token)).json()) as {
      friends: FriendView[];
    };
    const bobView = list.friends.find((f) => f.user_id === bob.user.user_id)!;
    assert.notEqual(bobView.traits, null);
    assert.equal(bobView.traits!.disposition, 'smug');
    assert.equal(bobView.traits!.streak, 2);
    // 出口只有 5 个数值 + updated_at,不带原始曲线字段
    const keys = Object.keys(bobView.traits!).sort();
    assert.deepEqual(
      keys,
      ['disposition', 'level', 'refill_habit', 'streak', 'updated_at', 'warmth'],
      '只有派生快照,无原始饮水曲线',
    );
  } finally {
    await app.close();
  }
});

test('social/cup:解绑后好友看不到 traits;cup_id 非法 → 400', async () => {
  const { app, base } = await startApp();
  try {
    const alice = await reg(base, { email: 'alice@x.com', password: 'pw123456' });
    const bob = await reg(base, { email: 'bob@x.com', password: 'pw123456', nickname: 'Bob' });
    await req(base, '/social/cup', 'POST', { cup_id: CUP_B }, bob.token);
    await req(base, '/social/friends', 'POST', { email: 'bob@x.com' }, alice.token);

    assert.equal((await req(base, '/social/cup', 'POST', { cup_id: '' }, bob.token)).status, 400);
    assert.equal((await req(base, '/social/cup', 'DELETE', undefined, bob.token)).status, 200);

    const list = (await (await req(base, '/social/friends', 'GET', undefined, alice.token)).json()) as {
      friends: FriendView[];
    };
    assert.equal(list.friends[0]!.traits, null, '解绑后看不到');
  } finally {
    await app.close();
  }
});

test('P4.4 删好友:DELETE 后双向消失;不存在幂等 200;未登录 401', async () => {
  const { app, base } = await startApp();
  try {
    const alice = await reg(base, { email: 'alice@x.com', password: 'pw123456' });
    const bob = await reg(base, { email: 'bob@x.com', password: 'pw123456', nickname: 'Bob' });
    await req(base, '/social/friends', 'POST', { email: 'bob@x.com' }, alice.token);

    assert.equal(
      (await req(base, `/social/friends/${bob.user.user_id}`, 'DELETE')).status,
      401,
      '未登录 → 401',
    );

    // Bob 侧反向删 Alice → 无向边应被清掉(两个方向都看不到)
    assert.equal(
      (await req(base, `/social/friends/${alice.user.user_id}`, 'DELETE', undefined, bob.token)).status,
      200,
    );
    const aliceList = (await (await req(base, '/social/friends', 'GET', undefined, alice.token)).json()) as {
      friends: FriendView[];
    };
    const bobList = (await (await req(base, '/social/friends', 'GET', undefined, bob.token)).json()) as {
      friends: FriendView[];
    };
    assert.equal(aliceList.friends.length, 0, 'Alice 侧应看不到 Bob');
    assert.equal(bobList.friends.length, 0, 'Bob 侧应看不到 Alice');

    // 再删一次(已不存在)→ 幂等 200
    assert.equal(
      (await req(base, `/social/friends/${bob.user.user_id}`, 'DELETE', undefined, alice.token)).status,
      200,
      '删不存在的边 → 幂等 200',
    );
  } finally {
    await app.close();
  }
});

test('P4.4 隐私开关:关掉 visible → 好友侧 traits/streak 变 null;默认开', async () => {
  const { app, base } = await startApp();
  try {
    const alice = await reg(base, { email: 'alice@x.com', password: 'pw123456' });
    const bob = await reg(base, { email: 'bob@x.com', password: 'pw123456', nickname: 'Bob' });
    await req(base, '/social/cup', 'POST', { cup_id: CUP_B }, bob.token);
    seedDrink(app, CUP_B, shiftDay(dayKey(Date.now()), -1), GOAL);
    seedDrink(app, CUP_B, dayKey(Date.now()), GOAL);
    await req(base, '/social/friends', 'POST', { email: 'bob@x.com' }, alice.token);

    // 默认可见(缺省)
    const def = (await (await req(base, '/social/privacy', 'GET', undefined, bob.token)).json()) as {
      visible: boolean;
    };
    assert.equal(def.visible, true, '默认可见');
    const before = (await (await req(base, '/social/friends', 'GET', undefined, alice.token)).json()) as {
      friends: FriendView[];
    };
    assert.notEqual(before.friends[0]!.traits, null, '默认看得到性格');

    // 关掉 → 好友只看得到昵称
    assert.equal(
      (await req(base, '/social/privacy', 'PUT', { visible: false }, bob.token)).status,
      200,
    );
    const after = (await (await req(base, '/social/friends', 'GET', undefined, alice.token)).json()) as {
      friends: FriendView[];
    };
    assert.equal(after.friends[0]!.traits, null, '关掉后看不到性格');
    assert.equal(after.friends[0]!.streak, null, '关掉后看不到 streak');
    assert.equal(after.friends[0]!.nickname, 'Bob', '昵称仍在');

    // 非法值 → 400
    assert.equal((await req(base, '/social/privacy', 'PUT', { visible: 'no' }, bob.token)).status, 400);
  } finally {
    await app.close();
  }
});

test('GET /social/cup:未绑 → null;绑后 → 该杯;解绑 → 回到 null;未登录 → 401', async () => {
  const { app, base } = await startApp();
  try {
    const bob = await reg(base, { email: 'bob@x.com', password: 'pw123456' });

    assert.equal((await req(base, '/social/cup', 'GET', undefined)).status, 401, '未登录 401');

    const before = (await (await req(base, '/social/cup', 'GET', undefined, bob.token)).json()) as {
      cup_id: string | null;
    };
    assert.equal(before.cup_id, null, '没绑 → null');

    await req(base, '/social/cup', 'POST', { cup_id: CUP_B }, bob.token);
    const bound = (await (await req(base, '/social/cup', 'GET', undefined, bob.token)).json()) as {
      cup_id: string | null;
    };
    assert.equal(bound.cup_id, CUP_B, '绑后读回该杯');

    await req(base, '/social/cup', 'DELETE', undefined, bob.token);
    const after = (await (await req(base, '/social/cup', 'GET', undefined, bob.token)).json()) as {
      cup_id: string | null;
    };
    assert.equal(after.cup_id, null, '解绑 → 回 null');
  } finally {
    await app.close();
  }
});

// ── 组队 streak 端点 ─────────────────────────────────────────────

test('social/team:全员绑杯子 + 共同达标 → 组队 streak 正确', async () => {
  const { app, base } = await startApp();
  try {
    const alice = await reg(base, { email: 'alice@x.com', password: 'pw123456' });
    const bob = await reg(base, { email: 'bob@x.com', password: 'pw123456' });
    await req(base, '/social/cup', 'POST', { cup_id: CUP_A }, alice.token);
    await req(base, '/social/cup', 'POST', { cup_id: CUP_B }, bob.token);
    await req(base, '/social/friends', 'POST', { email: 'bob@x.com' }, alice.token);

    const today = dayKey(Date.now());
    const y = shiftDay(today, -1);
    seedDrink(app, CUP_A, y, GOAL);
    seedDrink(app, CUP_A, today, GOAL);
    seedDrink(app, CUP_B, y, GOAL);
    seedDrink(app, CUP_B, today, GOAL);

    const r = await req(base, '/social/team', 'GET', undefined, alice.token);
    assert.equal(r.status, 200);
    const j = (await r.json()) as { members: number; friends: number; streak: number; days: string[] };
    assert.equal(j.members, 2, '自己 + 一个绑了杯子的好友');
    assert.equal(j.friends, 1);
    assert.equal(j.streak, 2);
    assert.deepEqual(j.days, [y, today]);
  } finally {
    await app.close();
  }
});

test('social/team:都没绑杯子 → members 0、streak 0(不炸)', async () => {
  const { app, base } = await startApp();
  try {
    const alice = await reg(base, { email: 'alice@x.com', password: 'pw123456' });
    const r = await req(base, '/social/team', 'GET', undefined, alice.token);
    assert.equal(r.status, 200);
    const j = (await r.json()) as { members: number; streak: number };
    assert.equal(j.members, 0);
    assert.equal(j.streak, 0);
  } finally {
    await app.close();
  }
});

// ── 持久化:好友关系落盘 ──────────────────────────────────────────

test('持久化:绑杯子 + 加好友落盘,新实例读回', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { FileAccountsStore } = await import('@cup/server');

  const dir = mkdtempSync(join(tmpdir(), 'cup-social-'));
  try {
    const s1 = new FileAccountsStore(dir);
    const acc = (id: string, email: string) => ({
      user_id: id,
      email,
      nickname: id,
      salt: '00',
      hash: '00',
      role: 'user' as const,
      created_at: 1,
    });
    await s1.createAccount(acc('u_a', 'a@x.com'));
    await s1.createAccount(acc('u_b', 'b@x.com'));
    await s1.setCup('u_b', CUP_B);
    await s1.addFriend('u_a', 'u_b');
    await s1.setVisible('u_b', false);
    await s1.flush();

    const s2 = new FileAccountsStore(dir);
    assert.equal((await s2.accountById('u_b'))?.cup_id, CUP_B, '杯子绑定应恢复');
    assert.deepEqual(await s2.friends('u_a'), ['u_b'], '好友关系应恢复');
    assert.equal((await s2.accountById('u_b'))?.visible, false, '可见性开关应恢复');

    // 删好友也落盘(无向边反向调同样命中)
    await s2.removeFriend('u_b', 'u_a');
    await s2.flush();
    const s3 = new FileAccountsStore(dir);
    assert.deepEqual(await s3.friends('u_a'), [], '删好友后应落盘');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
