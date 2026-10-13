/**
 * `PgServerLogStore` —— `ServerLogStore` 的 Postgres 实现。
 *
 * 写:`unnest(...)` 多行批插(一次往返、SQL 文本有界、无动态 $n 拼接)。
 * 读:keyset 分页(`ts`/`id` 倒序 + `(ts,id) <` 游标),避免深 OFFSET。
 *
 * 表 `server_logs` 按月分区(`PARTITION BY RANGE (ts)`),由 `ensurePartitions` 运行时建、
 * `applyRetention` 按 90 天保留删整分区。故本类只管读写,不管建表/清理。
 */
import {
  LOG_PAGE_DEFAULT,
  LOG_PAGE_MAX,
  makeLogCursor,
  parseLogCursor,
  type LogPage,
  type LogQuery,
  type LogRow,
  type ServerLogStore,
} from '../../core/log-store.ts';
import { query, type Pool } from './pool.ts';

interface LogRowDb {
  id: number;
  ts: number;
  level: string;
  src: string | null;
  msg: string;
  payload: Record<string, unknown>;
}

function toRow(r: LogRowDb): LogRow {
  return {
    ts: r.ts,
    level: r.level as LogRow['level'],
    src: r.src,
    msg: r.msg,
    payload: r.payload ?? {},
  };
}

/** 转义 LIKE 通配(`%`/`_`/`\`)—— 让关键词搜索是**字面**子串,不误当通配。 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

export class PgServerLogStore implements ServerLogStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async append(rows: LogRow[]): Promise<void> {
    if (rows.length === 0) return;
    await query(
      this.pool,
      `INSERT INTO server_logs (ts, level, src, msg, payload)
       SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::jsonb[])`,
      [
        rows.map((r) => r.ts),
        rows.map((r) => r.level),
        rows.map((r) => r.src),
        rows.map((r) => r.msg),
        rows.map((r) => JSON.stringify(r.payload)),
      ],
    );
  }

  async query(q: LogQuery): Promise<LogPage> {
    const limit = Math.min(Math.max(1, q.limit ?? LOG_PAGE_DEFAULT), LOG_PAGE_MAX);
    const cursor = parseLogCursor(q.cursor);
    const where: string[] = [];
    const params: unknown[] = [];

    if (q.levels && q.levels.length > 0) {
      params.push([...q.levels]);
      where.push(`level = ANY($${params.length})`);
    }
    if (q.src !== undefined) {
      params.push(q.src);
      where.push(`src = $${params.length}`);
    }
    if (q.from !== undefined) {
      params.push(q.from);
      where.push(`ts >= $${params.length}`);
    }
    if (q.to !== undefined) {
      params.push(q.to);
      where.push(`ts <= $${params.length}`);
    }
    if (q.q) {
      params.push(`%${escapeLike(q.q)}%`);
      where.push(`msg ILIKE $${params.length} ESCAPE '\\'`);
    }
    if (cursor) {
      params.push(cursor.ts);
      const tIdx = params.length;
      params.push(cursor.id);
      const iIdx = params.length;
      where.push(`(ts < $${tIdx} OR (ts = $${tIdx} AND id < $${iIdx}))`);
    }

    params.push(limit + 1); // 多取一行判断"还有没有更多"
    const limitIdx = params.length;
    const sql = `SELECT id, ts, level, src, msg, payload FROM server_logs${
      where.length ? ` WHERE ${where.join(' AND ')}` : ''
    } ORDER BY ts DESC, id DESC LIMIT $${limitIdx}`;

    const rows = await query<LogRowDb>(this.pool, sql, params);
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      rows: page.map(toRow),
      next_cursor: more && last ? makeLogCursor({ ts: last.ts, id: last.id }) : null,
    };
  }
}
