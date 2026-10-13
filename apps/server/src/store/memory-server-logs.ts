/**
 * 内存版日志 store —— 供**零基建**测试(路由单测不接 PG)。
 *
 * 语义与 Pg 版对齐:`id` 递增模拟插入序、keyset 游标 `<ts>:<id>`、`(ts,id)` 倒序、
 * 关键词 `msg` 子串(大小写不敏感)。容量有上限(默认 1 万条),超出丢最旧。
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
} from '../core/log-store.ts';

interface Row extends LogRow {
  id: number;
}

export interface MemoryServerLogOptions {
  /** 容量上限(超出丢最旧);默认 1 万。 */
  capacity?: number;
}

export class MemoryServerLogStore implements ServerLogStore {
  private readonly rows: Row[] = [];
  private nextId = 1;
  private readonly capacity: number;

  constructor(opts: MemoryServerLogOptions = {}) {
    this.capacity = opts.capacity ?? 10_000;
  }

  async append(rows: LogRow[]): Promise<void> {
    for (const r of rows) this.rows.push({ ...r, id: this.nextId++ });
    // 超出上限丢最旧(近处日志更有诊断价值)。
    const over = this.rows.length - this.capacity;
    if (over > 0) this.rows.splice(0, over);
  }

  async query(q: LogQuery): Promise<LogPage> {
    const limit = Math.min(Math.max(1, q.limit ?? LOG_PAGE_DEFAULT), LOG_PAGE_MAX);
    const cursor = parseLogCursor(q.cursor);
    const needle = q.q?.toLowerCase();
    const levels = q.levels && q.levels.length > 0 ? new Set(q.levels) : null;

    const hit = this.rows
      .filter((r) => {
        if (levels && !levels.has(r.level)) return false;
        if (q.src !== undefined && r.src !== q.src) return false;
        if (q.from !== undefined && r.ts < q.from) return false;
        if (q.to !== undefined && r.ts > q.to) return false;
        if (needle && !r.msg.toLowerCase().includes(needle)) return false;
        // keyset:严格小于游标点 (ts,id) 倒序推进
        if (cursor && !(r.ts < cursor.ts || (r.ts === cursor.ts && r.id < cursor.id))) return false;
        return true;
      })
      .sort((a, b) => (b.ts - a.ts) || (b.id - a.id));

    const page = hit.slice(0, limit);
    const last = page[page.length - 1];
    const next_cursor = hit.length > limit && last ? makeLogCursor(last) : null;
    return {
      rows: page.map(({ id: _id, ...rest }) => rest),
      next_cursor,
    };
  }
}
