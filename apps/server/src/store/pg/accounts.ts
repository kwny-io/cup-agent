/**
 * `PgAccountsStore` —— `AccountsStore` 的 Postgres 实现（账号 / 会话 / 市场 / 好友）。
 *
 * 语义对齐 `MemoryAccountsStore`：
 *   · `accountByEmail` 走 `lower(email)` 唯一索引（不再 O(n) 线性扫）；
 *   · `addFriend` 规范 (a<b) 存一份、幂等；`friends` 双向取；
 *   · `subscribe` 幂等（PK 去重）。
 * `setCup(id, null)` = 解绑 → `cup_id = NULL`（对齐 memory 的"删字段"）。
 */
import type { Account, AccountsStore, CupClaim, PackStatus, PersonaPack, Session } from '../../core/social/types.ts';
import { normalizeEmail } from '../../core/social/types.ts';
import { query, queryOne, withTransaction, type Pool } from './pool.ts';

interface UserRow {
  user_id: string;
  email: string;
  nickname: string;
  salt: string;
  hash: string;
  role: string;
  created_at: number;
  disabled: boolean;
  cup_id: string | null;
}

function toAccount(r: UserRow): Account {
  const a: Account = {
    user_id: r.user_id,
    email: r.email,
    nickname: r.nickname,
    salt: r.salt,
    hash: r.hash,
    role: r.role as Account['role'],
    created_at: r.created_at,
  };
  if (r.disabled) a.disabled = true;
  if (r.cup_id !== null) a.cup_id = r.cup_id;
  return a;
}

interface PackRow {
  pack_id: string;
  author_user_id: string;
  name: string;
  tone: string;
  thresholds: Record<string, number>;
  wave: Record<string, number>;
  lines: string[];
  status: string;
  created_at: number;
}

function toPack(r: PackRow): PersonaPack {
  return {
    pack_id: r.pack_id,
    author_user_id: r.author_user_id,
    name: r.name,
    tone: r.tone,
    thresholds: r.thresholds,
    wave: r.wave,
    lines: r.lines,
    status: r.status as PackStatus,
    created_at: r.created_at,
  };
}

interface ClaimRow {
  device_id: string;
  cup_id: string;
  claim_hash: string;
  issued_at: number;
  expires_at: number;
  used_at: number | null;
}

function toClaim(r: ClaimRow): CupClaim {
  const c: CupClaim = {
    device_id: r.device_id,
    cup_id: r.cup_id,
    claim_hash: r.claim_hash,
    issued_at: r.issued_at,
    expires_at: r.expires_at,
  };
  // 可选字段口径对齐 memory/file：「未用」= 字段缺席，而非 undefined 值
  if (r.used_at !== null) c.used_at = r.used_at;
  return c;
}

export class PgAccountsStore implements AccountsStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  // ── 账号 ───────────────────────────────────────────────────────

  async createAccount(a: Account): Promise<void> {
    await query(
      this.pool,
      `INSERT INTO users (user_id, email, nickname, salt, hash, role, created_at, disabled, cup_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id) DO UPDATE SET
         email = EXCLUDED.email, nickname = EXCLUDED.nickname,
         salt = EXCLUDED.salt, hash = EXCLUDED.hash, role = EXCLUDED.role,
         disabled = EXCLUDED.disabled, cup_id = EXCLUDED.cup_id`,
      [
        a.user_id,
        a.email,
        a.nickname,
        a.salt,
        a.hash,
        a.role,
        a.created_at,
        a.disabled === true,
        a.cup_id ?? null,
      ],
    );
  }

  async accountByEmail(email: string): Promise<Account | null> {
    const row = await queryOne<UserRow>(
      this.pool,
      `SELECT * FROM users WHERE lower(email) = $1`,
      [normalizeEmail(email)],
    );
    return row ? toAccount(row) : null;
  }

  async accountById(id: string): Promise<Account | null> {
    const row = await queryOne<UserRow>(this.pool, `SELECT * FROM users WHERE user_id = $1`, [id]);
    return row ? toAccount(row) : null;
  }

  async listAccounts(): Promise<Account[]> {
    const rows = await query<UserRow>(this.pool, `SELECT * FROM users ORDER BY created_at`);
    return rows.map(toAccount);
  }

  async setDisabled(id: string, v: boolean): Promise<void> {
    await query(this.pool, `UPDATE users SET disabled = $2 WHERE user_id = $1`, [id, v]);
  }

  async setCup(id: string, cupId: string | null): Promise<void> {
    await query(this.pool, `UPDATE users SET cup_id = $2 WHERE user_id = $1`, [id, cupId]);
  }

  async deleteAccount(id: string): Promise<void> {
    // 订阅/好友表没有 users 外键(见 0001:只有 sessions 有 ON DELETE CASCADE)→ 显式清。
    // 全部收在一个事务里:账号删了但好友边留着 = 悬垂数据(好友列表会指向不存在的 user)。
    await withTransaction(this.pool, async (client) => {
      await client.query(`DELETE FROM subscriptions WHERE user_id = $1`, [id]);
      await client.query(`DELETE FROM friends WHERE a_user_id = $1 OR b_user_id = $1`, [id]);
      await client.query(`DELETE FROM users WHERE user_id = $1`, [id]);
    });
  }

  async dropSessionsForUser(userId: string): Promise<void> {
    await query(this.pool, `DELETE FROM sessions WHERE user_id = $1`, [userId]);
  }

  // ── 会话 ───────────────────────────────────────────────────────

  async putSession(s: Session): Promise<void> {
    await query(
      this.pool,
      `INSERT INTO sessions (token, user_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (token) DO UPDATE SET
         user_id = EXCLUDED.user_id, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at`,
      [s.token, s.user_id, s.created_at, s.expires_at],
    );
  }

  async session(token: string): Promise<Session | null> {
    const row = await queryOne<Session>(
      this.pool,
      `SELECT token, user_id, created_at, expires_at FROM sessions WHERE token = $1`,
      [token],
    );
    return row ?? null;
  }

  async dropSession(token: string): Promise<void> {
    await query(this.pool, `DELETE FROM sessions WHERE token = $1`, [token]);
  }

  // ── 市场包 ─────────────────────────────────────────────────────

  async createPack(p: PersonaPack): Promise<void> {
    await query(
      this.pool,
      `INSERT INTO packs (pack_id, author_user_id, name, tone, thresholds, wave, lines, status, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)
       ON CONFLICT (pack_id) DO UPDATE SET
         name = EXCLUDED.name, tone = EXCLUDED.tone,
         thresholds = EXCLUDED.thresholds, wave = EXCLUDED.wave, lines = EXCLUDED.lines,
         status = EXCLUDED.status`,
      [
        p.pack_id,
        p.author_user_id,
        p.name,
        p.tone,
        JSON.stringify(p.thresholds),
        JSON.stringify(p.wave),
        JSON.stringify(p.lines),
        p.status,
        p.created_at,
      ],
    );
  }

  async packById(id: string): Promise<PersonaPack | null> {
    const row = await queryOne<PackRow>(this.pool, `SELECT * FROM packs WHERE pack_id = $1`, [id]);
    return row ? toPack(row) : null;
  }

  async listPacks(status?: PackStatus): Promise<PersonaPack[]> {
    const rows = status
      ? await query<PackRow>(
          this.pool,
          `SELECT * FROM packs WHERE status = $1 ORDER BY created_at DESC`,
          [status],
        )
      : await query<PackRow>(this.pool, `SELECT * FROM packs ORDER BY created_at DESC`);
    return rows.map(toPack);
  }

  async setPackStatus(id: string, status: PackStatus): Promise<void> {
    await query(this.pool, `UPDATE packs SET status = $2 WHERE pack_id = $1`, [id, status]);
  }

  // ── 订阅 ───────────────────────────────────────────────────────

  async subscribe(userId: string, packId: string): Promise<void> {
    await query(
      this.pool,
      `INSERT INTO subscriptions (user_id, pack_id) VALUES ($1, $2)
       ON CONFLICT (user_id, pack_id) DO NOTHING`,
      [userId, packId],
    );
  }

  async subscriptions(userId: string): Promise<string[]> {
    const rows = await query<{ pack_id: string }>(
      this.pool,
      `SELECT pack_id FROM subscriptions WHERE user_id = $1`,
      [userId],
    );
    return rows.map((r) => r.pack_id);
  }

  // ── 好友（规范 a<b 存一份）─────────────────────────────────────

  async addFriend(a: string, b: string): Promise<void> {
    if (a === b) return;
    const [x, y] = a <= b ? [a, b] : [b, a];
    await query(
      this.pool,
      `INSERT INTO friends (a_user_id, b_user_id, created_at) VALUES ($1, $2, $3)
       ON CONFLICT (a_user_id, b_user_id) DO NOTHING`,
      [x, y, Date.now()],
    );
  }

  async friends(userId: string): Promise<string[]> {
    const rows = await query<{ peer: string }>(
      this.pool,
      `SELECT CASE WHEN a_user_id = $1 THEN b_user_id ELSE a_user_id END AS peer
         FROM friends
        WHERE a_user_id = $1 OR b_user_id = $1`,
      [userId],
    );
    return rows.map((r) => r.peer);
  }

  // ── 可信绑定（claim code，风险 R18）─────────────────────────────
  // 表 `cup_claims` 见 migrations/0003_claim_code.sql。**PK = device_id**：双形体（杯盖+底座）
  // 共用 cup_id、device_id 不同，两行共存。这里的 upsert 是"盲写"——「首哈希为准 / 已有活跃码
  // 忽略后续 hello」的裁定在 `ClaimService.noteHello`，store 只负责落库（与 memory/file 实现同立场）。

  async putClaim(c: CupClaim): Promise<void> {
    // ON CONFLICT 覆盖：ClaimService 只在"旧码已用或已过期"时才走到这里，覆盖是安全的。
    // used_at 用 COALESCE 保底——若调用方传的 c 带 used_at 则用，否则显式置 NULL（防止列上残留旧值）。
    await query(
      this.pool,
      `INSERT INTO cup_claims (device_id, cup_id, claim_hash, issued_at, expires_at, used_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (device_id) DO UPDATE SET
         cup_id = EXCLUDED.cup_id, claim_hash = EXCLUDED.claim_hash,
         issued_at = EXCLUDED.issued_at, expires_at = EXCLUDED.expires_at,
         used_at = EXCLUDED.used_at`,
      [c.device_id, c.cup_id, c.claim_hash, c.issued_at, c.expires_at, c.used_at ?? null],
    );
  }

  async claimByDevice(deviceId: string): Promise<CupClaim | null> {
    const row = await queryOne<ClaimRow>(
      this.pool,
      `SELECT device_id, cup_id, claim_hash, issued_at, expires_at, used_at
         FROM cup_claims WHERE device_id = $1`,
      [deviceId],
    );
    return row ? toClaim(row) : null;
  }

  async claimsByCup(cupId: string): Promise<CupClaim[]> {
    const rows = await query<ClaimRow>(
      this.pool,
      `SELECT device_id, cup_id, claim_hash, issued_at, expires_at, used_at
         FROM cup_claims WHERE cup_id = $1`,
      [cupId],
    );
    return rows.map(toClaim);
  }

  async markClaimUsed(deviceId: string, usedAt: number): Promise<void> {
    // 只在 used_at IS NULL 时打戳 —— **不复活**已用行（对齐 memory 的 `if (c && c.used_at === undefined)`）。
    await query(
      this.pool,
      `UPDATE cup_claims SET used_at = $2 WHERE device_id = $1 AND used_at IS NULL`,
      [deviceId, usedAt],
    );
  }

  async flush(): Promise<void> {
    // Postgres 实现无内存缓冲，每次写都已落库 → no-op
  }
}
