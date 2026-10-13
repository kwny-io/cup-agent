/**
 * `PgChatStore` —— `ChatStore` 的 Postgres 实现（对话轮 + 长期画像）。
 *
 * 语义对齐 `MemoryChatStore` / `capTurns` / `windowTurns`：
 *   · `appendTurn` 后**裁剪到 `MAX_TURNS_PER_CUP`**（每杯只留最近 200 轮）—— 内存版
 *     在 `capTurns` 里做；这里 append 后删掉超出的老行（`id` 升序保留尾部）。
 *   · `recentTurns` 取最近 `limit` 轮（插入序），再走 `windowTurns` 做**字节封顶**。
 *   · `profile` / `lastDistilledAt` 并在一行 `chat_profile`（无行 → null / 0）。
 *
 * 为什么要裁：不裁的话 `chat_turns` 无限长，与"每杯最多 200 轮"的既有口径不符。
 */
import {
  capTurns,
  MAX_TURNS_PER_CUP,
  windowTurns,
  type ChatStore,
  type ChatTurnRecord,
} from '../../core/chat/memory.ts';
import { query, queryOne, type Pool } from './pool.ts';

interface TurnRow {
  cup_id: string;
  ts: number;
  role: string;
  text: string;
  tools_used: string[] | null;
  source: string | null;
}

function toTurn(r: TurnRow): ChatTurnRecord {
  const t: ChatTurnRecord = { cup_id: r.cup_id, ts: r.ts, role: r.role as ChatTurnRecord['role'], text: r.text };
  if (r.tools_used) t.tools_used = r.tools_used;
  if (r.source) t.source = r.source as ChatTurnRecord['source'];
  return t;
}

export class PgChatStore implements ChatStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async appendTurn(t: ChatTurnRecord): Promise<void> {
    await query(
      this.pool,
      `INSERT INTO chat_turns (cup_id, ts, role, text, tools_used, source)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        t.cup_id,
        t.ts,
        t.role,
        t.text,
        t.tools_used ? JSON.stringify(t.tools_used) : null,
        t.source ?? null,
      ],
    );
    // 裁剪：只留该杯最近 MAX_TURNS_PER_CUP 条（按插入序，id 大者新）
    await query(
      this.pool,
      `DELETE FROM chat_turns
        WHERE cup_id = $1
          AND id NOT IN (
            SELECT id FROM chat_turns WHERE cup_id = $1 ORDER BY id DESC LIMIT ${MAX_TURNS_PER_CUP}
          )`,
      [t.cup_id],
    );
  }

  async recentTurns(cupId: string, limit: number): Promise<ChatTurnRecord[]> {
    // 先按插入序取最近 limit 条（倒序取再翻正），再交给 windowTurns 做字节封顶
    const rows = await query<TurnRow>(
      this.pool,
      `SELECT cup_id, ts, role, text, tools_used, source
         FROM chat_turns WHERE cup_id = $1 ORDER BY id DESC LIMIT $2`,
      [cupId, limit],
    );
    const asc = rows.reverse().map(toTurn);
    return windowTurns(asc, limit);
  }

  async profile(cupId: string): Promise<string | null> {
    const row = await queryOne<{ profile: string }>(
      this.pool,
      `SELECT profile FROM chat_profile WHERE cup_id = $1`,
      [cupId],
    );
    return row?.profile ?? null;
  }

  async setProfile(cupId: string, text: string): Promise<void> {
    await query(
      this.pool,
      `INSERT INTO chat_profile (cup_id, profile, distilled_at) VALUES ($1, $2, 0)
       ON CONFLICT (cup_id) DO UPDATE SET profile = EXCLUDED.profile`,
      [cupId, text],
    );
  }

  async lastDistilledAt(cupId: string): Promise<number> {
    const row = await queryOne<{ distilled_at: number }>(
      this.pool,
      `SELECT distilled_at FROM chat_profile WHERE cup_id = $1`,
      [cupId],
    );
    return row?.distilled_at ?? 0;
  }

  async setLastDistilledAt(cupId: string, ts: number): Promise<void> {
    // 蒸馏时刻可能与画像分开设置；无行时先建一行（profile 空串占位，语义同"尚无画像"）
    await query(
      this.pool,
      `INSERT INTO chat_profile (cup_id, profile, distilled_at) VALUES ($1, '', $2)
       ON CONFLICT (cup_id) DO UPDATE SET distilled_at = EXCLUDED.distilled_at`,
      [cupId, ts],
    );
  }

  async deleteTurns(cupId: string): Promise<void> {
    await query(this.pool, `DELETE FROM chat_turns WHERE cup_id = $1`, [cupId]);
  }

  async deleteProfile(cupId: string): Promise<void> {
    // 画像与蒸馏水位在同一行 chat_profile → 整行删(对齐 memory 版一并抹 distillAt)。
    await query(this.pool, `DELETE FROM chat_profile WHERE cup_id = $1`, [cupId]);
  }

  async flush(): Promise<void> {
    // Postgres 实现无内存缓冲 → no-op
  }
}
