/**
 * 脾气变化史(创意备忘 §5.1 #3「养成卡」的**只读半**)—— `personality/history` 读端点
 * + 纯函数 dispositionTimeline。
 *
 * 钉的是**时间线的确定性**,不是"卡长得好不好看":
 *   · 逐日回放长期性格:**同一天由"到那天为止的历史"算得**(不是拿今天的心情往过去贴)
 *   · 空白日不占位(没喝的日历日不冒充一条性格)
 *   · 一条历史里能同时出现 sulky → normal → smug(心情真的会变)
 *   · 无数据 → 200 空数组;days 夹紧 [1,31];纯读,不调 LLM
 *   · 与 /report/latest **同一个** computePersonality —— 末日的 disposition 与今日战报一致
 *
 * 起真 HTTP(createApp,与 report-history.test.ts 同法),数据走 store.applyEventToAgg 真聚合路径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '@cup/server';
import type { CupEvent } from '@cup/contract';
import { dayKey, shiftDay } from '@cup/server';

const CUP = 'cup-A1B2C3';
const GOAL = 1500;

async function startApp() {
  const app = createApp({ log: () => {}, allowUnauth: true });
  const port = await app.listen(0);
  return { app, base: `http://127.0.0.1:${port}` };
}

/** 往某天种一次 drink 事件(走真实聚合路径) */
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

async function getPersonalityHistory(base: string, qs = '') {
  const r = await fetch(`${base}/cups/${CUP}/personality/history${qs}`);
  return {
    status: r.status,
    body: (await r.json()) as {
      cup_id: string;
      count: number;
      days: Array<{ date: string; disposition: 'sulky' | 'normal' | 'smug'; reached_goal: boolean }>;
    },
  };
}

// ── 端点:逐日回放 ───────────────────────────────────────────────

test('personality/history:只返回有数据的日子,旧→新,心情随历史演变', async () => {
  const { app, base } = await startApp();
  try {
    const today = dayKey(Date.now());
    // 从 5 天前到现在:先达标、再连续欠水(→ 蔫)、中间不种(空白日)
    seedDrink(app, shiftDay(today, -5), GOAL); // 达标
    seedDrink(app, shiftDay(today, -4), 300); // 欠水
    // -3 / -2 故意空
    seedDrink(app, shiftDay(today, -1), 300); // 欠水
    seedDrink(app, today, 300); // 欠水

    const { status, body } = await getPersonalityHistory(base);
    assert.equal(status, 200);
    assert.equal(body.cup_id, CUP);
    assert.equal(body.count, 4, '四个有数据的日子 → 四条(空白日不占位)');
    assert.deepEqual(
      body.days.map((d) => d.date),
      [shiftDay(today, -5), shiftDay(today, -4), shiftDay(today, -1), today],
      '旧→新(与 report/history 的新→旧相反 —— 时间线从左到右)',
    );
    assert.equal(body.days[0]!.disposition, 'normal', '单日达标不至于 smug(要连续 2 天)');
    assert.equal(body.days[3]!.disposition, 'sulky', '最近连着欠水 → 蔫');
  } finally {
    await app.close();
  }
});

test('personality/history:记录 → 一堆 normal → 连续达标 2 天 → 末日 smug', async () => {
  const { app, base } = await startApp();
  try {
    const today = dayKey(Date.now());
    seedDrink(app, shiftDay(today, -3), 800);
    seedDrink(app, shiftDay(today, -2), 800);
    seedDrink(app, shiftDay(today, -1), GOAL); // 达标
    seedDrink(app, today, GOAL); // 达标 → 连 2 天

    const { body } = await getPersonalityHistory(base);
    assert.equal(body.days[body.days.length - 1]!.disposition, 'smug', '末日 = 连续 2 天达标 → 得意');
  } finally {
    await app.close();
  }
});

test('personality/history:与 /report/latest 同源 —— 末日 disposition 一致', async () => {
  const { app, base } = await startApp();
  try {
    const today = dayKey(Date.now());
    seedDrink(app, shiftDay(today, -2), 200);
    seedDrink(app, shiftDay(today, -1), 200);
    seedDrink(app, today, 200); // 连续欠水

    const { body: hist } = await getPersonalityHistory(base);
    const r = await fetch(`${base}/cups/${CUP}/report/latest`);
    const report = (await r.json()) as { disposition: string };
    assert.equal(r.status, 200);
    assert.equal(
      hist.days[hist.days.length - 1]!.disposition,
      report.disposition,
      '变化史末日 = 今日战报 disposition(同一 computePersonality)',
    );
  } finally {
    await app.close();
  }
});

test('personality/history:无任何数据 → 200 空数组(不是 404)', async () => {
  const { app, base } = await startApp();
  try {
    const { status, body } = await getPersonalityHistory(base);
    assert.equal(status, 200);
    assert.equal(body.count, 0);
    assert.deepEqual(body.days, []);
  } finally {
    await app.close();
  }
});

test('personality/history:days 越界夹紧,非数走默认(不炸)', async () => {
  const { app, base } = await startApp();
  try {
    seedDrink(app, dayKey(Date.now()), 300);
    assert.equal((await getPersonalityHistory(base, '?days=999')).status, 200);
    assert.equal((await getPersonalityHistory(base, '?days=0')).status, 200);
    assert.equal((await getPersonalityHistory(base, '?days=abc')).status, 200);
    const { body } = await getPersonalityHistory(base, '?days=999');
    assert.equal(body.count, 1);
  } finally {
    await app.close();
  }
});

// ── 纯函数:dispositionTimeline ──────────────────────────────────

test('dispositionTimeline:空输入 → 空时间线(不编)', async () => {
  const { dispositionTimeline } = await import('@cup/server');
  assert.deepEqual(dispositionTimeline([]), []);
});

test('dispositionTimeline:reached_goal 由当天数字定,与 disposition 解耦', async () => {
  const { dispositionTimeline } = await import('@cup/server');
  const mk = (date: string, drank: number, goal = GOAL, ev = 1) => ({
    cup_id: CUP,
    date,
    drank_ml: drank,
    refill_ml: 0,
    drink_count: drank > 0 ? 1 : 0,
    goal_ml: goal,
    temp_min_c: null,
    temp_max_c: null,
    temp_avg_c: null,
    last_volume_ml: null,
    streak: 0,
    event_count: ev,
    updated_at: ev > 0 ? 1 : 0,
  });
  // 达标的一天:reached_goal=true(哪怕单日不足以 smug)
  const tl = dispositionTimeline([mk('2026-10-09', GOAL), mk('2026-10-10', 300)]);
  assert.equal(tl[0]!.reached_goal, true);
  assert.equal(tl[0]!.disposition, 'normal');
  assert.equal(tl[1]!.reached_goal, false);
});
