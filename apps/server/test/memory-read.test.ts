/**
 * 记忆卡读端(第 3 阶段·回忆线)—— `GET /cups/:id/memory` 的窗口与 `?all=1`。
 *
 * 钉的是**窗口口径**与**归属闸**,不是"卡长什么样"(那在 memory-cards.test.ts):
 *   · `?recent=N` → 最近 N 天(只含有卡的天);N 超上限(366)被钳,不越界查询
 *   · `?all=1` → 一年整窗,一次翻完(给「回忆」用)
 *   · 默认(无参)→ 7 天
 *   · 无令牌 401;非本杯主人 403
 *
 * 全年回溯是「那年今日 / 一起第 N 天」的前置 —— 原先上限 30 天翻不到去年,故这轮放宽。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, dayKey, shiftDay } from '@cup/server';
import type { MemoryCard, PublicUser } from '@cup/server';

const CUP_A = 'cup-A1B2C3';
const CUP_B = 'cup-B1B2C3';

/** 窗口类用例豁免鉴权(专注窗口口径);鉴权类用例走默认(强制)。 */
async function startApp(opts: { allowUnauth?: boolean } = { allowUnauth: true }) {
  const app = createApp({ log: () => {}, ...opts });
  const port = await app.listen(0);
  return { app, base: `http://127.0.0.1:${port}` };
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

async function registerAndBind(base: string, cup: string): Promise<string> {
  const r = await req(base, '/auth/register', 'POST', {
    email: `u${Math.random().toString(36).slice(2)}@x.com`,
    password: 'pw123456',
  });
  assert.equal(r.status, 200, '注册应成功');
  const { token } = (await r.json()) as { token: string; user: PublicUser };
  const b = await req(base, '/social/cup', 'POST', { cup_id: cup }, token);
  assert.equal(b.status, 200, '绑杯应成功');
  return token;
}

function card(cup: string, date: string, drank = 1000): MemoryCard {
  const ts = Date.now();
  return {
    cup_id: cup,
    date,
    built_at: ts,
    details: {
      drank_ml: drank,
      goal_ml: 1500,
      reached: drank >= 1500,
      streak: 1,
      refill_count: 0,
      temp_range: null,
      notable_events: [],
      body_cues: [],
      turns_summary: null,
      turn_count: 0,
    },
  };
}

/** 灌 N 张卡,日期自 today 起往前推(今天、昨天、前天…) */
async function seedCards(
  app: Awaited<ReturnType<typeof startApp>>['app'],
  cup: string,
  n: number,
): Promise<void> {
  const today = dayKey(Date.now());
  for (let i = 0; i < n; i++) await app.store.putMemoryCard(card(cup, shiftDay(today, -i)));
}

type Days = { cup_id: string; days: MemoryCard[] };

test('默认:无参 → 最多 7 天窗口内已有的卡', async () => {
  const { app, base } = await startApp();
  try {
    const token = await registerAndBind(base, CUP_A);
    await seedCards(app, CUP_A, 10); // 10 张,但默认窗口 7 天
    const r = await req(base, `/cups/${CUP_A}/memory`, 'GET', undefined, token);
    assert.equal(r.status, 200);
    const body = (await r.json()) as Days;
    assert.equal(body.days.length, 7, '默认窗口应为 7 天');
  } finally {
    await app.close();
  }
});

test('?recent=N → 最近 N 天;超出可得卡数就只得那些(不补空卡)', async () => {
  const { app, base } = await startApp();
  try {
    const token = await registerAndBind(base, CUP_A);
    await seedCards(app, CUP_A, 3);
    const r = await req(base, `/cups/${CUP_A}/memory?recent=30`, 'GET', undefined, token);
    const body = (await r.json()) as Days;
    assert.equal(body.days.length, 3, '只有 3 张卡 → 只回 3 天');
  } finally {
    await app.close();
  }
});

test('?all=1 → 一年整窗一次翻完(40 张全回,旧上限 30 已放宽)', async () => {
  const { app, base } = await startApp();
  try {
    const token = await registerAndBind(base, CUP_A);
    await seedCards(app, CUP_A, 40);
    const r = await req(base, `/cups/${CUP_A}/memory?all=1`, 'GET', undefined, token);
    assert.equal(r.status, 200);
    const body = (await r.json()) as Days;
    assert.equal(body.days.length, 40, 'all=1 应取全部有卡的日');
  } finally {
    await app.close();
  }
});

test('?recent=9999 → 钳到上限 366,不越界(不 500)', async () => {
  const { app, base } = await startApp();
  try {
    const token = await registerAndBind(base, CUP_A);
    await seedCards(app, CUP_A, 5);
    const r = await req(base, `/cups/${CUP_A}/memory?recent=9999`, 'GET', undefined, token);
    assert.equal(r.status, 200);
    const body = (await r.json()) as Days;
    assert.equal(body.days.length, 5);
  } finally {
    await app.close();
  }
});

test('鉴权:无令牌 → 401', async () => {
  const { app, base } = await startApp({ allowUnauth: false });
  try {
    const r = await req(base, `/cups/${CUP_A}/memory`, 'GET');
    assert.equal(r.status, 401);
  } finally {
    await app.close();
  }
});

test('鉴权:登录但非本杯主人 → 403(不给读别家的回忆)', async () => {
  const { app, base } = await startApp({ allowUnauth: false });
  try {
    const tokenA = await registerAndBind(base, CUP_A);
    // A 只绑了 CUP_A;B 的杯有卡,但 A 去读 → 403
    await seedCards(app, CUP_B, 3);
    const r = await req(base, `/cups/${CUP_B}/memory?all=1`, 'GET', undefined, tokenA);
    assert.equal(r.status, 403);
  } finally {
    await app.close();
  }
});
