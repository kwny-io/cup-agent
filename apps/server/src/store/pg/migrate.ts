/**
 * 迁移 runner —— 手写编号 `.sql`,无 ORM(原则 P4)。
 *
 * 口径:
 *   · 读 `migrations/` 下所有 `.sql`,按**数字前缀**升序(0001_、0002_…)；
 *   · `schema_migrations` 表记已应用版本,只跑未应用的;每个文件在**各自事务**里跑；
 *   · 唯一由 runner 生成的 DDL 是 `ensurePartitions`(滚动建 telemetry/events 月分区)——
 *     分区名带月份,没法写死在 .sql 里。
 *
 * 为什么每个迁移单独事务:一个失败不该把前面成功的也回滚掉 —— 半应用状态比"停在中途"
 * 更难查。失败即抛,调用方(cli)带清晰 fatal 中止启动。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { query, withTransaction, type Pool } from './pool.ts';

/** 迁移文件目录(`import.meta.dirname` = 本文件所在目录)。 */
const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

interface MigrationFile {
  version: string;
  name: string;
  sql: string;
}

/** 读并排序迁移文件(数字前缀升序 = 应用顺序)。 */
function loadMigrations(): MigrationFile[] {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  const out: MigrationFile[] = [];
  for (const f of files) {
    const m = /^(\d+)_(.+)\.sql$/.exec(f);
    if (!m) continue; // 不符合命名约定的跳过(别把随手放的 .sql 当迁移跑)
    out.push({ version: m[1]!, name: m[2]!, sql: readFileSync(join(MIGRATIONS_DIR, f), 'utf8') });
  }
  out.sort((a, b) => Number(a.version) - Number(b.version));
  return out;
}

/**
 * 建 `schema_migrations` 并应用所有未应用的迁移。
 * @returns 本次实际应用的文件名列表(供日志；已是最新则空数组)
 */
export async function migrate(pool: Pool): Promise<string[]> {
  await query(
    pool,
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    text PRIMARY KEY,
       name       text NOT NULL,
       applied_at bigint NOT NULL
     )`,
  );
  const applied = new Set(
    (await query<{ version: string }>(pool, `SELECT version FROM schema_migrations`)).map(
      (r) => r.version,
    ),
  );
  const ran: string[] = [];
  for (const mig of loadMigrations()) {
    if (applied.has(mig.version)) continue;
    await withTransaction(pool, async (client) => {
      await client.query(mig.sql);
      await client.query(
        `INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)`,
        [mig.version, mig.name, Date.now()],
      );
    });
    ran.push(`${mig.version}_${mig.name}`);
  }
  // 建分区放在最后:表 structure 已就位才谈得上分区
  await ensurePartitions(pool);
  return ran;
}

/** 分区表名(按月滚动建)。 */
const PARTITIONED = ['telemetry', 'events'] as const;

/** `Date.UTC(y, m, 1)` —— 某月 1 号 00:00 UTC 的 ms(分区边界;分区按 UTC 月切,与日界时区无关)。 */
function monthStartMs(year: number, month0: number): number {
  return Date.UTC(year, month0, 1);
}

/** 分区名后缀 `YYYYMM`。 */
function stamp(year: number, month0: number): string {
  return `${year}${String(month0 + 1).padStart(2, '0')}`;
}

/**
 * 确保从 `now` 所在月起的 `ahead` 个后续月的分区都存在(幂等)。
 * 只建未来分区,**不删旧分区** —— 保留策略(删整分区)是独立、不可逆的一步,另说。
 * @param pool 连接池
 * @param now  基准时刻(默认当前)
 * @param ahead 往后建几个月(默认 2:当月 + 后两月)
 */
export async function ensurePartitions(pool: Pool, now = Date.now(), ahead = 2): Promise<void> {
  const d = new Date(now);
  for (let i = 0; i <= ahead; i++) {
    const y = d.getUTCFullYear();
    const m0 = d.getUTCMonth() + i; // 跨年由 Date.UTC 归一(m0 可 >11)
    const from = monthStartMs(y, m0);
    const to = monthStartMs(y, m0 + 1);
    const tag = stamp(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth());
    for (const table of PARTITIONED) {
      // 分区名/边界都是**由代码算出的**整数常量(Date.UTC),非用户输入;表名走白名单(上方 PARTITIONED)。
      // 注意:PG 的 PARTITION OF ... FOR VALUES 是 DDL,边界**不能**用 $n 参数,必须内联字面量。
      await query(
        pool,
        `CREATE TABLE IF NOT EXISTS ${table}_${tag}
           PARTITION OF ${table} FOR VALUES FROM (${from}) TO (${to})`,
      );
    }
  }
}

/**
 * 已存在的月分区名(供保留策略/测试用)。非 {table}_\d{6} 命名的(如 DEFAULT)不算。
 */
export async function listPartitions(pool: Pool, table: string): Promise<string[]> {
  const rows = await query<{ relname: string }>(
    pool,
    `SELECT c.relname AS relname
       FROM pg_class c
       JOIN pg_inherits i ON i.inhrelid = c.oid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = $1`,
    [table],
  );
  return rows.map((r) => r.relname).sort();
}

/**
 * 删一个整月分区(保留策略:不逐行删)。**不可逆**。
 * 只接受 `{table}_{YYYYMM}` 形状的名字(白名单前缀 + 数字后缀),杜绝乱删。
 */
export async function dropPartition(pool: Pool, table: string, tag: string): Promise<void> {
  if (!(PARTITIONED as readonly string[]).includes(table) || !/^\d{6}$/.test(tag)) {
    throw new Error(`dropPartition: 拒绝非法分区名 ${table}_${tag}`);
  }
  await query(pool, `DROP TABLE IF EXISTS ${table}_${tag}`);
}

// ── 保留策略(第 5 阶段)────────────────────────────────────────────
// 遥测留 ~90 天、事件留 ~13 个月(十万用户下 telemetry 约 58M 行/天,逐行删跑不动)。
// **删整分区**是唯一可行解,也是**不可逆**的一步 → 默认不开,须显式 `--retain`/`CUP_RETENTION=1`。

/** 遥测默认保留天数。 */
export const DEFAULT_TELEMETRY_RETAIN_DAYS = 90;
/** 事件默认保留天数(约 13 个月,跨年可查)。 */
export const DEFAULT_EVENTS_RETAIN_DAYS = 395;

export interface RetentionOptions {
  /** 遥测保留天数(默认 90;cli 读 `CUP_TELEMETRY_RETAIN_DAYS`)。 */
  telemetryDays?: number;
  /** 事件保留天数(默认 395;cli 读 `CUP_EVENTS_RETAIN_DAYS`)。 */
  eventsDays?: number;
  /** 基准时刻(默认当前;测试注入用)。 */
  now?: number;
}

/** 从环境变量读一个非负整数天数;缺省/非法 → fallback(不抛,免得配错一个值就起不来)。 */
export function retainDaysFromEnv(name: string, fallback: number, env = process.env): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * 纯逻辑:给定已有分区 tag(如 `202601`)与保留天数,算出该删哪些。
 *
 * 口径(**删整月,不逐行**):
 *   · 分区 M 覆盖 `[monthStart(M), monthStart(M+1))`;只有当它**整段**都早于 cutoff
 *     (`monthStart(M) < cutoff 所在月`)才删 —— cutoff 落在某月中间时该月**保留**
 *     (宁可多留一个月,也不误删刚过线的数据)。
 *   · 等价于:删 `tag < cutoff 所在月` 的分区。
 *   · **绝不删当前月**(兜底,即便 retainDays=0)。
 *   · 非 `{YYYYMM}` 形状的(如 DEFAULT 分区)一律不碰。
 */
export function partitionsToDrop(tags: readonly string[], now: number, retainDays: number): string[] {
  const cd = new Date(now - retainDays * 86_400_000);
  const cutoffTag = stamp(cd.getUTCFullYear(), cd.getUTCMonth());
  const nd = new Date(now);
  const currentTag = stamp(nd.getUTCFullYear(), nd.getUTCMonth());
  const out: string[] = [];
  for (const tag of tags) {
    if (!/^\d{6}$/.test(tag)) continue;
    if (tag < cutoffTag && tag < currentTag) out.push(tag);
  }
  return out.sort();
}

/** `telemetry_202601` → `202601`(listPartitions 返回全名,保留逻辑只认 tag)。 */
function tagOf(table: string, relname: string): string {
  return relname.startsWith(`${table}_`) ? relname.slice(table.length + 1) : relname;
}

/**
 * 应用保留策略:对 telemetry/events 各删一批过期整月分区。**不可逆**,调用方须显式开启。
 * @returns 实际删掉的分区全名(如 `telemetry_202601`),供日志/测试断言
 */
export async function applyRetention(
  pool: Pool,
  opts: RetentionOptions = {},
  log: (msg: string) => void = () => {},
): Promise<string[]> {
  const now = opts.now ?? Date.now();
  const days: Record<(typeof PARTITIONED)[number], number> = {
    telemetry: opts.telemetryDays ?? DEFAULT_TELEMETRY_RETAIN_DAYS,
    events: opts.eventsDays ?? DEFAULT_EVENTS_RETAIN_DAYS,
  };
  const dropped: string[] = [];
  for (const table of PARTITIONED) {
    const tags = (await listPartitions(pool, table)).map((r) => tagOf(table, r));
    for (const tag of partitionsToDrop(tags, now, days[table])) {
      await dropPartition(pool, table, tag);
      dropped.push(`${table}_${tag}`);
      log(`删除过期分区 ${table}_${tag}(保留 ${days[table]} 天)`);
    }
  }
  if (dropped.length === 0) {
    log(`无过期分区可删(遥测 ${days.telemetry} 天 / 事件 ${days.events} 天)`);
  }
  return dropped;
}
