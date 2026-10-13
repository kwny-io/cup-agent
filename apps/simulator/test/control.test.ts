/**
 * 手动控制指令测试 —— 对应 09 路线文档"手动触发(WS 控制指令)"缺口的验收。
 *
 * 两层:
 *   parseControl  纯解析 + 边界收口(不可信输入一律挡下)
 *   applyControl  作用到 world/scheduler 后,world 快照确实变了
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Engine,
  parseControl,
  applyControl,
  type EngineContext,
} from '@cup/simulator';

// ── parseControl:合法与非法 ─────────────────────────────────────

test('parseControl:合法指令逐条解析', () => {
  const cases: Array<[unknown, string]> = [
    [{ type: 'drink', ml: 60 }, 'drink'],
    [{ type: 'refill', target_ml: 300, pour_c: 55 }, 'refill'],
    [{ type: 'hot_water', target_ml: 300, pour_c: 85 }, 'hot_water'],
    [{ type: 'shake', duration_ms: 1500 }, 'shake'],
    [{ type: 'press', duration_ms: 150 }, 'press'],
    [{ type: 'tilt', deg: 50, dir: 90 }, 'tilt'],
    [{ type: 'idle' }, 'idle'],
    [{ type: 'lift' }, 'lift'],
    [{ type: 'put_down' }, 'put_down'],
    [{ type: 'set_temp', c: 80 }, 'set_temp'],
    [{ type: 'pause' }, 'pause'],
    [{ type: 'resume' }, 'resume'],
  ];
  for (const [input, type] of cases) {
    const r = parseControl(input);
    assert.ok(r.ok, `${type} 应解析成功`);
    assert.equal(r.cmd.type, type);
  }
});

test('parseControl:数值越界被钳制,不静默丢弃', () => {
  const a = parseControl({ type: 'tilt', deg: 500, dir: 720 });
  assert.ok(a.ok);
  assert.equal(a.cmd.type, 'tilt');
  if (a.cmd.type === 'tilt') {
    assert.equal(a.cmd.deg, 180); // 上限
    assert.equal(a.cmd.dir, 359); // 归一
  }

  const b = parseControl({ type: 'drink', ml: 999_999 });
  assert.ok(b.ok);
  if (b.cmd.type === 'drink') assert.equal(b.cmd.ml, 400); // CUP.capacity_ml

  const c = parseControl({ type: 'set_temp', c: 999 });
  assert.ok(c.ok);
  if (c.cmd.type === 'set_temp') assert.equal(c.cmd.c, 120);

  const d = parseControl({ type: 'shake', duration_ms: 0 });
  assert.ok(d.ok);
  if (d.cmd.type === 'shake') assert.equal(d.cmd.durationMs, 100); // 下限

  // press:时长钳制到 [1, 60000]
  const e = parseControl({ type: 'press', duration_ms: 999_999 });
  assert.ok(e.ok);
  if (e.cmd.type === 'press') assert.equal(e.cmd.durationMs, 60_000);
  const f = parseControl({ type: 'press', duration_ms: -5 });
  assert.ok(f.ok);
  if (f.cmd.type === 'press') assert.equal(f.cmd.durationMs, 1); // 下限
});

test('parseControl:tilt 缺 dir 默认 0', () => {
  const r = parseControl({ type: 'tilt', deg: 30 });
  assert.ok(r.ok);
  if (r.cmd.type === 'tilt') assert.equal(r.cmd.dir, 0);
});

test('parseControl:非法输入一律拒绝(不抛)', () => {
  const bad: unknown[] = [
    null,
    'string',
    42,
    [],
    {}, // 缺 type
    { type: 123 },
    { type: 'unknown_thing' },
    { type: 'drink' }, // 缺 ml
    { type: 'drink', ml: 'sixty' }, // ml 非数字
    { type: 'drink', ml: NaN },
    { type: 'set_temp', c: Infinity },
    { type: 'refill', target_ml: 300 }, // 缺 pour_c
  ];
  for (const input of bad) {
    const r = parseControl(input);
    assert.equal(r.ok, false, `${JSON.stringify(input)} 应被拒绝`);
    if (!r.ok) assert.ok(typeof r.error === 'string' && r.error.length > 0);
  }
});

// ── applyControl:作用到 world ───────────────────────────────────

/** 造一个独立的 engine,取它的 ctx 供 applyControl 用。 */
function makeCtx(): { engine: Engine; ctx: EngineContext } {
  const engine = new Engine({
    config: { startMs: Date.UTC(2026, 9, 11, 9, 0, 0), scale: 1, verbose: false },
    steps: [],
    sink: () => {},
  });
  const ctx: EngineContext = {
    world: engine.world,
    scheduler: engine.scheduler,
    clock: engine.clock,
    log: () => {},
    config: engine.config,
  };
  return { engine, ctx };
}

function snap(ctx: EngineContext) {
  return ctx.world.snapshot(ctx.clock.nowMs);
}

test('applyControl:drink 减少水量并短暂离座,3s 后自动放回', () => {
  const { ctx } = makeCtx();
  const before = snap(ctx).volumeMl;
  applyControl(ctx, { type: 'drink', ml: 60 });
  const after = snap(ctx);
  assert.equal(after.volumeMl, before - 60);
  assert.equal(after.onBase, false);
  assert.equal(after.motion, 'lifted');

  // 推进虚拟时间越过 3s → 调度器里的"放回底座"生效
  ctx.clock.advance(3500);
  ctx.scheduler.runDue(ctx.clock.nowMs);
  assert.equal(snap(ctx).onBase, true);
  assert.equal(snap(ctx).motion, 'idle');
});

test('applyControl:shake 期间 motion=shake,持续后停', () => {
  const { ctx } = makeCtx();
  applyControl(ctx, { type: 'shake', durationMs: 1500 });
  assert.equal(snap(ctx).motion, 'shake');

  ctx.clock.advance(1600);
  ctx.scheduler.runDue(ctx.clock.nowMs);
  assert.equal(snap(ctx).motion, 'idle'); // 已停止摇晃
});

test('applyControl:hot_water 整杯温度被设为目标', () => {
  const { ctx } = makeCtx();
  applyControl(ctx, { type: 'hot_water', targetMl: 300, pourC: 85 });
  const s = snap(ctx);
  assert.equal(s.tempC, 85);
  assert.equal(s.volumeMl, 300);
});

test('applyControl:press 按住盖顶,到时长后松开', () => {
  const { ctx } = makeCtx();
  const detail = applyControl(ctx, { type: 'press', durationMs: 150 });
  assert.equal(snap(ctx).pressG, 200); // 接触中
  assert.match(detail.detail, /tap/); // 150ms 归类为 tap

  // 到时长 → 松开(压力归 0);分类与事件由 LidSensor 在松手时给出
  ctx.clock.advance(160);
  ctx.scheduler.runDue(ctx.clock.nowMs);
  assert.equal(snap(ctx).pressG, 0);
});


test('applyControl:tilt / idle / lift / put_down 是持续姿态', () => {
  const { ctx } = makeCtx();
  applyControl(ctx, { type: 'tilt', deg: 50, dir: 90 });
  assert.equal(snap(ctx).motion, 'tilt');
  assert.equal(snap(ctx).tiltDeg, 50);

  applyControl(ctx, { type: 'idle' });
  assert.equal(snap(ctx).motion, 'idle');

  applyControl(ctx, { type: 'lift' });
  assert.equal(snap(ctx).motion, 'lifted');
  assert.equal(snap(ctx).onBase, false);

  applyControl(ctx, { type: 'put_down' });
  assert.equal(snap(ctx).onBase, true);
  assert.equal(snap(ctx).motion, 'idle');
});

test('applyControl:pause / resume 回传 loop 信号供主循环消费', () => {
  const { ctx } = makeCtx();
  const p = applyControl(ctx, { type: 'pause' });
  assert.equal(p.loop, 'pause');
  const r = applyControl(ctx, { type: 'resume' });
  assert.equal(r.loop, 'resume');
});

test('engine 暂停后 runRealtime 不推进虚拟时间', async () => {
  const engine = new Engine({
    config: { startMs: Date.UTC(2026, 9, 11, 9, 0, 0), scale: 1, reportMs: 1000, verbose: false },
    steps: [{ atMs: 1_000_000, label: 'far', action: () => {} }],
    sink: () => {},
  });
  engine.setPaused(true);
  const p = engine.runRealtime(20);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(engine.clock.virtualElapsedMs, 0); // 暂停期间虚拟时间不动

  engine.setPaused(false);
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(engine.clock.virtualElapsedMs > 0, '恢复后应推进');

  engine.stopRealtime?.(); // 收尾:不等脚本跑完
  await p;
});
