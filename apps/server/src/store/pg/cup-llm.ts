/**
 * `PgCupLlmStore` —— `CupLlmStore` 的 Postgres 实现(每杯模型配置 BYOK)。
 *
 * 语义对齐 `MemoryCupLlmStore` / `FileCupLlmStore`:`get` 无行 → null;`delete` 无行 → no-op。
 * `key_enc` 存的是 **AES-256-GCM 密文**(见 core/cup-llm.ts),不是明文 —— SQL 层只当字符串搬。
 */
import type { CupLlmConfig, CupLlmProvider, CupLlmStore } from '../../core/cup-llm.ts';
import { query, queryOne, type Pool } from './pool.ts';

interface CupLlmRow {
  cup_id: string;
  provider: string;
  model: string;
  base_url: string | null;
  key_enc: string;
  updated_at: number;
}

function toConfig(r: CupLlmRow): CupLlmConfig {
  const c: CupLlmConfig = {
    cup_id: r.cup_id,
    provider: r.provider as CupLlmProvider,
    model: r.model,
    key_enc: r.key_enc,
    updated_at: r.updated_at,
  };
  if (r.base_url !== null) c.base_url = r.base_url;
  return c;
}

export class PgCupLlmStore implements CupLlmStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async get(cupId: string): Promise<CupLlmConfig | null> {
    const row = await queryOne<CupLlmRow>(
      this.pool,
      `SELECT cup_id, provider, model, base_url, key_enc, updated_at FROM cup_llm WHERE cup_id = $1`,
      [cupId],
    );
    return row ? toConfig(row) : null;
  }

  async set(cupId: string, cfg: CupLlmConfig): Promise<void> {
    await query(
      this.pool,
      `INSERT INTO cup_llm (cup_id, provider, model, base_url, key_enc, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (cup_id) DO UPDATE SET
         provider = EXCLUDED.provider, model = EXCLUDED.model,
         base_url = EXCLUDED.base_url, key_enc = EXCLUDED.key_enc,
         updated_at = EXCLUDED.updated_at`,
      [cupId, cfg.provider, cfg.model, cfg.base_url ?? null, cfg.key_enc, cfg.updated_at],
    );
  }

  async delete(cupId: string): Promise<void> {
    await query(this.pool, `DELETE FROM cup_llm WHERE cup_id = $1`, [cupId]);
  }

  async flush(): Promise<void> {
    // Postgres 实现无内存缓冲 → no-op
  }
}
