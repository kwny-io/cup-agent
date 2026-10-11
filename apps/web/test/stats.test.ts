/**
 * 饮水曲线"用哪份桶"的回归(S6:收窄 lib/stats.ts 的职责)。
 *
 * 前端现算(hourlyIntake)与后端整天分桶(hourlyFromSeries)是两条来源,
 * `intakeBuckets` 是要害的取舍:有后端分桶就用它,否则现算。这条策略抽成纯函数在这里钉死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hourlyIntake, hourlyFromSeries, intakeBuckets } from '../src/lib/stats.ts';
import type { CupEvent } from '@cup/contract';

function drink(amountMl: number, ts: number): CupEvent {
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

/** 造一份 24 桶的 day series,只有第 h 小时有量 */
function daySeries(hourMl: Record<number, number>) {
  return {
    cup_id: 'cup-WEB01',
    range: 'day',
    buckets: Array.from({ length: 24 }, (_, h) => ({
      label: `${String(h).padStart(2, '0')}:00`,
      ts: h * 3_600_000,
      drank_ml: hourMl[h] ?? 0,
      refill_ml: 0,
      temp_avg_c: null as number | null,
      last_volume_ml: null as number | null,
    })),
  };
}

test('hourlyFromSeries:24 桶 day 序列 → 取 drank_ml', () => {
  const out = hourlyFromSeries(daySeries({ 9: 200, 15: 300 }));
  assert.ok(out);
  assert.equal(out.length, 24);
  assert.equal(out[9], 200);
  assert.equal(out[15], 300);
  assert.equal(out[0], 0);
});

test('hourlyFromSeries:range 不是 day / 桶数不是 24 → null(让调用方回退)', () => {
  assert.equal(hourlyFromSeries(null), null);
  assert.equal(hourlyFromSeries({ range: 'week', buckets: Array.from({ length: 7 }, () => ({ drank_ml: 0 })) }), null);
  assert.equal(hourlyFromSeries({ range: 'day', buckets: Array.from({ length: 7 }, () => ({ drank_ml: 0 })) }), null);
});

test('hourlyIntake:只算今天,按小时分桶(离线现算)', () => {
  const now = new Date('2026-10-11T20:00:00').getTime();
  const at = (h: number, ml: number) =>
    drink(ml, new Date('2026-10-11T00:00:00').getTime() + h * 3_600_000);
  const buckets = hourlyIntake([at(9, 200), at(9, 100), at(15, 300)], now);
  assert.equal(buckets[9], 300);
  assert.equal(buckets[15], 300);
  assert.equal(buckets[8], 0);
});

test('intakeBuckets:有后端 day 分桶 → 以后端为准(补上 WS 收不到的早些时候)', () => {
  // 今天 8 点那杯发生在"连上之前",前端事件里没有;后端分桶里有 → 必须用后端的
  const now = new Date('2026-10-11T20:00:00').getTime();
  const liveOnly = [drink(300, new Date('2026-10-11T15:00:00').getTime())];
  const buckets = intakeBuckets(liveOnly, daySeries({ 8: 250, 15: 300 }), now);
  assert.equal(buckets[8], 250, '早于连接时间的喝水量应来自后端分桶');
  assert.equal(buckets[15], 300);
});

test('intakeBuckets:没有后端分桶 → 回退前端现算(与旧行为一致)', () => {
  const now = new Date('2026-10-11T20:00:00').getTime();
  const events = [drink(300, new Date('2026-10-11T15:00:00').getTime())];
  const buckets = intakeBuckets(events, null, now);
  assert.equal(buckets[15], 300);
  assert.equal(buckets[8], 0);
});

test('intakeBuckets:后端给的是 week range(形状不合 day)→ 回退现算,不画错桶', () => {
  const now = new Date('2026-10-11T20:00:00').getTime();
  const events = [drink(300, new Date('2026-10-11T15:00:00').getTime())];
  const wrong = { cup_id: 'c', range: 'week', buckets: Array.from({ length: 7 }, () => ({ drank_ml: 999 })) };
  const buckets = intakeBuckets(events, wrong, now);
  assert.equal(buckets[15], 300, '应回退现算,而不是拿 7 桶冒充 24 桶');
});
