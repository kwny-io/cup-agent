/**
 * 契约 · 手势事件(tap / long_press + duration_ms)—— 2026-10-14 新增。
 *
 * 盖内压力传感器把「轻磕 / 长按 → 确认」上行成事件(创意备忘 §5.1 #1)。
 * 契约是四方共享的冻结协议,这里钉死两条口径,防将来手抖改歪:
 *   · **加法**:EVENT_TYPES 多了 `tap`/`long_press`,`v` 仍为 1(旧设备永不发 → 无回归);
 *   · **耦合**:`duration_ms` 必须且仅在 tap/long_press 时携带(镜像 amount_ml 那条 refine)。
 *
 * 放在 server/test 而非 simulator/test:后者是窗口 B 的 lane,本文件属 A 的契约验收入口。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventSchema, EVENT_TYPES, type EventType } from '@cup/contract';

/** 一只手势事件的最小合规形态 */
function gesture(type: EventType, extra: Record<string, unknown> = {}) {
  return {
    v: 1,
    cup_id: 'cup-ABC123',
    device_id: 'lid-ABC123',
    ts: 1,
    type,
    confidence: 0.9,
    derived_by: 'lid',
    ...extra,
  };
}

test('契约:EVENT_TYPES 含 tap / long_press,且是加法(不删旧值)', () => {
  assert.ok(EVENT_TYPES.includes('tap'), '应含 tap');
  assert.ok(EVENT_TYPES.includes('long_press'), '应含 long_press');
  // 旧七类原样保留(冻结契约只许加法)
  for (const t of ['drink', 'refill', 'shake', 'temp_alert', 'tilt_alert', 'low_battery', 'off_base'] as const) {
    assert.ok(EVENT_TYPES.includes(t), `旧类型 ${t} 不应被删`);
  }
});

test('契约:tap + duration_ms → 合法', () => {
  assert.doesNotThrow(() => EventSchema.parse(gesture('tap', { duration_ms: 120 })));
});

test('契约:long_press + duration_ms → 合法', () => {
  assert.doesNotThrow(() => EventSchema.parse(gesture('long_press', { duration_ms: 900 })));
});

test('契约:tap/long_press 缺 duration_ms → 拒(耦合是双向的)', () => {
  assert.equal(EventSchema.safeParse(gesture('tap')).success, false, 'tap 缺 duration_ms 应被拒');
  assert.equal(EventSchema.safeParse(gesture('long_press')).success, false, 'long_press 缺 duration_ms 应被拒');
});

test('契约:非手势事件带 duration_ms → 拒', () => {
  // drink 已带 amount_ml,再塞 duration_ms 属越界
  const r = EventSchema.safeParse(gesture('shake', { duration_ms: 50 }));
  assert.equal(r.success, false, 'shake 不该携带 duration_ms');
});

test('契约:duration_ms 必须是非负整数(浮点/负数 → 拒)', () => {
  assert.equal(EventSchema.safeParse(gesture('tap', { duration_ms: 12.5 })).success, false);
  assert.equal(EventSchema.safeParse(gesture('tap', { duration_ms: -1 })).success, false);
});

test('契约:手势事件能经信封分发(kind=event)', async () => {
  const { UpstreamFrameSchema } = await import('@cup/contract');
  assert.doesNotThrow(() =>
    UpstreamFrameSchema.parse({ kind: 'event', payload: gesture('tap', { duration_ms: 80 }) }),
  );
});
