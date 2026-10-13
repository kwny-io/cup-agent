/**
 * 日志读写域 —— 结构化日志行 + 查询条件 + 读写口。
 *
 * 读写一体(不拆两个接口):写 = 日志管线刷一批(`append`),读 = 管理页查一页(`query`)。
 * 两个实现:内存版(`store/memory-server-logs.ts`,供零基建测试)与 Pg 版
 * (`store/pg/server-logs.ts`)。分页语义两边对齐(keyset:`ts/id` 倒序,游标 `<ts>:<id>`)。
 *
 * 本域**服务端自有**,不是设备契约 → `packages/contract` 冻结不动。
 */
import type { LogLevel } from './logger.ts';

/** 落库/查询的一行日志(结构化列)。 */
export interface LogRow {
  /** unix ms */
  ts: number;
  level: LogLevel;
  /** 源标记(如 `http`/`mqtt`);无则 null */
  src: string | null;
  msg: string;
  /** 其余结构化字段(ts/level/src/msg 之外的) */
  payload: Record<string, unknown>;
}

/** 查询条件(全部可选;AND 组合)。 */
export interface LogQuery {
  /** 级别白名单(命中其一即可) */
  levels?: readonly LogLevel[];
  /** 精确匹配来源 */
  src?: string;
  /** `msg` 子串(大小写不敏感) */
  q?: string;
  /** 时间下界(含),unix ms */
  from?: number;
  /** 时间上界(含),unix ms */
  to?: number;
  /** 页大小(默认 {@link LOG_PAGE_DEFAULT},上限 {@link LOG_PAGE_MAX}) */
  limit?: number;
  /** 不透明游标(keyset 分页;原样回传上一页的 `next_cursor`) */
  cursor?: string;
}

/** 一页结果。`next_cursor` 为 null 表示没有更多。 */
export interface LogPage {
  rows: LogRow[];
  next_cursor: string | null;
}

/** 日志读写口。 */
export interface ServerLogStore {
  /** 追加一批(批插)。失败由调用方(管线)兜底,不在此抛业务错。 */
  append(rows: LogRow[]): Promise<void>;
  /** 查一页(keyset 分页,按 `ts`/`id` 倒序)。 */
  query(q: LogQuery): Promise<LogPage>;
}

/** 页大小默认与上限。 */
export const LOG_PAGE_DEFAULT = 100;
export const LOG_PAGE_MAX = 500;

/** 组游标 —— `<ts>:<id>`(不透明;两实现共用)。 */
export function makeLogCursor(r: { ts: number; id: number }): string {
  return `${r.ts}:${r.id}`;
}

/** 解析游标;非法/缺省 → null(退回首页)。 */
export function parseLogCursor(c: string | undefined | null): { ts: number; id: number } | null {
  if (!c) return null;
  const [t, i] = c.split(':');
  const ts = Number(t);
  const id = Number(i);
  return Number.isFinite(ts) && Number.isFinite(id) ? { ts, id } : null;
}
