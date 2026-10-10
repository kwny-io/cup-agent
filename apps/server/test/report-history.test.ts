/**
 * 历史战报(§09 待办「历史战报待」)—— `report/history` 读端点 + 纯函数 historyFacts/historyHeadline。
 *
 * 钉的是**确定性与边界**,不是"文案好不好":
 *   · 只返回**有数据的日子**(没喝的日子不冒充战报),且**新→旧**
 *   · 每天文案由后端给(模板句),数字恒来自日聚合
 *   · days 参数夹紧 [1,31];无数据 → 200 空数组(**不是 404**,空是正常态)
 *   · 纯读端点,**不调 LLM**,故没有降级分支——天生确定
 *
 * 起真 HTTP(createApp,与 api-errors.test.ts 同法),不开 sim/mqtt。
 * 数据用 store.applyEventToAgg 直接种(最贴近"后端已收到事件"的真实聚合路径)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '@cup/server';
import type { CupEvent } from '@cup/contract';
import { dayKey, shiftDay } from '@cup/server';

const CUP = 'cup-A1B2C3';

async function startApp() {
  const app = createApp({ log: () => {}, allowUnauth: true });
  const port = await app.listen(0);
  return { app, base: `http://127.0.0.1:${port}` };
}

/** 往某天种一次 drink 事件(走真实聚合路径 —— 与 ingest 同一函数) */
function seedDrink(app: Awaited<ReturnType<typeof startApp>>['app'], date: string, ml: number): void {
  const ts = new Date(`${date}T12:00:00`).getTime();
  const e: CupEvent = {
    v: 1,
    cup_id: CUP,
    device_id: 'base-A1B2C3',
    ts,
    type: 'drink',
    amount_ml: ml,
    confidence: 1,
    derived_by: 'base',
  };
  app.store.applyEventToAgg(e);
}

async function getHistory(base: string, qs = '') {
  const r = await fetch(`${base}/cups/${CUP}/report/history${qs}`);
  return { status: r.status, body: (await r.json()) as {
    cup_id: string; count: number; days: Array<{ date: string; drank_ml: number; headline: string; reached_goal: boolean }>;
  } };
}

// ── 纯读端点:有数据 → 按天回望 ──────────────────────────────────

test('report/history:只返回有数据的日子,新→旧,数字来自聚合', async () => {
  const { app, base } = await startApp();
  try {
    const today = dayKey(Date.now());
    seedDrink(app, shiftDay(today, -2), 800);
    seedDrink(app, today, 1500); // 今天达标
    // 昨天故意不种 → 不该出现在历史里

    const { status, body } = await getHistory(base);
    assert.equal(status, 200);
    assert.equal(body.cup_id, CUP);
    assert.equal(body.count, 2, '两天有数据 → 两条');
    assert.deepEqual(
      body.days.map((d) => d.date),
      [today, shiftDay(today, -2)],
      '新→旧',
    );
    assert.equal(body.days[0]!.drank_ml, 1500);
    assert.equal(body.days[0]!.reached_goal, true);
    assert.equal(body.days[1]!.drank_ml, 800);
    assert.ok(body.days[0]!.headline.includes('1500'), '文案含真实数字');
  } finally {
    await app.close();
  }
});

test('report/history:喝过即出现在历史里 —— 500ml / 目标1500 走"偏少"档', async () => {
  const { app, base } = await startApp();
  try {
    const today = dayKey(Date.now());
    seedDrink(app, today, 500);
    const { body } = await getHistory(base);
    assert.equal(body.count, 1);
    assert.ok(body.days[0]!.headline.startsWith('才 500ml'), `未过 1/3 档文案,实得「${body.days[0]!.headline}」`);
  } finally {
    await app.close();
  }
});

test('report/history:无任何数据 → 200 空数组(不是 404,空是正常态)', async () => {
  const { app, base } = await startApp();
  try {
    const { status, body } = await getHistory(base);
    assert.equal(status, 200);
    assert.equal(body.count, 0);
    assert.deepEqual(body.days, []);
  } finally {
    await app.close();
  }
});

// ── days 参数:夹紧 [1,31] ───────────────────────────────────────

test('report/history:days 越界被夹紧,非数走默认 7', async () => {
  const { app, base } = await startApp();
  try {
    seedDrink(app, dayKey(Date.now()), 300);
    // days 超上限 → 仍 200,且不报错(夹到 31);只验"不炸、有数据照给"
    assert.equal((await getHistory(base, '?days=999')).status, 200);
    assert.equal((await getHistory(base, '?days=0')).status, 200);
    assert.equal((await getHistory(base, '?days=abc')).status, 200);
    const { body } = await getHistory(base, '?days=999');
    assert.equal(body.count, 1, '夹紧后仍能拿到有数据的日子');
  } finally {
    await app.close();
  }
});

// ── 纯函数:historyHeadline 只按当天数字分档 ─────────────────────

test('historyHeadline:四档措辞 —— 达标/过半/偏少/没喝', async () => {
  const { historyHeadline } = await import('@cup/server');
  const f = (drank: number, goal = 1500) => ({
    date: '2026-10-10',
    drank_ml: drank,
    goal_ml: goal,
    progress: goal > 0 ? Math.min(100, Math.round((drank / goal) * 100)) : 0,
    drink_count: drank > 0 ? 1 : 0,
    temp_min_c: null,
    temp_max_c: null,
    streak: 0,
    reached_goal: goal > 0 && drank >= goal,
  });
  assert.ok(historyHeadline(f(1500)).includes('达标'));
  assert.ok(historyHeadline(f(900)).includes('过半'));
  assert.ok(historyHeadline(f(300)).startsWith('才 '));
  assert.ok(historyHeadline(f(0)).includes('一口都没喝'));
});
