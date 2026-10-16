/**
 * 养成卡 / 分享卡 —— 布局计算的纯逻辑(jsdom 的 canvas 是桩,验的是"画哪些行/多高")。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPetCard, buildShareCard, cardHeight, drawCard } from '../src/lib/card-render.ts';
import type { TraitRecord } from '../src/data/source.ts';

const T: TraitRecord = {
  disposition: 'smug',
  level: 0.833,
  streak: 5,
  warmth: 0.61,
  refill_habit: 0.4,
  updated_at: 1,
};

test('buildPetCard:昵称进标题、脾气中文化、数值转百分比', () => {
  const m = buildPetCard(T, '小绿', '2026-10-12');
  assert.equal(m.title, '小绿');
  const text = m.lines.map((l) => l.text).join(' | ');
  assert.match(text, /得意洋洋/);
  assert.match(text, /连续达标\s+5 天/);
  assert.match(text, /达标率\s+83%/);
  assert.match(text, /水温满意度\s+61%/);
  assert.match(m.footnote, /2026-10-12/);
});

test('buildPetCard:空昵称 → 兜底标题,不空着', () => {
  assert.equal(buildPetCard(T, '   ', '2026-10-12').title, '我的杯子');
});

test('buildShareCard:>=2 成员 → "我们的杯子" + 天数区间', () => {
  const m = buildShareCard({ streak: 3, members: 2, days: ['2026-10-10', '2026-10-12'] }, '2026-10-12');
  assert.equal(m.title, '我们的杯子');
  const text = m.lines.map((l) => l.text).join(' | ');
  assert.match(text, /2 只杯子一起/);
  assert.match(text, /组队连续达标\s+3 天/);
  assert.match(text, /2026-10-10 → 2026-10-12/);
});

test('buildShareCard:单人 / 没队友 → "我的杯子",不显天数区间', () => {
  const m = buildShareCard({ streak: 0, members: 1, days: [] }, '2026-10-12');
  assert.equal(m.title, '我的杯子');
  assert.match(m.lines.map((l) => l.text).join(' '), /还没组上队/);
  assert.ok(!m.lines.some((l) => l.text.includes('→')));
});

test('cardHeight:随行数增长', () => {
  const a = buildPetCard(T, 'x', 'd');
  const b = buildShareCard({ streak: 1, members: 1, days: [] }, 'd');
  assert.ok(cardHeight(a) > cardHeight(b), '行多的卡更高');
});

// ── P4.3:分享卡带邀请码 ──────────────────────────────────────────

test('buildShareCard:带 invite → 卡面压一行邀请码', () => {
  const m = buildShareCard({ streak: 1, members: 1, days: [] }, '2026-10-12', 'ABCDEFGHJK');
  const text = m.lines.map((l) => l.text).join(' | ');
  assert.match(text, /邀请码\s+ABCDEFGHJK/);
});

test('buildShareCard:invite 为 null / 空串 / 空白 → 不加邀请行', () => {
  for (const v of [null, undefined, '', '   '] as const) {
    const m = buildShareCard({ streak: 1, members: 1, days: [] }, '2026-10-12', v);
    assert.ok(!m.lines.some((l) => l.text.includes('邀请码')), `invite=${JSON.stringify(v)} 不该加行`);
  }
});



test('drawCard:在桩 canvas 上跑通不抛,返回卡高', () => {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const m = buildPetCard(T, '小绿', '2026-10-12');
  const h = drawCard(ctx, m);
  assert.equal(h, cardHeight(m));
});
