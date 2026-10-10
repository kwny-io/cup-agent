/**
 * 性格层 + 战报 + LLM 降级测试 —— 对应 plan.md M4 验收 1/2/3。
 *
 * 三条验收:
 *   1. 连续 N 天不达标 → 蔫;达标则反之        → computePersonality
 *   2. 战报数字与看板一致(不能瞎编)          → facts/headline 里的数字来自聚合
 *   3. 断 LLM 回退模板,前端不出空白/报错     → enrichReport + 数字守卫
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePersonality,
  generateReport,
  templateHeadline,
  enrichReport,
  type Llm,
  type LlmRequest,
} from '@cup/server';
import type { DailyAgg } from '@cup/server';

const GOAL = 1500;

function agg(date: string, drank: number, goal = GOAL): DailyAgg {
  return {
    cup_id: 'cup-A1B2C3',
    date,
    drank_ml: drank,
    refill_ml: 0,
    drink_count: drank > 0 ? Math.max(1, Math.round(drank / 200)) : 0,
    goal_ml: goal,
    temp_min_c: 30,
    temp_max_c: 60,
    temp_avg_c: 45,
    last_volume_ml: 300,
    streak: 0,
    event_count: drank > 0 ? 3 : 0,
    updated_at: drank > 0 || goal > 0 ? 1 : 0,
  };
}

// ── 验收 1:性格演化 ───────────────────────────────────────────────

test('性格:连续达标 2 天以上 → 得意(smug)', () => {
  const recent = [agg('2026-10-05', 1600), agg('2026-10-06', 1700), agg('2026-10-07', 1800)];
  const p = computePersonality(recent, true);
  assert.equal(p.disposition, 'smug');
  assert.ok(p.streak >= 2);
});

test('性格:近期一直不达标 → 蔫(sulky)', () => {
  const recent = [agg('2026-10-05', 200), agg('2026-10-06', 300), agg('2026-10-07', 150)];
  const p = computePersonality(recent, false);
  assert.equal(p.disposition, 'sulky');
});

test('性格:今天还没结束,今天没达标不算"蔫"的证据', () => {
  // 过去几天都达标,只有今天(进行中)是 0 → 不该被判成蔫
  const recent = [
    agg('2026-10-05', 1600),
    agg('2026-10-06', 1700),
    agg('2026-10-07', 0),
  ];
  const p = computePersonality(recent, false);
  assert.notEqual(p.disposition, 'sulky');
});

test('性格:数据不足(空窗口)不会莫须有地判蔫', () => {
  const p = computePersonality([], false);
  assert.equal(p.disposition, 'normal');
});

test('性格:达标率低但连续达标 → 得意优先(顺序即优先级)', () => {
  const recent = [agg('2026-10-05', 100), agg('2026-10-06', 1600), agg('2026-10-07', 1700)];
  const p = computePersonality(recent, true);
  assert.equal(p.disposition, 'smug');
});

// ── 验收 2:战报数字必须真 ─────────────────────────────────────────

test('战报:facts 的数字直接来自聚合,不重算', () => {
  const a = agg('2026-10-08', 720);
  const recent = [agg('2026-10-06', 1600), a];
  const r = generateReport(a, recent);
  assert.equal(r.facts.drank_ml, 720);
  assert.equal(r.facts.goal_ml, GOAL);
  assert.equal(r.facts.drink_count, a.drink_count);
  assert.equal(r.facts.progress, Math.round((720 / GOAL) * 100));
  assert.equal(r.facts.reached_goal, false);
});

test('战报:headline 里的数字都出现在 facts 里(没有凭空数字)', () => {
  const a = agg('2026-10-08', 720);
  const r = generateReport(a, [a]);
  const numbers = (r.headline.match(/\d+/g) ?? []).map(Number);
  const allowed = new Set([
    r.facts.drank_ml,
    r.facts.goal_ml,
    r.facts.streak,
    r.facts.drink_count,
  ]);
  for (const n of numbers) assert.ok(allowed.has(n), `headline 出现了不在 facts 里的数字 ${n}`);
});

test('战报:达标/未达标/一口没喝 → 三种文案都带真实数字或明确说明', () => {
  const ok = templateHeadline(
    { disposition: 'normal', level: 1, streak: 0, reason: '' },
    { date: '2026-10-08', drank_ml: 1600, goal_ml: GOAL, progress: 100, drink_count: 5, temp_min_c: null, temp_max_c: null, streak: 0, reached_goal: true },
  );
  assert.match(ok, /1600/);

  const none = templateHeadline(
    { disposition: 'sulky', level: 0, streak: 0, reason: '' },
    { date: '2026-10-08', drank_ml: 0, goal_ml: GOAL, progress: 0, drink_count: 0, temp_min_c: null, temp_max_c: null, streak: 0, reached_goal: false },
  );
  assert.match(none, /一口都没喝/);
});

// ── 验收 3:LLM 降级 ───────────────────────────────────────────────

/** 永远出错的 LLM(模拟超时 / 网络不通) */
class BrokenLlm implements Llm {
  readonly name = 'broken';
  async complete(): Promise<string> {
    throw new Error('boom');
  }
}

/** 正常但"数字对不上"的 LLM(模拟胡编) */
class WrongNumberLlm implements Llm {
  readonly name = 'wrong';
  async complete(): Promise<string> {
    return '今天喝了 9999ml,真棒!'; // 数字与原句不符
  }
}

/** 正常润色的 LLM(保留数字) */
class GoodLlm implements Llm {
  readonly name = 'good';
  async complete(req: LlmRequest): Promise<string> {
    // 从 prompt 里抠出原句(模拟真模型:改语气不改数字)
    const m = req.prompt.match(/「(.+?)」/);
    const original = m?.[1] ?? '';
    const nums = (original.match(/\d+/g) ?? []).join('/');
    return `哼,${original}——才不是关心你呢(${nums||'—'})`;
  }
}

test('降级:LLM 出错 → 原样退回模板(source=template)', async () => {
  const a = agg('2026-10-08', 720);
  const base = generateReport(a, [a]);
  const r = await enrichReport(base, new BrokenLlm());
  assert.equal(r.source, 'template');
  assert.equal(r.headline, base.headline);
});

test('降级:LLM 胡编数字 → 被守卫拦下,退回模板', async () => {
  const a = agg('2026-10-08', 720);
  const base = generateReport(a, [a]);
  const r = await enrichReport(base, new WrongNumberLlm());
  assert.equal(r.source, 'template');
  assert.equal(r.headline, base.headline);
});

test('降级:llm=null → 直接用模板,不报错', async () => {
  const a = agg('2026-10-08', 720);
  const base = generateReport(a, [a]);
  const r = await enrichReport(base, null);
  assert.equal(r.source, 'template');
});

test('降级:LLM 正常且保留数字 → 采用润色(source=llm),数字不变', async () => {
  const a = agg('2026-10-08', 720);
  const base = generateReport(a, [a]);
  const r = await enrichReport(base, new GoodLlm());
  assert.equal(r.source, 'llm');
  assert.notEqual(r.headline, base.headline);
  // 数字仍在
  assert.match(r.headline, /720/);
  assert.equal(r.facts.drank_ml, 720); // 事实从不被 LLM 改动
});
