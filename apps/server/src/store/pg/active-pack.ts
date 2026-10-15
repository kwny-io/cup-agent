/**
 * `PgActivePackStore` —— `CupActivePackStore`(每杯当前生效包)的 Postgres 实现。
 *
 * 语义对齐 `MemoryActivePackStore` / `FileActivePackStore`:`get` 无行 → null;`clear` 无行 → no-op。
 * 表见 `migrations/0007_cup_active_pack.sql`(独立表,不复用 cup_settings —— 理由见该文件头注)。
 */
import type { CupActivePackStore } from '../../core/active-pack.ts';
import { query, queryOne, type Pool } from './pool.ts';

export class PgActivePackStore implements CupActivePackStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async get(cupId: string): Promise<string | null> {
    const row = await queryOne<{ pack_id: string }>(
      this.pool,
      `SELECT pack_id FROM cup_active_pack WHERE cup_id = $1`,
      [cupId],
    );
    return row?.pack_id ?? null;
  }

  async set(cupId: string, packId: string): Promise<void> {
    await query(
      this.pool,
      `INSERT INTO cup_active_pack (cup_id, pack_id) VALUES ($1, $2)
       ON CONFLICT (cup_id) DO UPDATE SET pack_id = EXCLUDED.pack_id`,
      [cupId, packId],
    );
  }

  async clear(cupId: string): Promise<void> {
    await query(this.pool, `DELETE FROM cup_active_pack WHERE cup_id = $1`, [cupId]);
  }

  async flush(): Promise<void> {
    // Postgres 实现无内存缓冲 → no-op
  }
}
