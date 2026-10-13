/**
 * `PgServerLogStore` —— 真 PG(仅当 `CUP_PG_URL` 存在时跑,否则 `t.skip`)。
 *
 * 隔离:`CREATE SCHEMA c<rand>` + 连接串 `-c search_path=<schema>`(照 store-contract 手法),
 * 测完 `DROP SCHEMA ... CASCADE`。
 *
 * 钉的是 **Pg 实现与内存实现同语义**:批插(unnest)可读回、keyset 分页倒序推进、
 * 关键词 ILIKE 是**字面**子串(通配被转义)、级别/来源/时间筛选。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { MemoryServerLogStore, PgServerLogStore, type LogRow } from '@cup/server';
import { createPgPool, type Pool } from '../src/store/pg/pool.ts';
import { migrate } from '../src/store/pg/migrate.ts';

const PG_URL = process.env.CUP_PG_URL;

/** 当前时刻附近造行(须落在已建分区内 —— ensurePartitions 建当月 + 后两月)。 */
function rows(): LogRow[] {
  const base = Date.now();
  return [
    { ts: base + 1000, level: 'info', src: 'http', msg: 'GET /cups/a/today → 200', payload: { rid: 'r1' } },
    { ts: base + 2000, level: 'warn', src: 'http', msg: 'GET /cups/a/state → 404', payload: {} },
    { ts: base + 3000, level: 'error', src: 'mqtt', msg: 'broker disconnected', payload: { host: 'localhost' } },
    { ts: base + 4000, level: 'warn', src: 'http', msg: 'login 100%_fail', payload: {} },
  ];
}

if (!PG_URL) {
  test('[PgServerLog] CUP_PG_URL 未设 → skip(零基建保证)', { skip: 'CUP_PG_URL 未设' }, () => {});
} else {
  const schema = `c${randomBytes(4).toString('hex')}`;
  const admin = createPgPool(PG_URL);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool: Pool = createPgPool(PG_URL, { options: `-c search_path=${schema}` });
  await migrate(pool);
  const store = new PgServerLogStore(pool);
  const fresh = async (): Promise<void> => {
    await pool.query(`TRUNCATE server_logs RESTART IDENTITY CASCADE`);
  };

  test('[PgServerLog] append(unnest 批插)后可原样读回', async () => {
    await fresh();
    const input = rows();
    await store.append(input);
    const page = await store.query({ limit: 100 });
    assert.equal(page.rows.length, 4);
    // 倒序:最新在前
    assert.equal(page.rows[0]?.msg, 'login 100%_fail');
    // payload 原样( jsonb 往返)
    const mqtt = page.rows.find((r) => r.src === 'mqtt')!;
    assert.deepEqual(mqtt.payload, { host: 'localhost' });
    // 空数组 append 是 no-op
    await store.append([]);
    assert.equal((await store.query({ limit: 100 })).rows.length, 4);
  });

  test('[PgServerLog] keyset 分页:(ts,id) 倒序、cursor 推进、末页 null', async () => {
    await fresh();
    await store.append(rows());
    const p1 = await store.query({ limit: 2 });
    assert.equal(p1.rows.length, 2);
    assert.ok(p1.next_cursor);
    const p2 = await store.query({ limit: 2, cursor: p1.next_cursor! });
    assert.equal(p2.rows.length, 2);
    assert.equal(p2.next_cursor, null, '第 3 页只有 2 行 → 末页');
    // 两页不重叠
    const all = [...p1.rows, ...p2.rows].map((r) => r.msg);
    assert.equal(new Set(all).size, 4);
  });

  test('[PgServerLog] 筛选:级别(ANY)/ 来源 / 关键词 ILIKE 字面 / 时间范围', async () => {
    await fresh();
    const input = rows();
    await store.append(input);

    assert.equal((await store.query({ levels: ['warn'] })).rows.length, 2);
    assert.equal((await store.query({ levels: ['warn', 'error'] })).rows.length, 3);
    assert.equal((await store.query({ src: 'mqtt' })).rows.length, 1);
    // 关键词里的 % 与 _ 是**字面**(会被转义),故 '100%_fail' 只匹配它自己
    assert.equal((await store.query({ q: '100%_fail' })).rows.length, 1);
    // 未转义时 '%' 会通配一切(4 行)、'_' 会通配任意单字(4 行);
    // 转义后二者都只命中含**字面**该字符的那一行('login 100%_fail')。
    assert.deepEqual((await store.query({ q: '%' })).rows.map((r) => r.msg), ['login 100%_fail'], '% 是字面,不通配');
    assert.deepEqual((await store.query({ q: '_' })).rows.map((r) => r.msg), ['login 100%_fail'], '_ 是字面,不通配');
    const lo = input[1]!.ts;
    const hi = input[2]!.ts;
    assert.equal((await store.query({ from: lo, to: hi })).rows.length, 2);
  });

  test('[PgServerLog] 与内存实现同语义(同一组断言两边都过)', async () => {
    await fresh();
    const mem = new MemoryServerLogStore();
    const input = rows();
    await store.append(input);
    await mem.append(input);

    for (const q of [
      { levels: ['warn', 'error'] as const },
      { src: 'http' },
      { q: 'cups' },
      { limit: 2 },
    ]) {
      const a = await store.query({ ...q });
      const b = await mem.query({ ...q });
      assert.deepEqual(
        a.rows.map((r) => r.msg),
        b.rows.map((r) => r.msg),
        `查询 ${JSON.stringify(q)} 两实现结果应一致`,
      );
      assert.equal(a.next_cursor !== null, b.next_cursor !== null);
    }
  });

  test('[PgServerLog] teardown：DROP SCHEMA CASCADE', async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });
}
