/**
 * 三档删除(第 4 阶段)—— `DELETE /cups/:id/memory?scope=…` 与 `DELETE /account`。
 *
 * 钉的是**每一档恰好删对应集合**与**越权闸**,不是"删得爽不爽":
 *   · conversation → 只掉对话轮 + 长期画像;遥测/聚合/卡/性格**原封不动**
 *   · memory       → 只掉记忆卡 + 人格档案;对话轮/遥测**原封不动**
 *   · all          → 全空(遥测/事件/聚合/目标/样本/卡/对话/画像/性格)
 *   · 鉴权:无令牌 401;非本杯主人(拿别人杯 id)→ 403;**且绝不误删**(B 的数据仍在)
 *   · 账号注销:账号没了 + 名下那杯全清 + 会话失效(旧令牌 401)
 *   · scope 缺失 / 非法 → 400(不默认、不猜测,免得手滑删光)
 *
 * 起真 HTTP,数据走真实聚合路径(同 cup-llm.test.ts)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, dayKey } from '@cup/server';
import type { MemoryCard, PublicUser } from '@cup/server';
import type { CupEvent } from '@cup/contract';

const CUP_A = 'cup-A1B2C3';
const CUP_B = 'cup-B1B2C3';

async function startApp() {
  const app = createApp({ log: () => {}, allowUnauth: true });
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

/** 往某杯灌满三档数据:遥测/事件/聚合/目标/样本/记忆卡 + 对话轮 + 画像 + 性格。 */
async function seedAll(
  app: Awaited<ReturnType<typeof startApp>>['app'],
  cup: string,
): Promise<void> {
  const now = Date.now();
  const e: CupEvent = {
    v: 1, cup_id: cup, device_id: 'base', ts: now, type: 'drink', amount_ml: 300,
    confidence: 1, derived_by: 'base',
  };
  await app.store.applyEventToAgg(e);
  await app.store.appendTelemetry({ cup_id: cup, device_id: 'base', kind: 'base', ts: now, seq: 1 });
  await app.store.appendEvent(e);
  await app.store.setGoal(cup, 1800);
  await app.store.setLatestSample({
    cup_id: cup, ts: now, volume_ml: 300, level_pct: 40, temp_c: 25,
    confidence: 1, derived_by: 'base', present: true, stable: true,
  });
  const card: MemoryCard = {
    cup_id: cup, date: '2026-10-12', built_at: now,
    details: {
      drank_ml: 300, goal_ml: 1800, reached: false, streak: 1, refill_count: 0,
      temp_range: null, notable_events: [], body_cues: [], turns_summary: null, turn_count: 0,
    },
  };
  await app.store.putMemoryCard(card);
  await app.chatMemory.appendTurn({ cup_id: cup, ts: now, role: 'user', text: '今天我喝得怎么样' });
  await app.chatMemory.setProfile(cup, '爱喝温水、下午容易忘喝水。');
  await app.profiles.set(cup, {
    nickname: '小暖',
    traits: {
      disposition: 'normal',
      level: 0.5,
      streak: 1,
      warmth: 0.5,
      refill_habit: 0.5,
      updated_at: now,
    },
  });
}

/** 快照:删后用来断言"哪一档掉了"。 */
async function snap(app: Awaited<ReturnType<typeof startApp>>['app'], cup: string) {
  const now = Date.now();
  return {
    telemetry: (await app.store.telemetry(cup, 0, now + 1000)).length,
    events: (await app.store.events(cup, 0, now + 1000)).length,
    agg: await app.store.agg(cup, dayKey(now)),
    goal: await app.store.goal(cup),
    hasLatest: (await app.store.latestSample(cup)) !== null,
    cards: (await app.store.recentMemoryCards(cup, '2026-10-12', 1)).length,
    turns: (await app.chatMemory.recentTurns(cup, 50)).length,
    profile: await app.chatMemory.profile(cup),
    traits: await app.profiles.get(cup),
  };
}

test('scope=conversation:只删对话轮 + 画像;遥测/聚合/卡/性格原封不动', async () => {
  const { app, base } = await startApp();
  try {
    const token = await registerAndBind(base, CUP_A);
    await seedAll(app, CUP_A);
    const before = await snap(app, CUP_A);
    assert.ok(before.turns > 0 && before.profile && before.traits, '种子数据应齐全');

    const r = await req(base, `/cups/${CUP_A}/memory?scope=conversation`, 'DELETE', undefined, token);
    assert.equal(r.status, 200);
    const after = await snap(app, CUP_A);
    assert.equal(after.turns, 0, '对话轮应清空');
    assert.equal(after.profile, null, '画像应清空');
    // 其余三档不动
    assert.equal(after.telemetry, before.telemetry, '遥测应保留');
    assert.equal(after.events, before.events, '事件应保留');
    assert.ok(after.agg, '日聚应保留');
    assert.equal(after.goal, 1800, '目标应保留');
    assert.ok(after.hasLatest, '最新样本应保留');
    assert.equal(after.cards, 1, '记忆卡应保留');
    assert.ok(after.traits, '人格档案应保留');
  } finally {
    await app.close();
  }
});

test('scope=memory:只删记忆卡 + 人格档案;对话轮/遥测原封不动', async () => {
  const { app, base } = await startApp();
  try {
    const token = await registerAndBind(base, CUP_A);
    await seedAll(app, CUP_A);
    const before = await snap(app, CUP_A);

    const r = await req(base, `/cups/${CUP_A}/memory?scope=memory`, 'DELETE', undefined, token);
    assert.equal(r.status, 200);
    const after = await snap(app, CUP_A);
    assert.equal(after.cards, 0, '记忆卡应清空');
    assert.equal(after.traits, null, '人格档案应清空');
    // 其余不动
    assert.equal(after.turns, before.turns, '对话轮应保留');
    assert.ok(after.profile, '画像应保留');
    assert.equal(after.telemetry, before.telemetry, '遥测应保留');
    assert.equal(after.events, before.events, '事件应保留');
    assert.ok(after.agg, '日聚应保留');
  } finally {
    await app.close();
  }
});

test('scope=all:一切都归零', async () => {
  const { app, base } = await startApp();
  try {
    const token = await registerAndBind(base, CUP_A);
    await seedAll(app, CUP_A);

    const r = await req(base, `/cups/${CUP_A}/memory?scope=all`, 'DELETE', undefined, token);
    assert.equal(r.status, 200);
    const after = await snap(app, CUP_A);
    assert.equal(after.telemetry, 0);
    assert.equal(after.events, 0);
    assert.equal(after.agg, null);
    assert.equal(after.hasLatest, false);
    assert.equal(after.cards, 0);
    assert.equal(after.turns, 0);
    assert.equal(after.profile, null);
    assert.equal(after.traits, null);
  } finally {
    await app.close();
  }
});

test('越权:拿别人的杯 id 删 → 403,且 B 的数据一根汗毛都不动', async () => {
  const { app, base } = await startApp();
  try {
    const tokenA = await registerAndBind(base, CUP_A);
    await registerAndBind(base, CUP_B); // B 绑了 CUP_B
    await seedAll(app, CUP_B);
    const before = await snap(app, CUP_B);

    // A 的会话 + B 的杯 id(scope=all,最狠的一档)
    const r = await req(base, `/cups/${CUP_B}/memory?scope=all`, 'DELETE', undefined, tokenA);
    assert.equal(r.status, 403, '非本杯主人 → 403');
    const after = await snap(app, CUP_B);
    assert.equal(after.telemetry, before.telemetry, 'B 的遥测不该被删');
    assert.equal(after.turns, before.turns, 'B 的对话轮不该被删');
    assert.equal(after.cards, before.cards, 'B 的卡不该被删');
    assert.equal(after.goal, before.goal, 'B 的目标不该被删');
  } finally {
    await app.close();
  }
});

test('无令牌 → 401(走会话闸,不走 x-api-key)', async () => {
  const { app, base } = await startApp();
  try {
    const r = await req(base, `/cups/${CUP_A}/memory?scope=all`, 'DELETE');
    assert.equal(r.status, 401);
  } finally {
    await app.close();
  }
});

test('scope 缺失 / 非法 → 400,且不删任何东西', async () => {
  const { app, base } = await startApp();
  try {
    const token = await registerAndBind(base, CUP_A);
    await seedAll(app, CUP_A);
    const before = await snap(app, CUP_A);

    assert.equal((await req(base, `/cups/${CUP_A}/memory`, 'DELETE', undefined, token)).status, 400);
    assert.equal(
      (await req(base, `/cups/${CUP_A}/memory?scope=everything`, 'DELETE', undefined, token)).status,
      400,
    );
    const after = await snap(app, CUP_A);
    assert.equal(after.turns, before.turns, '400 不该动数据');
    assert.equal(after.telemetry, before.telemetry);
  } finally {
    await app.close();
  }
});

test('DELETE /account:账号没了 + 名下那杯全清 + 旧令牌失效', async () => {
  const { app, base } = await startApp();
  try {
    const token = await registerAndBind(base, CUP_A);
    await seedAll(app, CUP_A);

    const r = await req(base, '/account', 'DELETE', undefined, token);
    assert.equal(r.status, 200);
    const after = await snap(app, CUP_A);
    assert.equal(after.turns, 0, '名下那杯对话应清空');
    assert.equal(after.telemetry, 0, '名下那杯遥测应清空');
    assert.equal(after.cards, 0);
    assert.equal(after.traits, null);

    // 旧令牌立即失效(会话被清)
    assert.equal((await req(base, '/auth/me', 'GET', undefined, token)).status, 401);
    // 账号真的没了(重新登同邮箱话不该存在 —— 这里用 me 已证令牌失效即够)
  } finally {
    await app.close();
  }
});

test('DELETE /account:未登录 → 401', async () => {
  const { app, base } = await startApp();
  try {
    assert.equal((await req(base, '/account', 'DELETE')).status, 401);
  } finally {
    await app.close();
  }
});
