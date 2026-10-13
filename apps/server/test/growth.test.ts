/**
 * 成长层(养成闭环,优先级 1)—— `core/growth.ts` 纯派生 + `GET /cups/:id/growth` 端点。
 *
 * 钉三件事:
 *   1. **纯换算**:一起第 N 天 / 阶段阶梯 / 里程碑阶梯 / 进度 —— 输入日聚合,输出快照,零 I/O。
 *   2. **庆祝只在新跨坎那天**:`celebrate` 由"去掉今天再算一遍"推出,天天有卡 ≠ 天天庆祝。
 *   3. **读端点闸**:会话 + 归属(默认开),无令牌 401,非主人 403,空数据 200(新生,不是 404)。
 *
 * 数字全来自 `recentAggs`(已有 store 方法),故这里不新增 store;窗口口径在 http.ts(GROWTH_DAYS)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createApp,
  dayKey,
  dayStart,
  shiftDay,
  deriveGrowth,
  stageFor,
  statsOf,
  type DailyAgg,
} from '@cup/server';
import type { PublicUser } from '@cup/server';

const CUP_A = 'cup-A1B2C3';
const CUP_B = 'cup-B1B2C3';
const GOAL = 1500;

// ── 纯函数 ────────────────────────────────────────────────────────

/** 造一天的聚合:`drank` 达标线与 `streak` 直接给,`event_count` 由"有没有喝/续"推出 */
function mk(
  date: string,
  o: { drank?: number; goal?: number; streak?: number; refill?: number; events?: number } = {},
): DailyAgg {
  const drank = o.drank ?? 0;
  const refill = o.refill ?? 0;
  return {
    cup_id: CUP_A,
    date,
    drank_ml: drank,
    refill_ml: refill,
    drink_count: drank > 0 ? 1 : 0,
    goal_ml: o.goal ?? GOAL,
    temp_min_c: null,
    temp_max_c: null,
    temp_avg_c: null,
    last_volume_ml: null,
    streak: o.streak ?? 0,
    event_count: o.events ?? (drank > 0 || refill > 0 ? 1 : 0),
    updated_at: 1,
  };
}

test('成长:空窗口 → 新生阶段 + 全未达成 + 不庆祝', () => {
  const g = deriveGrowth([]);
  assert.equal(g.days_together, 0);
  assert.equal(g.best_streak, 0);
  assert.equal(g.stage.key, 'newborn');
  assert.equal(g.next_stage?.key, 'sprout', '新生之后是幼芽');
  assert.ok(g.milestones.every((m) => !m.achieved), '空窗口没有里程碑');
  assert.equal(g.next_milestone?.id, 'first_drop', '第一个待解锁是"第一口水"');
  assert.equal(g.celebrate, null, '没有跨坎 → 不庆祝');
});

test('成长:一起第 N 天 = 最早有活动的那天到今天(含空档,不跳日)', () => {
  // 5 天窗口,只有第 1 天和最后一天有活动 → 跨度仍是 5 天
  const recent = [
    mk('d1', { drank: 500 }),
    mk('d2'),
    mk('d3'),
    mk('d4'),
    mk('d5', { drank: 500 }),
  ];
  assert.equal(statsOf(recent).days_together, 5);
});

test('成长:全程无活动 → 一起 0 天(不莫须有)', () => {
  const recent = [mk('d1'), mk('d2'), mk('d3')];
  assert.equal(statsOf(recent).days_together, 0);
});

test('成长:有事件但没喝水也算"在场"(shake 等)', () => {
  const recent = [mk('d1', { events: 1, drank: 0 }), mk('d2', { events: 1, drank: 0 })];
  assert.equal(statsOf(recent).days_together, 2, '事件日算活动');
});

test('成长:阶段阶梯边界(3/7/30/100/365)', () => {
  const cases: [number, string][] = [
    [0, 'newborn'],
    [2, 'newborn'],
    [3, 'sprout'],
    [6, 'sprout'],
    [7, 'growing'],
    [29, 'growing'],
    [30, 'steady'],
    [99, 'steady'],
    [100, 'companion'],
    [364, 'companion'],
    [365, 'legend'],
  ];
  for (const [days, key] of cases) assert.equal(stageFor(days).key, key, `${days} 天 → ${key}`);
});

test('成长:里程碑四项数值 + 进度(达标天数 / 续杯天数 / 最长连击)', () => {
  const recent = [
    mk('d1', { drank: 1600, streak: 1 }),
    mk('d2', { drank: 1600, streak: 2 }),
    mk('d3', { drank: 800, refill: 300, streak: 0 }), // 没达标但续了杯
    mk('d4', { drank: 1600, streak: 1 }),
  ];
  const g = deriveGrowth(recent);
  assert.equal(g.total_achieved_days, 3);
  assert.equal(g.total_refill_days, 1);
  assert.equal(g.best_streak, 2, '取历史最长连击');

  const byId = Object.fromEntries(g.milestones.map((m) => [m.id, m]));
  assert.equal(byId['first_drop']!.achieved, true);
  assert.equal(byId['achieved_7']!.achieved, false);
  assert.equal(byId['achieved_7']!.value, 3);
  assert.ok(Math.abs(byId['achieved_7']!.progress - 3 / 7) < 1e-9, '进度 = 3/7');
  assert.equal(byId['streak_3']!.achieved, false, '最长 2 天 → 连续 3 天未解锁');
  assert.equal(byId['refill_7']!.value, 1);
});

test('成长:下一里程碑 = 阶梯里第一个未达成', () => {
  const g = deriveGrowth([mk('d1', { drank: 1600, streak: 1 })]);
  assert.equal(g.next_milestone?.id, 'together_3', 'first_drop 已达成 → 下一个是"一起 3 天"');
});

test('成长:今天刚跨坎 → celebrate 就是那道坎', () => {
  // 3 天全达标 + 全在场:昨天(2 天)时 together_3 还没达成,今天(3 天)达成
  const recent = [
    mk('d1', { drank: 1600, streak: 1 }),
    mk('d2', { drank: 1600, streak: 2 }),
    mk('d3', { drank: 1600, streak: 3 }),
  ];
  const g = deriveGrowth(recent);
  assert.ok(g.celebrate, '今天跨了坎 → 应庆祝');
  assert.equal(g.celebrate!.id, 'together_3');
});

test('成长:没跨坎的那天 → 不庆祝(天天有卡 ≠ 天天庆祝)', () => {
  // 2 天达标:今天把"达标天数"从 1 加到 2,但里程碑坎在 1 / 7,今天没跨
  const recent = [mk('d1', { drank: 1600, streak: 1 }), mk('d2', { drank: 1600, streak: 2 })];
  const g = deriveGrowth(recent);
  assert.equal(g.celebrate, null);
});

test('成长:单天窗口不庆祝(没有"昨天"可比)', () => {
  const g = deriveGrowth([mk('d1', { drank: 1600, streak: 1 })]);
  assert.equal(g.celebrate, null);
});

// ── 端点 ──────────────────────────────────────────────────────────

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

/** 往某天灌一次喝水事件(日聚合的唯一写入口;ts 落在那天内) */
async function seedDrink(
  app: Awaited<ReturnType<typeof startApp>>['app'],
  cup: string,
  date: string,
  ml: number,
): Promise<void> {
  await app.store.applyEventToAgg({
    v: 1,
    cup_id: cup,
    device_id: 'lid-A1B2C3',
    ts: dayStart(date) + 3_600_000,
    type: 'drink',
    amount_ml: ml,
    confidence: 0.9,
    derived_by: 'backend',
  });
}

type GrowthBody = {
  cup_id: string;
  today: string;
  growth: {
    days_together: number;
    stage: { key: string; name: string; min_days: number };
    next_stage: { key: string } | null;
    milestones: { id: string; achieved: boolean }[];
    next_milestone: { id: string } | null;
    celebrate: { id: string } | null;
  };
};

test('端点:空数据 → 200 + 新生(不是 404)', async () => {
  const { app, base } = await startApp();
  try {
    const token = await registerAndBind(base, CUP_A);
    const r = await req(base, `/cups/${CUP_A}/growth`, 'GET', undefined, token);
    assert.equal(r.status, 200);
    const body = (await r.json()) as GrowthBody;
    assert.equal(body.cup_id, CUP_A);
    assert.equal(body.growth.days_together, 0);
    assert.equal(body.growth.stage.key, 'newborn');
    assert.equal(body.growth.celebrate, null);
  } finally {
    await app.close();
  }
});

test('端点:跨 7 天有活动 → 一起第 7 天 + 成长期', async () => {
  const { app, base } = await startApp();
  try {
    const token = await registerAndBind(base, CUP_A);
    const today = dayKey(Date.now());
    await seedDrink(app, CUP_A, shiftDay(today, -6), 600);
    await seedDrink(app, CUP_A, today, 1600);

    const r = await req(base, `/cups/${CUP_A}/growth`, 'GET', undefined, token);
    assert.equal(r.status, 200);
    const body = (await r.json()) as GrowthBody;
    assert.equal(body.growth.days_together, 7, '第 1 天到今天 = 7 天');
    assert.equal(body.growth.stage.key, 'growing');
    assert.equal(body.growth.next_stage?.key, 'steady');
    assert.ok(body.growth.milestones.some((m) => m.id === 'together_7' && m.achieved), '一起一周应解锁');
  } finally {
    await app.close();
  }
});

test('端点:鉴权 —— 无令牌 401', async () => {
  const { app, base } = await startApp({ allowUnauth: false });
  try {
    const r = await req(base, `/cups/${CUP_A}/growth`, 'GET');
    assert.equal(r.status, 401);
  } finally {
    await app.close();
  }
});

test('端点:鉴权 —— 登录但非本杯主人 403', async () => {
  const { app, base } = await startApp({ allowUnauth: false });
  try {
    const tokenA = await registerAndBind(base, CUP_A);
    const r = await req(base, `/cups/${CUP_B}/growth`, 'GET', undefined, tokenA);
    assert.equal(r.status, 403);
  } finally {
    await app.close();
  }
});
