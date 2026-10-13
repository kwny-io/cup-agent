/**
 * Store 契约测试 —— **同一组断言**跑 `MemoryStore` 与 `PgStore`，证明"只换实现、语义不变"。
 *
 * 跑法：
 *   · `MemoryStore` **总是**跑（零基建，CI 主套件用的就是它）；
 *   · `PgStore` **仅当 `CUP_PG_URL` 存在**时跑，否则 `t.skip`（本机无 DB 也不会红）。
 *
 * 隔离：Pg 侧每次用**一次性 schema**（`CREATE SCHEMA c<rand>` + `search_path`），
 * 与现有 `mkdtemp` 临时目录纪律同款；测完 `DROP SCHEMA ... CASCADE`。
 *
 * 覆盖：追加/范围查、乱序事件归位、缺天补空的 `recentAggs`、streak、goal 默认与
 * "goal 冻结在行创建时"、最新样本。chat/accounts 各自单列（见文件下半）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { CupEvent } from '@cup/contract';
import { MemoryStore, type Store, dayKey, shiftDay } from '@cup/server';
import { PgStore } from '../src/store/pg/store.ts';
import { PgChatStore } from '../src/store/pg/chat.ts';
import { PgAccountsStore } from '../src/store/pg/accounts.ts';
import { PgProfileStore } from '../src/store/pg/profile.ts';
import { PgCupLlmStore } from '../src/store/pg/cup-llm.ts';
import { createPgPool, type Pool } from '../src/store/pg/pool.ts';
import { migrate } from '../src/store/pg/migrate.ts';

const CUP = 'cup-CONTRACT';

function ev(over: Partial<CupEvent> = {}): CupEvent {
  return {
    v: 1,
    cup_id: CUP,
    device_id: 'lid-CONTRACT',
    ts: Date.now(),
    type: 'drink',
    amount_ml: 200,
    confidence: 0.9,
    derived_by: 'backend',
    ...over,
  };
}

// ── 契约本体（store 无关）───────────────────────────────────────

async function runStoreContract(name: string, make: () => Promise<Store>, done?: () => Promise<void>): Promise<void> {
  await test(`[${name}] goal 默认 1500，setGoal 后读到新值`, async () => {
    const s = await make();
    assert.equal(await s.goal(CUP), 1500);
    await s.setGoal(CUP, 2000);
    assert.equal(await s.goal(CUP), 2000);
    await done?.();
  });

  await test(`[${name}] applyEventToAgg：drink 累加 drank/drink_count，refill 累加 refill`, async () => {
    const s = await make();
    const d = dayKey(Date.now());
    await s.applyEventToAgg(ev({ type: 'drink', amount_ml: 250 }));
    await s.applyEventToAgg(ev({ type: 'drink', amount_ml: 100 }));
    await s.applyEventToAgg(ev({ type: 'refill', amount_ml: 500 }));
    const a = await s.agg(CUP, d);
    assert.ok(a);
    assert.equal(a.drank_ml, 350);
    assert.equal(a.drink_count, 2);
    assert.equal(a.refill_ml, 500);
    assert.equal(a.event_count, 3);
    await done?.();
  });

  await test(`[${name}] agg 只读，不建行`, async () => {
    const s = await make();
    assert.equal(await s.agg(CUP, '2000-01-01'), null);
    await done?.();
  });

  await test(`[${name}] goal 冻结在行创建时：先建行、后改 goal，旧行 goal 不变`, async () => {
    const s = await make();
    const d = dayKey(Date.now());
    await s.applyEventToAgg(ev({ ts: Date.now() })); // 建行，goal=1500
    await s.setGoal(CUP, 3000); // 改 goal
    const a = await s.agg(CUP, d);
    assert.equal(a?.goal_ml, 1500); // 行内 goal 冻结
    assert.equal(await s.goal(CUP), 3000); // 但当前 goal 已变
    await done?.();
  });

  await test(`[${name}] recentAggs 缺天补空、旧→新、goal 用当前值`, async () => {
    const s = await make();
    const today = dayKey(Date.now());
    const yesterday = shiftDay(today, -1);
    await s.setGoal(CUP, 1800);
    await s.applyEventToAgg(ev({ ts: Date.now(), amount_ml: 1800 })); // 今天达标
    const aggs = await s.recentAggs(CUP, today, 3);
    assert.equal(aggs.length, 3);
    assert.equal(aggs[0]?.date, shiftDay(today, -2));
    assert.equal(aggs[1]?.date, yesterday);
    assert.equal(aggs[2]?.date, today);
    assert.equal(aggs[0]?.drank_ml, 0); // 缺天补空
    assert.equal(aggs[0]?.goal_ml, 1800); // 补空用当前 goal
    assert.equal(aggs[2]?.drank_ml, 1800);
    await done?.();
  });

  await test(`[${name}] streak：连续达标回看（今天达标计入）`, async () => {
    const s = await make();
    const now = Date.now();
    const dayMs = 86_400_000;
    await s.setGoal(CUP, 1000);
    // 昨天、前天各达标；今天达标 → streak=3
    await s.applyEventToAgg(ev({ ts: now - 2 * dayMs, amount_ml: 1000 }));
    await s.applyEventToAgg(ev({ ts: now - 1 * dayMs, amount_ml: 1000 }));
    const a = await s.applyEventToAgg(ev({ ts: now, amount_ml: 1000 }));
    assert.equal(a.streak, 3);
    await done?.();
  });

  await test(`[${name}] streak：今天未达标则从昨天起算，不算断链`, async () => {
    const s = await make();
    const now = Date.now();
    const dayMs = 86_400_000;
    await s.setGoal(CUP, 1000);
    await s.applyEventToAgg(ev({ ts: now - 1 * dayMs, amount_ml: 1000 })); // 昨天达标
    const a = await s.applyEventToAgg(ev({ ts: now, amount_ml: 100 })); // 今天没达标
    assert.equal(a.streak, 1); // 昨天那段保住了
    await done?.();
  });

  await test(`[${name}] 遥测：append 后可范围查，返回插入序`, async () => {
    const s = await make();
    const now = Date.now();
    await s.appendTelemetry({ cup_id: CUP, device_id: 'lid-CONTRACT', kind: 'lid', ts: now, seq: 1 });
    await s.appendTelemetry({ cup_id: CUP, device_id: 'lid-CONTRACT', kind: 'lid', ts: now, seq: 2 });
    const pts = await s.telemetry(CUP, now - 10, now + 10);
    assert.equal(pts.length, 2);
    assert.equal(pts[0]?.seq, 1);
    assert.equal(pts[1]?.seq, 2);
    await done?.();
  });

  await test(`[${name}] 事件：乱序到达按 ts 归位`, async () => {
    const s = await make();
    const now = Date.now();
    await s.appendEvent(ev({ ts: now + 100 }));
    await s.appendEvent(ev({ ts: now - 100 }));
    const es = await s.events(CUP, now - 1000, now + 1000);
    assert.equal(es.length, 2);
    assert.ok((es[0]?.ts ?? 0) < (es[1]?.ts ?? 0));
    await done?.();
  });

  await test(`[${name}] 最新样本：set 后可读，未设 → null`, async () => {
    const s = await make();
    assert.equal(await s.latestSample('cup-NONE'), null);
    const smp = {
      cup_id: CUP,
      ts: Date.now(),
      volume_ml: 320,
      level_pct: 60,
      temp_c: 42,
      confidence: 0.8,
      derived_by: 'base' as const,
      present: true,
      stable: true,
    };
    await s.setLatestSample(smp);
    assert.deepEqual(await s.latestSample(CUP), smp);
    await done?.();
  });

  await test(`[${name}] applySampleToAgg：刷新 last_volume 与水温区间`, async () => {
    const s = await make();
    const now = Date.now();
    const d = dayKey(now);
    const mk = (volume_ml: number, temp_c: number | null) => ({
      cup_id: CUP,
      ts: now,
      volume_ml,
      level_pct: 50,
      temp_c,
      confidence: 0.8,
      derived_by: 'base' as const,
      present: true,
      stable: true,
    });
    await s.applySampleToAgg(mk(300, 50));
    await s.applySampleToAgg(mk(280, 40));
    const a = await s.agg(CUP, d);
    assert.equal(a?.last_volume_ml, 280);
    assert.equal(a?.temp_min_c, 40);
    assert.equal(a?.temp_max_c, 50);
    assert.equal(a?.temp_avg_c, 45);
    await done?.();
  });

  // ── 记忆卡（第 3 阶段）────────────────────────────────────────

  await test(`[${name}] 记忆卡：put 后可读，未设 → null；同天 put 幂等覆盖`, async () => {
    const s = await make();
    const d = dayKey(Date.now());
    assert.equal(await s.memoryCard(CUP, d), null);
    const card = {
      cup_id: CUP,
      date: d,
      details: {
        drank_ml: 1200,
        goal_ml: 1500,
        reached: false,
        streak: 2,
        refill_count: 1,
        temp_range: [38, 55] as [number, number],
        notable_events: [{ type: 'shake', ts: 1 }],
        body_cues: [{ cue: 'hurt', evidence: 'shake@1' }],
        turns_summary: '主人问过「今天怎么样」',
        turn_count: 2,
      },
      built_at: 100,
    };
    await s.putMemoryCard(card);
    assert.deepEqual(await s.memoryCard(CUP, d), card);
    // 幂等覆盖（built_at 更新）
    await s.putMemoryCard({ ...card, built_at: 200 });
    assert.equal((await s.memoryCard(CUP, d))?.built_at, 200);
    await done?.();
  });

  await test(`[${name}] recentMemoryCards：旧→新、只含有卡的天（sparse 不补空）`, async () => {
    const s = await make();
    const today = dayKey(Date.now());
    const yesterday = shiftDay(today, -1);
    const mk = (date: string) => ({
      cup_id: CUP,
      date,
      details: {
        drank_ml: 500,
        goal_ml: 1500,
        reached: false,
        streak: 0,
        refill_count: 0,
        temp_range: null,
        notable_events: [],
        body_cues: [],
        turns_summary: null,
        turn_count: 0,
      },
      built_at: 1,
    });
    // 只有昨天、前天有卡；今天没有
    await s.putMemoryCard(mk(shiftDay(today, -2)));
    await s.putMemoryCard(mk(yesterday));
    const cards = await s.recentMemoryCards(CUP, today, 3);
    assert.equal(cards.length, 2); // 只含有卡的 2 天（今天无卡不补）
    assert.equal(cards[0]?.date, shiftDay(today, -2));
    assert.equal(cards[1]?.date, yesterday);
    await done?.();
  });
}

// ── Memory 总跑 ────────────────────────────────────────────────

await runStoreContract('Memory', async () => new MemoryStore());

// ── Pg 仅当有 DB ───────────────────────────────────────────────

const PG_URL = process.env.CUP_PG_URL;
if (!PG_URL) {
  test('[Pg] CUP_PG_URL 未设 → skip（零基建保证）', { skip: 'CUP_PG_URL 未设' }, () => {});
} else {
  // 一次性 schema：所有 DDL/DML 落在这里，测完 CASCADE 掉（对齐 mkdtemp 临时目录纪律）。
  const schema = `c${randomBytes(4).toString('hex')}`;

  // 关键：search_path 是**连接级**的，池里多连接会漂移 —— 故用连接串 options
  // 让**每个新连接**建立时都带上它（`-c search_path=xxx`），而不是 query 前 SET。
  const admin = createPgPool(PG_URL);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool: Pool = createPgPool(PG_URL, { options: `-c search_path=${schema}` });
  await migrate(pool);

  // 每个测试开始前清空业务表（等价于 Memory 的"每个测试 new 一个 store"）。
  // 不清 schema_migrations —— 迁移已应用，别重复跑。
  const TABLES = [
    'users', 'sessions', 'packs', 'subscriptions', 'friends',
    'cup_settings', 'cup_latest', 'daily_agg', 'telemetry', 'events',
    'chat_turns', 'chat_profile', 'cup_traits', 'memory_cards', 'cup_claims', 'cup_llm',
  ].join(', ');
  const fresh = async (): Promise<Store> => {
    await pool.query(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
    return new PgStore(pool);
  };

  test('[Pg] setup：schema + 迁移落表', async () => {
    const t = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1`,
      [schema],
    );
    assert.ok(t.rows.length >= 15, `期望表数 ≥15,实际 ${t.rows.length}`);
  });

  await runStoreContract('Pg', fresh);

  // chat 契约
  test('[Pg] PgChatStore：画像/蒸馏水位/最近轮', async () => {
    await pool.query(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
    const c = new PgChatStore(pool);
    assert.equal(await c.profile(CUP), null);
    assert.equal(await c.lastDistilledAt(CUP), 0);
    await c.setProfile(CUP, '爱喝温水');
    assert.equal(await c.profile(CUP), '爱喝温水');
    await c.setLastDistilledAt(CUP, 12345);
    assert.equal(await c.lastDistilledAt(CUP), 12345);
    await c.appendTurn({ cup_id: CUP, ts: Date.now(), role: 'user', text: '你好' });
    await c.appendTurn({ cup_id: CUP, ts: Date.now(), role: 'assistant', text: '在的' });
    const turns = await c.recentTurns(CUP, 10);
    assert.equal(turns.length, 2);
    assert.equal(turns[0]?.text, '你好');
    assert.equal(turns[1]?.text, '在的');
  });

  // accounts 契约
  test('[Pg] PgAccountsStore：账号/邮箱查/好友/订阅', async () => {
    await pool.query(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
    const a = new PgAccountsStore(pool);
    await a.createAccount({
      user_id: 'u1', email: 'A@X.com', nickname: 'a', salt: 's', hash: 'h',
      role: 'user', created_at: 1,
    });
    await a.createAccount({
      user_id: 'u2', email: 'b@x.com', nickname: 'b', salt: 's', hash: 'h',
      role: 'user', created_at: 2,
    });
    // 邮箱大小写归一
    assert.equal((await a.accountByEmail('a@x.com'))?.user_id, 'u1');
    assert.equal((await a.accountByEmail('  A@X.COM '))?.user_id, 'u1');
    assert.equal((await a.listAccounts()).length, 2);
    // 好友：双向、规范存、幂等
    await a.addFriend('u1', 'u2');
    await a.addFriend('u2', 'u1'); // 幂等
    assert.deepEqual(await a.friends('u1'), ['u2']);
    assert.deepEqual(await a.friends('u2'), ['u1']);
    // 订阅幂等
    await a.subscribe('u1', 'p1');
    await a.subscribe('u1', 'p1');
    assert.deepEqual(await a.subscriptions('u1'), ['p1']);
    // 绑杯 / 解绑
    await a.setCup('u1', 'cup-CONTRACT');
    assert.equal((await a.accountById('u1'))?.cup_id, 'cup-CONTRACT');
    await a.setCup('u1', null);
    assert.equal((await a.accountById('u1'))?.cup_id, undefined);
  });

  // claim 契约（可信绑定；表 0003_claim_code.sql）—— 与内核实现同语义
  test('[Pg] PgAccountsStore：claim 存/查/用（PK=device_id、双形体共存、不复活）', async () => {
    await pool.query(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
    const a = new PgAccountsStore(pool);
    const FAR = Date.now() + 3_600_000;
    // 双形体：同 cup 不同 device → 两行共存
    await a.putClaim({ device_id: 'lid-1', cup_id: CUP, claim_hash: 'h_lid', issued_at: 1, expires_at: FAR });
    await a.putClaim({ device_id: 'base-1', cup_id: CUP, claim_hash: 'h_base', issued_at: 1, expires_at: FAR });
    const candidates = await a.claimsByCup(CUP);
    assert.equal(candidates.length, 2);
    assert.deepEqual(candidates.map((c) => c.device_id).sort(), ['base-1', 'lid-1']);
    // 未用行 used_at 缺席
    assert.equal((await a.claimByDevice('lid-1'))?.used_at, undefined);
    assert.equal(await a.claimByDevice('nope'), null);
    // 标 used → 打戳；二次调用不复活
    await a.markClaimUsed('lid-1', 12345);
    assert.equal((await a.claimByDevice('lid-1'))?.used_at, 12345);
    await a.markClaimUsed('lid-1', 99999);
    assert.equal((await a.claimByDevice('lid-1'))?.used_at, 12345, '已用不复活');
    // 过期后铸新码：putClaim 覆盖且 used 归零（可再绑）
    await a.putClaim({ device_id: 'lid-1', cup_id: CUP, claim_hash: 'h_lid2', issued_at: 2, expires_at: FAR });
    const fresh = await a.claimByDevice('lid-1');
    assert.equal(fresh?.claim_hash, 'h_lid2');
    assert.equal(fresh?.used_at, undefined, '铸新码后 used 归零');
  });

  // profile 契约
  test('[Pg] PgProfileStore：get/set 派生性格', async () => {
    await pool.query(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
    const p = new PgProfileStore(pool);
    assert.equal(await p.get(CUP), null);
    const rec = {
      nickname: '小杯',
      traits: { disposition: 'smug' as const, level: 0.8, streak: 3, warmth: 0.9, refill_habit: 0.5, updated_at: 1 },
    };
    await p.set(CUP, rec);
    assert.deepEqual(await p.get(CUP), rec);
  });

  // 每杯模型配置(BYOK;表 0004_cup_llm.sql)—— get/set/upsert/delete 语义对齐内存实现
  test('[Pg] PgCupLlmStore：get/set/upsert/delete(密文原样搬)', async () => {
    await pool.query(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
    const llm = new PgCupLlmStore(pool);
    assert.equal(await llm.get(CUP), null);
    const cfg = {
      cup_id: CUP, provider: 'anthropic' as const, model: 'claude-sonnet-4-6',
      base_url: 'https://proxy.local/v1/messages', key_enc: 'iv.tag.cipher', updated_at: 1,
    };
    await llm.set(CUP, cfg);
    assert.deepEqual(await llm.get(CUP), cfg);
    // 覆盖：同 cup_id → ON CONFLICT DO UPDATE(不新增行、字段全换)
    await llm.set(CUP, { ...cfg, model: 'claude-opus-4-1', base_url: undefined, updated_at: 2 });
    const after = await llm.get(CUP);
    assert.equal(after?.model, 'claude-opus-4-1');
    assert.equal(after?.base_url, undefined, 'base_url 清空后回 undefined(不是空串)');
    // 删：无行 no-op、有行清掉
    await llm.delete(CUP);
    assert.equal(await llm.get(CUP), null);
    await llm.delete(CUP); // 二次删 no-op
  });

  test('[Pg] teardown：DROP SCHEMA CASCADE', async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });
}
