/**
 * 契约测试 —— 保证模拟器产出严格符合《contract.md》。
 * 对应 plan.md M0 验收标准 3。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BaseTelemetrySchema,
  LidTelemetrySchema,
  EventSchema,
  UpstreamFrameSchema,
  CUP,
  levelPctFromWeight,
  levelMmFromWeight,
  volumeMl,
  mlToLevelMm,
  mlToLevelPct,
} from '@cup/contract';

const lidBase = {
  v: 1 as const,
  device_id: 'lid-ABC123',
  cup_id: 'cup-ABC123',
  ts: 1_759_756_800_000,
  seq: 0,
  sample_ms: 300_000,
  temp_c: 42.5,
  level_mm: 85,
  level_pct: 62,
  motion: 'idle' as const,
  tilt_deg: 3.2,
  tilt_dir: 187,
  battery_pct: 78,
  charging: false,
};

test('杯盖遥测:合法样本通过', () => {
  assert.doesNotThrow(() => LidTelemetrySchema.parse(lidBase));
});

test('杯盖遥测:坏 device_id 被拒', () => {
  const r = LidTelemetrySchema.safeParse({ ...lidBase, device_id: 'lid-abc' }); // 小写
  assert.equal(r.success, false);
});

test('杯盖遥测:温度越界被拒', () => {
  const r = LidTelemetrySchema.safeParse({ ...lidBase, temp_c: 999 });
  assert.equal(r.success, false);
});

test('杯盖遥测:motion 非法枚举被拒', () => {
  const r = LidTelemetrySchema.safeParse({ ...lidBase, motion: 'flying' });
  assert.equal(r.success, false);
});

test('底座遥测:合法样本通过', () => {
  assert.doesNotThrow(() =>
    BaseTelemetrySchema.parse({
      v: 1,
      device_id: 'base-ABC123',
      cup_id: 'cup-ABC123',
      ts: 1_759_756_800_000,
      seq: 1,
      weight_g: 512.3,
      stable: true,
      present: true,
      temp_c: 26,
      charging: true,
      battery_pct: 91,
    }),
  );
});

test('事件:drink 必须携带 amount_ml', () => {
  const withoutAmount = EventSchema.safeParse({
    v: 1,
    cup_id: 'cup-ABC123',
    device_id: 'base-ABC123',
    ts: 1,
    type: 'drink',
    confidence: 0.9,
    derived_by: 'base',
  });
  assert.equal(withoutAmount.success, false, 'drink 缺 amount_ml 应被拒');

  assert.doesNotThrow(() =>
    EventSchema.parse({
      v: 1,
      cup_id: 'cup-ABC123',
      device_id: 'base-ABC123',
      ts: 1,
      type: 'drink',
      amount_ml: 180,
      confidence: 0.9,
      derived_by: 'base',
    }),
  );
});

test('事件:非 drink/refill 不应携带 amount_ml', () => {
  const r = EventSchema.safeParse({
    v: 1,
    cup_id: 'cup-ABC123',
    device_id: 'lid-ABC123',
    ts: 1,
    type: 'shake',
    amount_ml: 50,
    confidence: 0.9,
    derived_by: 'lid',
  });
  assert.equal(r.success, false);
});

test('信封:三种 kind 都能正确分发', () => {
  assert.doesNotThrow(() => UpstreamFrameSchema.parse({ kind: 'lid', payload: lidBase }));
  assert.doesNotThrow(() =>
    UpstreamFrameSchema.parse({
      kind: 'event',
      payload: {
        v: 1,
        cup_id: 'cup-ABC123',
        device_id: 'lid-ABC123',
        ts: 1,
        type: 'shake',
        confidence: 0.9,
        derived_by: 'lid',
      },
    }),
  );
});

test('换算:满杯时 weight 对应 capacity', () => {
  const fullWeight = CUP.tare_g + CUP.capacity_ml; // 285 + 400 = 685
  assert.equal(levelPctFromWeight(fullWeight), 100);
  assert.ok(Math.abs(levelMmFromWeight(fullWeight) - CUP.inner_mm) < 0.001);
});

test('换算:空杯时体积为 0', () => {
  assert.equal(volumeMl(CUP.tare_g), 0);
  assert.equal(levelPctFromWeight(CUP.tare_g), 0);
});

test('换算:低于皮重不出现负数', () => {
  assert.equal(volumeMl(CUP.tare_g - 50), 0);
});

test('换算:ml → 液位往返一致', () => {
  const ml = 200;
  const mm = mlToLevelMm(ml);
  // 由 mm 反推体积,应回到原值(容差因 ml_per_mm 取整)
  const back = mm * CUP.ml_per_mm;
  assert.ok(Math.abs(back - ml) < 0.01);
  assert.equal(mlToLevelPct(CUP.capacity_ml), 100);
});
