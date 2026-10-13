/**
 * M1 验收测试 —— 逐条对应 plan.md M1 验收标准:
 *   1. 模拟器跑一天数据 → 后端算出"今日已喝 / 次数 / 水温区间"
 *   2. 前端拉 /today、/series 能拿到合理数据
 *   3. WS 在模拟器发数据时能实时收到
 *   4. 后端拒收不符合契约的报文,并记日志
 *
 * 这里**用真的模拟器产出帧**(Engine + typicalDay),经真的契约信封喂进后端,
 * 而不是手搓假数据 —— 这样验的是"后端接得住模拟器",而非"后端接得住我的假想"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import { Engine, typicalDay, toFrames, type Frame } from '@cup/simulator';
import type { UpstreamFrame } from '@cup/contract';
import { createApp, MemoryStore, Pipeline, dayKey, dayStart } from '@cup/server';

const CUP_ID = 'cup-A1B2C3';

/** 跑一天模拟,收集全部契约信封(与模拟器 exit 送给 WS 的东西一模一样) */
function simulateDay(): { frames: UpstreamFrame[]; startMs: number; events: number } {
  const startMs = dayStart(dayKey(Date.now())); // 本地今天 00:00 → 事件落在"今天"
  const collected: UpstreamFrame[] = [];
  let events = 0;
  const engine = new Engine({
    config: {
      seed: 42,
      scale: 600,
      startMs,
      reportMs: 60_000,
      verbose: false,
    },
    steps: typicalDay(),
    sink: (f: Frame) => {
      events += f.events.length;
      for (const ef of toFrames(f)) collected.push(ef);
    },
  });
  engine.runToEnd(60_000);
  return { frames: collected, startMs, events };
}

// ── 验收 1:跑一天 → 数字对得上 ───────────────────────────────────

test('验收1:模拟器一天数据 → 今日已喝/次数/水温区间算得出', async () => {
  const store = new MemoryStore();
  const p = new Pipeline(store);
  const { frames, startMs } = simulateDay();
  for (const f of frames) await p.ingest(f);

  const date = dayKey(startMs);
  const agg = await store.agg(CUP_ID, date);
  assert.ok(agg, '应有今天的聚合');

  // 脚本 7 次喝水共 730ml;底座称重带噪声,给 ±20ml 容差
  assert.equal(agg.drink_count, 7, `drink 次数应为 7,实得 ${agg.drink_count}`);
  assert.ok(
    agg.drank_ml >= 700 && agg.drank_ml <= 760,
    `今日已喝应在 700–760ml,实得 ${agg.drank_ml}`,
  );
  // 水温区间:早上倒 60°C、中午 72°C 热水 → 区间非空且上界够高
  assert.ok(agg.temp_min_c !== null && agg.temp_max_c !== null, '应有水温区间');
  assert.ok(agg.temp_max_c! >= 60, `水温上界应 ≥60,实得 ${agg.temp_max_c}`);
  assert.ok(agg.temp_min_c! <= agg.temp_max_c!, '区间下界不超过上界');
  // 有 refill
  assert.ok(agg.refill_ml > 0, '应有续杯量');
});

test('验收1(续):时间加速不影响数字 —— 同 seed 两次跑结果一致', async () => {
  const run = async (scale: number) => {
    const store = new MemoryStore();
    const p = new Pipeline(store);
    const pending: Promise<boolean>[] = [];
    const startMs = dayStart(dayKey(Date.now()));
    const engine = new Engine({
      config: { seed: 42, scale, startMs, reportMs: 60_000, verbose: false },
      steps: typicalDay(),
      sink: (f) => {
        for (const ef of toFrames(f)) pending.push(p.ingest(ef));
      },
    });
    engine.runToEnd(60_000);
    await Promise.all(pending);
    return await store.agg(CUP_ID, dayKey(startMs));
  };
  const a = await run(600);
  const b = await run(6000);
  assert.equal(a?.drank_ml, b?.drank_ml, '加速倍率不应改变喝水量');
  assert.equal(a?.drink_count, b?.drink_count);
});

// ── 验收 2:REST 能拉到合理数据 ──────────────────────────────────

test('验收2:GET /today 与 /series 返回合理数据', async () => {
  const app = createApp({ log: () => {}, allowUnauth: true });
  const { frames, startMs } = simulateDay();
  for (const f of frames) await app.pipeline.ingest(f);
  const port = await app.listen(0);

  try {
    const today = await getJson(`http://127.0.0.1:${port}/cups/${CUP_ID}/today`);
    assert.equal(today.cup_id, CUP_ID);
    assert.equal(today.drink_count, 7);
    assert.ok(today.drank_ml >= 700 && today.drank_ml <= 760);
    assert.equal(today.goal_ml, 1500, '默认目标 1500');
    assert.ok(typeof today.progress === 'number' && today.progress > 0);
    assert.ok(Array.isArray(today.recent_events) && today.recent_events.length > 0);
    assert.ok(today.current_volume_ml !== null, '应有当前水量');

    // 分时曲线:24 桶,且喝水量总和与 today 一致
    const series = await getJson(`http://127.0.0.1:${port}/cups/${CUP_ID}/series?range=day`);
    assert.equal(series.buckets.length, 24);
    const sum = series.buckets.reduce((s: number, b: { drank_ml: number }) => s + b.drank_ml, 0);
    assert.equal(sum, today.drank_ml, '分时桶之和应等于今日总量');

    // 分周曲线:7 桶
    const week = await getJson(`http://127.0.0.1:${port}/cups/${CUP_ID}/series?range=week`);
    assert.equal(week.buckets.length, 7);

    // 事件列表
    // 显式给整天范围:`/events` 默认 `to = now`,而本测试把整天脚本(事件落在 07:00–21:00)
    // 塞在"今天 00:00"起点 —— 若此刻早于末条事件(如凌晨跑测试),默认范围会把它们全滤掉。
    // 这是**测试假设**的问题,不是产品:不给范围的 `/events` 语义就是"截至现在",本就该滤未来。
    const evs = await getJson(
      `http://127.0.0.1:${port}/cups/${CUP_ID}/events?from=${startMs}&to=${startMs + 86_400_000}`,
    );
    assert.ok(evs.count > 0);
  } finally {
    await app.close();
  }
});

test('验收2(续):PUT /goal 改目标,再拉 /today 生效', async () => {
  // R10-B:写端点默认强制鉴权;本用例验的是目标读写语义,显式豁免鉴权。
  const app = createApp({ log: () => {}, allowUnauth: true });
  const port = await app.listen(0);
  try {
    const put = await fetch(`http://127.0.0.1:${port}/cups/${CUP_ID}/goal`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal_ml: 2000 }),
    });
    assert.equal(put.status, 200);
    const today = await getJson(`http://127.0.0.1:${port}/cups/${CUP_ID}/today`);
    assert.equal(today.goal_ml, 2000);
  } finally {
    await app.close();
  }
});

// ── 验收 3:WS 实时推送 ──────────────────────────────────────────

test('验收3:WS /live 在数据进来时实时收到', async () => {
  const app = createApp({ log: () => {} });
  const port = await app.listen(0);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/cups/${CUP_ID}/live`);

  const received: Record<string, unknown>[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS 握手超时')), 3000);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      received.push(msg);
      if (msg.kind === 'hello') {
        clearTimeout(timer);
        // 握手后喂一帧底座遥测 → 应收到 sample 推送
        app.pipeline.ingest({
          kind: 'base',
          payload: {
            v: 1,
            device_id: 'base-A1B2C3',
            cup_id: CUP_ID,
            ts: Date.now(),
            seq: 0,
            weight_g: 485,
            stable: true,
            present: true,
            temp_c: 30,
            charging: false,
            battery_pct: 90,
          },
        });
      }
      if (msg.kind === 'sample') resolve();
    });
    ws.on('error', reject);
  });

  assert.equal(received[0]?.kind, 'hello', '首帧应是 hello 握手');
  const sample = received.find((m) => m.kind === 'sample') as
    | { payload: { volume_ml: number; derived_by: string } }
    | undefined;
  assert.ok(sample, '应收到 sample 推送');
  assert.equal(sample!.payload.volume_ml, 200, '485g → 200ml');
  assert.equal(sample!.payload.derived_by, 'base');
  ws.close();
  await app.close();
});

// ── 验收 4:拒收不合契约的报文并记日志 ───────────────────────────

test('验收4:sim-adapter 拒收不合契约报文,合法报文照常进库', async () => {
  // 起一个裸 WS 服务当"模拟器",好控制它吐什么
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.on('listening', () => r()));
  const addr = wss.address();
  const simPort = typeof addr === 'object' && addr ? addr.port : 0;

  const logs: string[] = [];
  const app = createApp({
    simUrl: `ws://127.0.0.1:${simPort}`,
    log: (m) => logs.push(m),
  });
  const port = await app.listen(0);

  // ⚠️ 必须在适配器有机会连上之前挂好监听,否则会漏掉 connection → 永久等待。
  // createApp 里的 startSimAdapter 是同步发起连接的,所以监听要在 createApp 之前就位。
  const accepted = new Promise<void>((r) => wss.once('connection', () => r()));

  try {
    await accepted;
    // 给适配器一点时间 attach message 监听
    await delay(50);

    const good = JSON.stringify({
      kind: 'base',
      payload: {
        v: 1,
        device_id: 'base-A1B2C3',
        cup_id: CUP_ID,
        ts: Date.now(),
        seq: 0,
        weight_g: 485,
        stable: true,
        present: true,
        temp_c: 30,
        charging: false,
        battery_pct: 90,
      },
    });
    // 三条坏报文:字段越界、缺字段、纯垃圾
    const badRange = JSON.stringify({
      kind: 'lid',
      payload: {
        ...JSON.parse(good).payload,
        device_id: 'lid-A1B2C3',
        temp_c: 999, // 超契约上界 120
        level_pct: 50,
        level_mm: 65,
        sample_ms: 300000,
        motion: 'idle',
        tilt_deg: 0,
        tilt_dir: 0,
        battery_pct: 80,
      },
    });
    const badShape = JSON.stringify({ kind: 'base', payload: { v: 1 } });
    const garbage = 'not json at all {{{';

    for (const line of [good, badRange, badShape, garbage]) {
      for (const client of wss.clients) client.send(line + '\n');
      await delay(20);
    }
    await delay(120);

    assert.ok(app.adapter, '应挂上 sim-adapter');
    assert.equal(app.adapter!.accepted(), 1, `只应有 1 条被接受,实得 ${app.adapter!.accepted()}`);
    assert.equal(app.adapter!.rejected(), 3, `应拒收 3 条,实得 ${app.adapter!.rejected()}`);
    assert.equal(app.pipeline.stats().rejected, 3);
    assert.ok(
      logs.some((l) => l.includes('拒收')),
      '应有拒收日志',
    );
    // 合法那条真的进库了
    assert.equal((await app.store.latestSample(CUP_ID))?.volume_ml, 200);
    void port;
  } finally {
    await app.close();
    wss.close();
  }
});

// ── 验收(M4):战报 API 的数字与 /today 一致 ──────────────────────

test('验收(M4):GET /report/latest 数字与 /today 一致,且带性格', async () => {
  const app = createApp({ log: () => {}, allowUnauth: true });
  const { frames } = simulateDay();
  for (const f of frames) await app.pipeline.ingest(f);
  const port = await app.listen(0);
  try {
    const base = `http://127.0.0.1:${port}/cups/${CUP_ID}`;
    const today = await getJson(`${base}/today`);
    const report = await getJson(`${base}/report/latest`);

    // 数字必须和看板一致(验收 2:不能瞎编)
    assert.equal(report.facts.drank_ml, today.drank_ml, '战报已喝量应与 /today 一致');
    assert.equal(report.facts.goal_ml, today.goal_ml);
    assert.equal(report.facts.drink_count, today.drink_count);
    assert.equal(report.facts.streak, today.streak);

    // 有文案、有性格、有来源标记
    assert.ok(typeof report.headline === 'string' && report.headline.length > 0);
    assert.ok(['sulky', 'normal', 'smug'].includes(report.disposition));
    assert.equal(report.source, 'template', '未配 LLM 时应走模板');
  } finally {
    await app.close();
  }
});

test('验收(M4):今天没有数据时战报返回 404(不编空战报)', async () => {
  const app = createApp({ log: () => {}, allowUnauth: true });
  const port = await app.listen(0);
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/cups/cup-EMPTY01/report/latest`,
    );
    assert.equal(res.status, 404);
  } finally {
    await app.close();
  }
});

// ── 工具 ─────────────────────────────────────────────────────────

interface AnyObj {
  [k: string]: any;
}

async function getJson(url: string): Promise<AnyObj> {
  const res = await fetch(url);
  assert.equal(res.status, 200, `${url} 应返回 200`);
  return (await res.json()) as AnyObj;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
