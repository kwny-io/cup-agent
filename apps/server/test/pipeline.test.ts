/**
 * 管线 / 融合 / Store 单元测试 —— 对应 plan.md M1 验收标准 1、4 的核心逻辑。
 *
 * 这些测试不碰网络:直接往 Pipeline 喂契约帧,断言 Store 算出来的数字。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type BaseTelemetry,
  type CupEvent,
  type LidTelemetry,
} from '@cup/contract';
import { MemoryStore, Pipeline, CupFusion, Deduper, dayKey } from '@cup/server';

const CUP_ID = 'cup-A1B2C3';

// ── 造帧助手(字段严格符合契约,避免测试自己造脏数据)─────────────

function lid(over: Partial<LidTelemetry> = {}): LidTelemetry {
  return {
    v: 1,
    device_id: 'lid-A1B2C3',
    cup_id: CUP_ID,
    ts: Date.now(),
    seq: 0,
    sample_ms: 300_000,
    temp_c: 45,
    level_mm: 65,
    level_pct: 50,
    motion: 'idle',
    tilt_deg: 0,
    tilt_dir: 0,
    battery_pct: 80,
    charging: false,
    ...over,
  };
}

function base(over: Partial<BaseTelemetry> = {}): BaseTelemetry {
  return {
    v: 1,
    device_id: 'base-A1B2C3',
    cup_id: CUP_ID,
    ts: Date.now(),
    seq: 0,
    weight_g: 485, // 皮重 285 + 水 200
    stable: true,
    present: true,
    temp_c: 30,
    charging: false,
    battery_pct: 90,
    ...over,
  };
}

function drink(amount_ml: number, ts = Date.now()): CupEvent {
  return {
    v: 1,
    cup_id: CUP_ID,
    device_id: 'base-A1B2C3',
    ts,
    type: 'drink',
    amount_ml,
    confidence: 0.95,
    derived_by: 'base',
  };
}

// ── 去重 ─────────────────────────────────────────────────────────

test('去重:同一 (device_id, seq) 只接受一次,但其后 seq 不受影响', () => {
  const d = new Deduper();
  assert.equal(d.accept({ device_id: 'lid-X', seq: 5 }), true);
  assert.equal(d.accept({ device_id: 'lid-X', seq: 5 }), false, '重传被丢弃');
  assert.equal(d.accept({ device_id: 'lid-X', seq: 6 }), true, '新 seq 照常通过');
  assert.equal(d.accept({ device_id: 'base-Y', seq: 5 }), true, '另一设备 seq 独立');
});

test('去重:迟到重投的旧 seq 也能被识破(非高水位)', () => {
  const d = new Deduper();
  d.accept({ device_id: 'lid-X', seq: 10 });
  d.accept({ device_id: 'lid-X', seq: 11 });
  assert.equal(d.accept({ device_id: 'lid-X', seq: 10 }), false, '旧的 10 回来了应识破');
});

// ── 融合(D2 核心)───────────────────────────────────────────────

test('融合:底座在座 → derived_by=base,conf 高,数字来自 weight_g', () => {
  const f = new CupFusion(CUP_ID);
  const s = f.onBase(base({ weight_g: 485, stable: true }));
  assert.equal(s.derived_by, 'base');
  assert.equal(s.present, true);
  assert.equal(s.volume_ml, 200, '485g − 285g 皮重 = 200ml');
  assert.ok(s.confidence >= 0.95, '已沉降的底座置信度高');
});

test('融合:底座失明(present=false)→ 退到杯盖 lid,conf 低', () => {
  const f = new CupFusion(CUP_ID);
  // 先建立一次底座锚(在座)
  f.onBase(base({ weight_g: 485 }));
  // 杯子被拿起:底座上报 present=false(这是真机上真实发生的信号)
  f.onBase(base({ weight_g: 0, present: false, stable: false, seq: 1 }));
  const s = f.onLid(lid({ level_pct: 50, motion: 'idle' }));
  assert.equal(s.derived_by, 'lid');
  assert.equal(s.present, false, '底座看不到杯子');
  assert.ok(s.confidence <= 0.6, '杯盖置信度低');
  // level_pct=50 → 200ml(容量 400),与底座一致 → 偏置≈0
  assert.ok(Math.abs(s.volume_ml - 200) < 5, `杯盖估算应接近 200,实得 ${s.volume_ml}`);
});

test('融合:杯盖系统偏差被底座回锚(偏置追踪真正生效)', () => {
  const f = new CupFusion(CUP_ID);
  // 杯盖一直高估:液位读 75% (300ml),但底座真值只有 200ml
  const noisyLid = () => lid({ level_pct: 75, motion: 'idle' });
  // 反复"在座观测"若干次,让偏置 EMA 收敛到 +100ml
  for (let i = 0; i < 20; i++) {
    f.onLid(lid({ level_pct: 75, motion: 'idle', seq: i }));
    f.onBase(base({ weight_g: 485, seq: i })); // 在座且稳定,真值 200ml
  }
  // 杯子被拿起:底座失明,此后只能靠杯盖
  f.onBase(base({ weight_g: 0, present: false, stable: false, seq: 99 }));
  const solo = f.onLid(noisyLid()); // 杯盖单独顶
  assert.equal(solo.derived_by, 'lid');
  // 减掉偏置后应回到 ~200ml,而不是杯盖原始高估的 300ml
  assert.ok(
    Math.abs(solo.volume_ml - 200) < 15,
    `回锚后应接近 200ml,实得 ${solo.volume_ml}`,
  );
});

test('融合:摇晃时杯盖置信度进一步降低', () => {
  const f = new CupFusion(CUP_ID);
  const calm = f.onLid(lid({ motion: 'idle' }));
  const shake = f.onLid(lid({ motion: 'shake' }));
  assert.ok(shake.confidence < calm.confidence, '摇晃时更不可信');
  assert.equal(shake.derived_by, 'lid');
});

// ── 日聚合 ───────────────────────────────────────────────────────

test('日聚合:drink 累加 drank_ml,refill 进 refill_ml', async () => {
  const store = new MemoryStore();
  const p = new Pipeline(store);
  const now = Date.now();
  await p.ingest({ kind: 'event', payload: drink(120, now) });
  await p.ingest({ kind: 'event', payload: drink(100, now + 1000) });
  await p.ingest({
    kind: 'event',
    payload: { ...drink(300, now + 2000), type: 'refill' },
  });

  const agg = await store.agg(CUP_ID, dayKey(now));
  assert.ok(agg);
  assert.equal(agg.drank_ml, 220, '两次喝水 120+100');
  assert.equal(agg.drink_count, 2);
  assert.equal(agg.refill_ml, 300);
});

test('日聚合:同一事件重投不重复计数(事件级去重)', async () => {
  const store = new MemoryStore();
  const p = new Pipeline(store);
  const e = drink(150);
  await p.ingest({ kind: 'event', payload: e });
  await p.ingest({ kind: 'event', payload: e }); // 重投
  const agg = await store.agg(CUP_ID, dayKey(e.ts));
  assert.equal(agg?.drank_ml, 150, '重投不应翻倍');
  assert.equal(agg?.drink_count, 1);
});

test('日聚合:水温区间来自融合样本的 temp', async () => {
  const store = new MemoryStore();
  const p = new Pipeline(store);
  const now = Date.now();
  await p.ingest({ kind: 'lid', payload: lid({ ts: now, temp_c: 60 }) });
  await p.ingest({ kind: 'base', payload: base({ ts: now, present: true, stable: true }) });
  await p.ingest({ kind: 'lid', payload: lid({ ts: now + 10, seq: 1, temp_c: 40 }) });
  const agg = await store.agg(CUP_ID, dayKey(now));
  assert.equal(agg?.temp_min_c, 40);
  assert.equal(agg?.temp_max_c, 60);
});

// ── 管线接线 ─────────────────────────────────────────────────────

test('管线:遥测进去,融合样本从 sample 回调出来', async () => {
  const store = new MemoryStore();
  const samples: number[] = [];
  const p = new Pipeline(store, { sample: (s) => samples.push(s.volume_ml) });
  await p.ingest({ kind: 'base', payload: base({ weight_g: 485 }) });
  assert.equal(samples.length, 1);
  assert.equal(samples[0], 200);
  assert.equal((await store.latestSample(CUP_ID))?.volume_ml, 200, 'Store 也记住最新样本');
});
