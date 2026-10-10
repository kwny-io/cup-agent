/**
 * 杯量分档纯逻辑的回归 —— 边界(100/200/300/400)与"只看今天"的过滤。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRINK_BANDS, bandOf, drinkBuckets } from '../src/lib/buckets.ts';
import type { CupEvent } from '@cup/contract';

function drink(amountMl: number, ts = Date.now()): CupEvent {
  return {
    v: 1,
    cup_id: 'cup-WEB01',
    device_id: 'lid-WEB01',
    ts,
    type: 'drink',
    amount_ml: amountMl,
    confidence: 0.9,
    derived_by: 'lid',
  };
}

test('bandOf:半开区间边界(100 归小杯,不归小口)', () => {
  assert.equal(bandOf(0).key, 'sip');
  assert.equal(bandOf(99).key, 'sip');
  assert.equal(bandOf(100).key, 'small'); // 边界 → 下一档
  assert.equal(bandOf(199).key, 'small');
  assert.equal(bandOf(200).key, 'medium');
  assert.equal(bandOf(299).key, 'medium');
  assert.equal(bandOf(300).key, 'large');
  assert.equal(bandOf(399).key, 'large');
  assert.equal(bandOf(400).key, 'full'); // 最后一档无上界
  assert.equal(bandOf(9999).key, 'full');
});

test('bandOf:负数/非有限值一律夹到第一档(不是真实量的都当 0)', () => {
  assert.equal(bandOf(-5).key, 'sip');
  assert.equal(bandOf(NaN).key, 'sip');
  assert.equal(bandOf(Infinity).key, 'sip');
  assert.equal(bandOf(9999).key, 'full'); // 有限的大值才归"豪饮"
});

test('drinkBuckets:按档计数与合计,总次数/总毫升对得上', () => {
  const events = [
    drink(50), // sip
    drink(80), // sip
    drink(150), // small
    drink(250), // medium
    drink(250), // medium
    drink(500), // full
  ];
  const r = drinkBuckets(events);
  const by = (k: string) => r.bands.find((b) => b.key === k)!;
  assert.equal(by('sip').count, 2);
  assert.equal(by('sip').totalMl, 130);
  assert.equal(by('small').count, 1);
  assert.equal(by('small').totalMl, 150);
  assert.equal(by('medium').count, 2);
  assert.equal(by('medium').totalMl, 500);
  assert.equal(by('large').count, 0); // 没数据也要有这一档(卡片画空柱)
  assert.equal(by('full').count, 1);
  assert.equal(r.totalCount, 6);
  assert.equal(r.totalMl, 130 + 150 + 500 + 500);
  // 每档合计之和 == 总毫升
  assert.equal(
    r.bands.reduce((s, b) => s + b.totalMl, 0),
    r.totalMl,
  );
  assert.equal(r.bands.length, DRINK_BANDS.length); // 档位齐全,顺序不变
});

test('drinkBuckets:只算今天;昨天的不进桶', () => {
  const now = Date.now();
  const yesterday = now - 86_400_000;
  const r = drinkBuckets([drink(200, now), drink(200, yesterday)], now);
  assert.equal(r.totalCount, 1);
  assert.equal(r.totalMl, 200);
});

test('drinkBuckets:非 drink 事件 / 缺 amount_ml 的 drink 不污染分档', () => {
  const now = Date.now();
  const refill: CupEvent = { ...drink(500, now), type: 'refill' };
  const noAmount = { ...drink(0, now), amount_ml: undefined } as CupEvent;
  const r = drinkBuckets([refill, noAmount, drink(120, now)], now);
  assert.equal(r.totalCount, 1); // 只有 120 那条算
  assert.equal(r.totalMl, 120);
});

test('drinkBuckets:空输入 → 全零、档位仍在', () => {
  const r = drinkBuckets([]);
  assert.equal(r.totalCount, 0);
  assert.equal(r.totalMl, 0);
  assert.equal(r.bands.length, DRINK_BANDS.length);
  assert.ok(r.bands.every((b) => b.count === 0 && b.totalMl === 0));
});
