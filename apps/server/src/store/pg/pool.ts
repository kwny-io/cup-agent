/**
 * pg 连接池薄封装 —— 手写,不引 ORM/查询层(原则 P4"无框架";用户已批准 `pg`)。
 *
 * 为什么薄:上层只认 `Store` 接口,这里只负责"开池 / 打标查询 / 事务 / 关池"。
 * 一切 SQL 都带 $n 占位(绝不拼字符串 —— 防注入),这里不记日志、不重试、不缓存:
 * 那些是策略,等真有需求再加,别现在凭空造。
 *
 * `query` 故意只做类型抹平(`QueryResultRow` → 调用方自定形状),不做运行时装换 ——
 * 驱动返回的 row 形状由 SQL 的 SELECT 列表决定,调用方最清楚。
 */
import pg from 'pg';
import type { Pool as PgPool, PoolConfig, QueryResultRow } from 'pg';

// int8(bigint) 默认以**字符串**返回(node-postgres 防精度损失)。我们的 int8 列都是
// unix ms 时刻 / 计数,全部 < 2^53,精确落在 Number 里 —— 统一转 Number,
// 免得每个查询点手动 `Number(row.ts)` 或写 `::float8`。这是**全局**设置,故只在本模块做一次。
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export type Pool = PgPool;

export interface CreatePoolOptions extends PoolConfig {
  /** 从连接串建池(优先);给了 connectionString 就忽略其余连接字段 */
  connectionString?: string;
}

/** 建连接池。默认池上限 10(单进程够;十万用户级别按部署再调)。 */
export function createPgPool(url: string, opts: PoolConfig = {}): Pool {
  return new pg.Pool({ connectionString: url, max: 10, ...opts });
}

/**
 * 跑一条带参查询。
 * @param pool 连接池
 * @param sql  SQL;$1,$2… 占位
 * @param params 参数(绝不拼进 SQL)
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(sql, params);
  return res.rows;
}

/** 跑一条查询,取首行(无则 null)。 */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(pool, sql, params);
  return rows[0] ?? null;
}

/**
 * 在一个事务里跑一段逻辑(BEGIN / COMMIT / 出错 ROLLBACK)。
 * 回调拿到的是**同一个 client**,必须用它做全部查询 —— 用 pool 会拿到别的连接、脱离事务。
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ROLLBACK 失败(连接已断)不掩盖原始错误
    }
    throw err;
  } finally {
    client.release();
  }
}
