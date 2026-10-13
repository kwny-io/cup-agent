/**
 * S9 HTTP ingest 中转适配器 —— 三层验证:
 *   1. 纯函数 ingestEnvelope:信封归一 / 契约校验 / cup_id 路由隔离 / 批上限;
 *   2. 真 HTTP POST /cups/:id/ingest:端到端,且写鉴权(默认强制)对它生效;
 *   3. 与另两个适配器同构:进来的帧确实落进**同一条**管线(能在 /today 读到)。
 *
 * 关键立场:脏数据绝不许进 Store(契约 §2 先挡),这与 sim/mqtt 适配器一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, Pipeline, MemoryStore } from '@cup/server';
import { ingestEnvelope, normalizeEnvelope, MAX_INGEST_BATCH } from '../src/ingest/http-adapter.ts';

const CUP = 'cup-A1B2C3';
const LID = 'lid-A1B2C3';
const KEY = 'sekret-key-123';

/** 一帧合规的杯盖遥测(照 mqtt-broker.test.ts 的形状) */
function lidFrame(cupId = CUP, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'lid',
    payload: {
      v: 1,
      device_id: LID,
      cup_id: cupId,
      ts: Date.now(),
      seq: 0,
      sample_ms: 300_000,
      temp_c: 55,
      level_mm: 65,
      level_pct: 50,
      motion: 'idle',
      tilt_deg: 0,
      tilt_dir: 0,
      battery_pct: 80,
      charging: false,
      ...extra,
    },
  };
}

function freshPipe(): { pipe: Pipeline; store: MemoryStore } {
  const store = new MemoryStore();
  return { pipe: new Pipeline(store), store };
}

// ── 1. 信封归一(normalizeEnvelope)──────────────────────────────

test('normalizeEnvelope:收 frame / frames / 裸数组 / 裸对象,其余归空', () => {
  const f = { kind: 'lid' };
  assert.deepEqual(normalizeEnvelope({ frame: f }), [f]);
  assert.deepEqual(normalizeEnvelope({ frames: [f, f] }), [f, f]);
  assert.deepEqual(normalizeEnvelope([f]), [f]);
  assert.deepEqual(normalizeEnvelope(f), [f], '裸对象有 kind → 当单帧');
  // 非帧:数字/字符串/null/无 kind 的对象 → 空批
  assert.deepEqual(normalizeEnvelope(42), []);
  assert.deepEqual(normalizeEnvelope('x'), []);
  assert.deepEqual(normalizeEnvelope(null), []);
  assert.deepEqual(normalizeEnvelope({}), []);
  assert.deepEqual(normalizeEnvelope({ foo: 1 }), [], '无 kind 的对象不臆造成帧');
});

// ── 2. 纯函数 ingestEnvelope ─────────────────────────────────────

test('ingestEnvelope:合规帧入管线并被接受', async () => {
  const { pipe, store } = freshPipe();
  const r = await ingestEnvelope({ frames: [lidFrame()] }, pipe);
  assert.deepEqual(
    { a: r.accepted, d: r.deduped, x: r.rejected },
    { a: 1, d: 0, x: 0 },
  );
  assert.ok(await store.latestSample(CUP), '帧应真落进 Store');
});

test('ingestEnvelope:脏帧被契约挡下,不进 Store', async () => {
  const { pipe, store } = freshPipe();
  // temp_c 超上界(契约 max 120)+ 缺 kind
  const bad = { kind: 'lid', payload: { ...(lidFrame().payload as object), temp_c: 999 } };
  const r = await ingestEnvelope({ frames: [bad] }, pipe);
  assert.equal(r.rejected, 1);
  assert.equal(r.accepted, 0);
  assert.equal(await store.latestSample(CUP), null, '脏帧绝不能进 Store');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!, /\[0\]/);
});

test('ingestEnvelope:混批 —— 合规的收、脏的丢,计数分开', async () => {
  const { pipe } = freshPipe();
  const r = await ingestEnvelope({ frames: [lidFrame(), { garbage: true }, lidFrame(CUP, { seq: 1 })] }, pipe);
  assert.equal(r.accepted, 2);
  assert.equal(r.rejected, 1);
  assert.equal(r.errors.length, 1, '只报脏的那条');
});

test('ingestEnvelope:cup_id 路由隔离 —— 别的杯子的帧被拒', async () => {
  const { pipe, store } = freshPipe();
  const r = await ingestEnvelope({ frames: [lidFrame('cup-OTHER')] }, pipe, CUP);
  assert.equal(r.rejected, 1);
  assert.equal(r.accepted, 0);
  assert.equal(await store.latestSample('cup-OTHER'), null, '不该越界写入别的杯子');
  assert.match(r.errors[0]!, /cup_id 不符/);
});

test('ingestEnvelope:不给 expectedCupId 时不校验 cup_id', async () => {
  const { pipe } = freshPipe();
  const r = await ingestEnvelope({ frames: [lidFrame('cup-ANY')] }, pipe);
  assert.equal(r.accepted, 1);
});

test('ingestEnvelope:重复 seq 计入 deduped,不计 accepted', async () => {
  const { pipe } = freshPipe();
  // 同一帧发两遍(seq 相同 → Deduper 丢第二遍)
  const f = lidFrame();
  const r = await ingestEnvelope({ frames: [f, f] }, pipe);
  assert.equal(r.accepted, 1);
  assert.equal(r.deduped, 1);
  assert.equal(r.rejected, 0);
});

test('ingestEnvelope:超批上限 → 整批拒绝,不进管线', async () => {
  const { pipe, store } = freshPipe();
  const big = Array.from({ length: MAX_INGEST_BATCH + 1 }, () => lidFrame());
  const r = await ingestEnvelope({ frames: big }, pipe);
  assert.equal(r.accepted, 0);
  assert.equal(r.rejected, big.length);
  assert.equal(await store.latestSample(CUP), null);
  assert.match(r.errors[0]!, /批过大/);
});

test('ingestEnvelope:空批 / 空对象 → 零计数,不报错', async () => {
  const { pipe } = freshPipe();
  for (const body of [{}, [], { frames: [] }, null, 7]) {
    const r = await ingestEnvelope(body, pipe);
    assert.deepEqual(
      { a: r.accepted, d: r.deduped, x: r.rejected },
      { a: 0, d: 0, x: 0 },
      `body=${JSON.stringify(body)} 应零计数`,
    );
  }
});

// ── 3. 真 HTTP 端到端(含写鉴权)────────────────────────────────

async function startApp(opts: { apiKey?: string; allowUnauth?: boolean } = {}) {
  const app = createApp({ log: () => {}, apiKey: opts.apiKey ?? KEY, ...opts });
  const port = await app.listen(0);
  return { app, base: `http://127.0.0.1:${port}` };
}

function postIngest(base: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/cups/${CUP}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('HTTP:POST /ingest 缺 key → 401(写端点默认强制)', async () => {
  const { app, base } = await startApp();
  try {
    const r = await postIngest(base, { frames: [lidFrame()] });
    assert.equal(r.status, 401);
    assert.equal(await app.store.latestSample(CUP), null, '401 后不该落任何数据');
  } finally {
    await app.close();
  }
});

test('HTTP:对 key → 200 带计数,且数据能在 /today 读到(同一条管线)', async () => {
  const { app, base } = await startApp({ allowUnauth: true });
  try {
    const h = { 'x-api-key': KEY };
    const r = await postIngest(base, { frames: [lidFrame()] }, h);
    assert.equal(r.status, 200);
    const j = (await r.json()) as { accepted: number; rejected: number };
    assert.equal(j.accepted, 1);
    assert.equal(j.rejected, 0);

    // 走另一条路径读回:证明它落进的是同一个 Store/管线
    const today = await fetch(`${base}/cups/${CUP}/today`);
    assert.equal(today.status, 200);
    const t = (await today.json()) as { current_temp_c: number | null };
    assert.equal(t.current_temp_c, 55, '中转进来的温度应出现在 /today');
  } finally {
    await app.close();
  }
});

test('HTTP:全脏批 → 400;混批 → 200 带 rejected 计数', async () => {
  const { app, base } = await startApp();
  try {
    const h = { 'x-api-key': KEY };
    const allBad = await postIngest(base, { frames: [{ nope: 1 }] }, h);
    assert.equal(allBad.status, 400, '整批没一帧合规应 400');

    const mixed = await postIngest(base, { frames: [lidFrame(), { nope: 1 }] }, h);
    assert.equal(mixed.status, 200, '有合规的应 200');
    const j = (await mixed.json()) as { accepted: number; rejected: number };
    assert.equal(j.accepted, 1);
    assert.equal(j.rejected, 1);
  } finally {
    await app.close();
  }
});

test('HTTP:GET /ingest → 405(只收 POST)', async () => {
  const { app, base } = await startApp();
  try {
    const r = await fetch(`${base}/cups/${CUP}/ingest`, { headers: { 'x-api-key': KEY } });
    assert.equal(r.status, 405);
  } finally {
    await app.close();
  }
});

test('HTTP:allowUnauth → 不带 key 也能中转(dev 豁免同样生效)', async () => {
  const { app, base } = await startApp({ allowUnauth: true });
  try {
    const r = await postIngest(base, { frames: [lidFrame()] });
    assert.equal(r.status, 200);
  } finally {
    await app.close();
  }
});
