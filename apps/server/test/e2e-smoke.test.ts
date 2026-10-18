/**
 * E2E 冒烟 —— 一条**真链**跑通:真模拟器(Engine + WS 出口)→ 真 sim-adapter → 真管线 → 落点。
 *
 * 与既有单测的分工:
 *   · `acceptance.test.ts` 用裸 `WebSocketServer` 当假模拟器,验适配器的拒收语义;
 *   · 这里用**真模拟器**组件,验"两个组件真的能对上",并把落点换成真库
 *     (PG 才看得出来表/分区/序列化有没有问题)。
 *
 * 两个模式:
 *   · **有 `CUP_PG_URL`** → 一次性 schema + 真迁移 + 真 PgStore(CI 的 e2e job 走这条);
 *   · **无 `CUP_PG_URL`** → 内存 store,但 sim→adapter→pipeline 仍是真链路
 *     (本机零基建也能跑,不至于整套 skip 掉)。
 *
 * 不用 `app.listen()`:数据从 WS 进来,这条测试不需要 HTTP —— 少一个端口、少一个竞态。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Engine, smoke, startWsServer } from '@cup/simulator';
import { createApp } from '../src/app.ts';
import { createPgPool, query, type Pool } from '../src/store/pg/pool.ts';
import { migrate } from '../src/store/pg/migrate.ts';
import { dayKey, dayStart } from '../src/store/store.ts';
import type { WsHandle } from '@cup/simulator';

const CUP_ID = 'cup-A1B2C3'; // 模拟器 Engine 的默认杯(见 engine.ts DEFAULT_CONFIG)
const REPORT_MS = 10_000; // 必须小于脚本跨度,否则一个上报周期都走不到 → 0 帧

interface Rig {
  app: ReturnType<typeof createApp>;
  engine: Engine;
  ws: WsHandle;
  pool: Pool | null;
  cleanup: () => Promise<void>;
}

/** 等到 `cond()` 为真,否则超时抛错。跨异步链路的最终一致性断言靠它。 */
async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor 超时(${timeoutMs}ms):${label}`);
}

/** 起一套:WS 出口 + 后端适配器 + 落点。顺序有讲究,见各步注释。 */
async function makeRig(): Promise<Rig> {
  // 1) WS 出口先起 —— 适配器在 createApp 里**同步发起连接**,晚起会白等一轮退避。
  const ws = startWsServer(0, { hello: () => ({ kind: 'hello', v: 1 }) });
  await ws.ready();
  const port = ws.port();
  assert.ok(port > 0, `WS 出口应拿到真实端口,实得 ${port}`);

  // 2) 落点:有 PG 就用一次性 schema(与 store-contract 同款纪律),退出时整块删。
  const pgUrl = process.env.CUP_PG_URL;
  let pool: Pool | null = null;
  let admin: Pool | null = null;
  let schema: string | null = null;
  if (pgUrl) {
    schema = `e2e${randomBytes(4).toString('hex')}`;
    admin = createPgPool(pgUrl);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = createPgPool(pgUrl, { options: `-c search_path=${schema}` });
    await migrate(pool);
  }

  // 3) 真模拟器引擎。起点钉在**今天 00:00**,这样事件 ts 落在"今天"的分区/日聚合里。
  const engine = new Engine({
    config: {
      seed: 7,
      scale: 600,
      startMs: dayStart(dayKey(Date.now())),
      reportMs: REPORT_MS,
      verbose: false,
      cupId: CUP_ID,
    },
    steps: smoke(),
    sink: () => {},
  });
  engine.wireWs(ws);

  const app = createApp({
    simUrl: `ws://127.0.0.1:${port}`,
    log: () => {},
    pgPool: pool ?? undefined,
    allowUnauth: true,
    rateLimit: false, // 这条测的不是限流,别让阈值掺进来
  });

  return {
    app,
    engine,
    ws,
    pool,
    cleanup: async () => {
      await app.close(); // 内含 adapter.stop() + pool.end()
      ws.close();
      if (admin && schema) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
    },
  };
}

test('e2e:真模拟器 → sim-adapter → 管线 → 落点(有 CUP_PG_URL 则真 PG)', async () => {
  const rig = await makeRig();
  const date = dayKey(rig.engine.config.startMs);
  try {
    // ── 关键闸:必须等适配器**真的连上**才能开跑 ──────────────────
    // 模拟器的 broadcast 在 clients.size===0 时静默丢弃(见 ws/server.ts),
    // 抢在连接前 runToEnd 会一帧不落地、后面全是超时 —— 别用 sleep,等真信号。
    await waitFor(() => rig.ws.clientCount() > 0, 5000, 'sim-adapter 应连上 WS 出口');

    // ── 驱动 ──────────────────────────────────────────────────
    const { ticks } = rig.engine.runToEnd(60_000);
    assert.ok(ticks > 0, '应至少推进一拍');

    // ── 遥测链路:样本落定 ─────────────────────────────────────
    let sample = await rig.app.store.latestSample(CUP_ID);
    const deadline = Date.now() + 8000;
    while (!sample && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      sample = await rig.app.store.latestSample(CUP_ID);
    }
    assert.ok(sample, '应落到最新融合样本');
    assert.equal(sample!.cup_id, CUP_ID, '样本应属于模拟器那只杯');
    assert.ok(
      sample!.volume_ml >= 0 && sample!.volume_ml <= 1000,
      `液量应落在契约范围,实得 ${sample!.volume_ml}`,
    );

    // ── 事件链路:smoke 倒 70°C 热水 → temp_alert ─────────────
    // 用事件而非只验遥测,是因为两者的落库路径不同(appendEvent + applyEventToAgg)。
    await waitFor(async () => {
      const evs = await rig.app.store.events(CUP_ID, 0, Date.now() + 60_000);
      return evs.some((e) => e.type === 'temp_alert');
    }, 8000, '应收到 temp_alert 事件');

    // ── 聚合链路:smoke 有 2 次 drink → drank_ml > 0 ──────────
    await waitFor(async () => {
      const agg = await rig.app.store.agg(CUP_ID, date);
      return agg !== null && agg.drank_ml > 0 && agg.event_count > 0;
    }, 8000, '今日聚合应有饮水与事件');

    const agg = await rig.app.store.agg(CUP_ID, date);
    assert.ok(agg, '今日聚合不应为 null');
    assert.ok(agg!.drank_ml > 0, `应有饮水记录,实得 ${agg!.drank_ml}`);

    // ── 契约拒收面:全链路不该有任何一帧被 §2 拒 ────────────────
    assert.deepEqual(rig.app.pipeline.stats().rejected, 0, '真模拟器产出的帧不该被契约拒收');
    assert.equal(rig.app.adapter?.rejected() ?? -1, 0, '适配器侧也不该拒收');

    // ── PG 专属:数据真的进了表(而不是停在 store 的进程内缓存)────
    if (rig.pool) {
      const rows = await query<{ telemetry: number; events: number }>(
        rig.pool,
        `SELECT (SELECT count(*) FROM telemetry)::int AS telemetry,
                (SELECT count(*) FROM events)::int    AS events`,
      );
      const r = rows[0]!;
      assert.ok(r.telemetry > 0, `telemetry 表应有行,实得 ${r.telemetry}`);
      assert.ok(r.events > 0, `events 表应有行,实得 ${r.events}`);
      // 分区必须真建出来了 —— 否则表能写但保留策略/回看会瞎
      const parts = await query<{ n: number }>(
        rig.pool,
        `SELECT count(*)::int AS n FROM pg_inherits
          WHERE inhparent = 'telemetry'::regclass`,
      );
      assert.ok(parts[0]!.n > 0, 'telemetry 应有月分区');
    }
  } finally {
    await rig.cleanup();
  }
});
