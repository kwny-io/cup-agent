/**
 * `PgProfileStore` —— `ProfileStore` 的 Postgres 实现（人格档案：昵称 + 派生性格快照）。
 *
 * 语义对齐 `MemoryProfileStore` / `FileProfileStore`：`get` 无行 → null。
 * 只存派生性格（5 数值 + 时刻），不存原始曲线、不存 `reason` 自由文本（隐私口径，见 traits.ts）。
 */
import type { ProfileStore } from '../../core/traits.ts';
import type { ProfileRecord } from '../../core/persist.ts';
import { query, queryOne, type Pool } from './pool.ts';

interface TraitRow {
  nickname: string;
  traits: ProfileRecord['traits'];
}

export class PgProfileStore implements ProfileStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async get(cupId: string): Promise<ProfileRecord | null> {
    const row = await queryOne<TraitRow>(
      this.pool,
      `SELECT nickname, traits FROM cup_traits WHERE cup_id = $1`,
      [cupId],
    );
    return row ? { nickname: row.nickname, traits: row.traits } : null;
  }

  async set(cupId: string, r: ProfileRecord): Promise<void> {
    await query(
      this.pool,
      `INSERT INTO cup_traits (cup_id, nickname, traits) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (cup_id) DO UPDATE SET nickname = EXCLUDED.nickname, traits = EXCLUDED.traits`,
      [cupId, r.nickname, JSON.stringify(r.traits)],
    );
  }

  async delete(cupId: string): Promise<void> {
    await query(this.pool, `DELETE FROM cup_traits WHERE cup_id = $1`, [cupId]);
  }

  async flush(): Promise<void> {
    // Postgres 实现无内存缓冲 → no-op
  }
}
