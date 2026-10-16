/**
 * `PgInviteStore` —— `InviteStore`(分享卡邀请码 / 归属边)的 Postgres 实现。
 *
 * 语义对齐 `MemoryInviteStore` / `FileInviteStore`:一人多码、被邀请人首触归因(幂等不覆盖)。
 * 表见 `migrations/0008_invite_codes.sql`(code 表与 join 表分开 —— 理由见该文件头注)。
 */
import type { InviteJoin, InviteStore } from '../../core/invite.ts';
import { newInviteCode } from '../../core/invite.ts';
import { query, queryOne, type Pool } from './pool.ts';

interface JoinRow {
  invitee_user_id: string;
  code: string;
  inviter_user_id: string;
  joined_at: number;
}

export class PgInviteStore implements InviteStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async mint(inviterUserId: string): Promise<string> {
    // 50 bit 空间下冲突极罕见,但 PK 摆着 —— 撞了就换一枚重试(有界,不无限转)。
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newInviteCode();
      const row = await queryOne<{ code: string }>(
        this.pool,
        `INSERT INTO invite_codes (code, inviter_user_id, created_at) VALUES ($1, $2, $3)
         ON CONFLICT (code) DO NOTHING
         RETURNING code`,
        [code, inviterUserId, Date.now()],
      );
      if (row) return row.code;
    }
    throw new Error('invite: 生成邀请码连续 5 次冲突,放弃');
  }

  async owner(code: string): Promise<string | null> {
    const row = await queryOne<{ inviter_user_id: string }>(
      this.pool,
      `SELECT inviter_user_id FROM invite_codes WHERE code = $1`,
      [code],
    );
    return row?.inviter_user_id ?? null;
  }

  async recordJoin(inviteeUserId: string, inviterUserId: string, code: string): Promise<void> {
    // 首触归因:同 invitee 已有边 → DO NOTHING(不覆盖)。
    await query(
      this.pool,
      `INSERT INTO invite_joins (invitee_user_id, code, inviter_user_id, joined_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (invitee_user_id) DO NOTHING`,
      [inviteeUserId, code, inviterUserId, Date.now()],
    );
  }

  async joinOf(inviteeUserId: string): Promise<InviteJoin | null> {
    const row = await queryOne<JoinRow>(
      this.pool,
      `SELECT invitee_user_id, code, inviter_user_id, joined_at
         FROM invite_joins WHERE invitee_user_id = $1`,
      [inviteeUserId],
    );
    return row ?? null;
  }

  async invitedBy(inviterUserId: string): Promise<string[]> {
    const rows = await query<{ invitee_user_id: string }>(
      this.pool,
      `SELECT invitee_user_id FROM invite_joins WHERE inviter_user_id = $1`,
      [inviterUserId],
    );
    return rows.map((r) => r.invitee_user_id);
  }

  async flush(): Promise<void> {
    // Postgres 实现无内存缓冲 → no-op
  }
}
