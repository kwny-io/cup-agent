/**
 * 分享卡「邀请码 → 归属边」—— D4 单边裂变的最小地基(设计稿 §3.3 / §3.4)。
 *
 * ── 目的边界(别与 claim 混)────────────────────────────────────────
 * `claim` 是**设备可信绑定**(不透明、单向哈希、明文码只给设备);本码是**分享拉新**
 * (必须可读、可粘贴、拼进 URL)。两者目的不同 → 各立一套(设计稿 Q6 已拍「不共用」)。
 *
 * ── 为什么独立 store(照 active-pack 先例)──────────────────────────
 * 只存**关系**(码 → 邀请人、被邀请人 → 码),不碰账号/好友。这样内存实现独立于
 * accounts 数据源,三实现语义一致(只换实现、不动上层),路由侧消费无感。
 *
 * ── 语义边界 ─────────────────────────────────────────────────────
 *   · 一邀请人**多枚码**(每次分享一枚 → 可追踪哪次分享带来的):`mint` 只增不覆盖。
 *   · 被邀请人**首触归因**(一生只算一次):`recordJoin` 对同一 invitee 幂等,不覆盖。
 *   · 归因**单向、不需双向确认**(A 分享 → B 来即成立),不要求 A/B 互为好友(那是 v1)。
 *
 * 隐私:归属边是敏感关系,出口层须明示「谁邀请的」且可查可删(设计稿 §3.3);账号注销时
 * 由 `deleteAccount` 连带清两侧(见 store/pg/accounts.ts)。
 *
 * strip-only 约束:无 enum、无参数属性,全显式字段。
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from './persist.ts';

/** Crockford Base32(恰 32 字符;无 I/L/O/U)—— 与 claim 共用字母表,但**码长与用途不同** */
export const INVITE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/**
 * 码长(字符数)。选 10 = 50 bit:
 *   · 可读可粘贴(比 claim 的 8 稍长,因为要印在卡上/URL 里,肉眼可核对);
 *   · 50 bit 随机空间下,万级码量碰撞率仍 ~10⁻⁷ —— 且 `mint` 有冲突重试兜底。
 */
export const INVITE_LEN = 10;

/** 生成一枚邀请码(纯随机,50 bit 空间)。唯一性由 `mint` 落库时把关。 */
export function newInviteCode(): string {
  const bytes = randomBytes(INVITE_LEN);
  let out = '';
  for (let i = 0; i < INVITE_LEN; i++) out += INVITE_ALPHABET[bytes[i]! % 32];
  return out;
}

/**
 * 规范化邀请码(粘贴可能带空格/连字符/大小写/Crockford 容错 I→1 O→0)。
 * @returns 规范化后的 10 串;形状不合法 → null。
 */
export function normalizeInviteCode(input: string): string | null {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '-' || ch === '_') {
      continue;
    }
    let c = ch >= 'a' && ch <= 'z' ? String.fromCharCode(ch.charCodeAt(0) - 32) : ch;
    if (c === 'I' || c === 'L') c = '1';
    else if (c === 'O') c = '0';
    out += c;
  }
  if (out.length !== INVITE_LEN) return null;
  for (let i = 0; i < out.length; i++) {
    if (!INVITE_ALPHABET.includes(out[i]!)) return null;
  }
  return out;
}

// ── 存储口(接口 + 内存/文件两实现)─────────────────────────────

/** 一条归属边(被邀请人 → 邀请人) */
export interface InviteJoin {
  invitee_user_id: string;
  code: string;
  inviter_user_id: string;
  joined_at: number;
}

export interface InviteStore {
  /** 为一枚新分享生成并存一枚码(一人多码);返回可直接用/粘贴的明文码。冲突自动重试。 */
  mint(inviterUserId: string): Promise<string>;
  /** 码 → 邀请人 id;查无 → null。 */
  owner(code: string): Promise<string | null>;
  /** 记一条首触归属边(被邀请人幂等:已有则不覆盖)。 */
  recordJoin(inviteeUserId: string, inviterUserId: string, code: string): Promise<void>;
  /** 该被邀请人的归属边(用于"可查");无 → null。 */
  joinOf(inviteeUserId: string): Promise<InviteJoin | null>;
  /** 该邀请人拉来的被邀请人 id 列表(转化率分子);无 → []。 */
  invitedBy(inviterUserId: string): Promise<string[]>;
  flush(): Promise<void>;
}

export class MemoryInviteStore implements InviteStore {
  private codes = new Map<string, string>(); // code → inviterUserId
  private joins = new Map<string, InviteJoin>(); // inviteeUserId → join

  async mint(inviterUserId: string): Promise<string> {
    let code = newInviteCode();
    while (this.codes.has(code)) code = newInviteCode();
    this.codes.set(code, inviterUserId);
    return code;
  }
  async owner(code: string): Promise<string | null> {
    return this.codes.get(code) ?? null;
  }
  async recordJoin(inviteeUserId: string, inviterUserId: string, code: string): Promise<void> {
    if (this.joins.has(inviteeUserId)) return; // 首触归因,不覆盖
    this.joins.set(inviteeUserId, {
      invitee_user_id: inviteeUserId,
      code,
      inviter_user_id: inviterUserId,
      joined_at: Date.now(),
    });
  }
  async joinOf(inviteeUserId: string): Promise<InviteJoin | null> {
    return this.joins.get(inviteeUserId) ?? null;
  }
  async invitedBy(inviterUserId: string): Promise<string[]> {
    const out: string[] = [];
    for (const j of this.joins.values()) {
      if (j.inviter_user_id === inviterUserId) out.push(j.invitee_user_id);
    }
    return out;
  }
  async flush(): Promise<void> {
    // 内存实现无持久,no-op
  }
}

/**
 * 文件实现:整体落 `invite.json`(独立文件,与 state.json / active-pack.json 同套原子写)。
 */
export class FileInviteStore implements InviteStore {
  private readonly path: string;
  private readonly codes: Map<string, string>;
  private readonly joins: Map<string, InviteJoin>;

  constructor(path: string) {
    this.path = path;
    this.codes = new Map();
    this.joins = new Map();
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as {
        codes?: Record<string, string>;
        joins?: Record<string, InviteJoin>;
      };
      for (const [k, v] of Object.entries(raw.codes ?? {})) this.codes.set(k, v);
      for (const [k, v] of Object.entries(raw.joins ?? {})) this.joins.set(k, v);
    } catch {
      // 文件不存在 / 损坏 → 空起(不该让服务起不来)
    }
  }

  async mint(inviterUserId: string): Promise<string> {
    let code = newInviteCode();
    while (this.codes.has(code)) code = newInviteCode();
    this.codes.set(code, inviterUserId);
    this.save();
    return code;
  }
  async owner(code: string): Promise<string | null> {
    return this.codes.get(code) ?? null;
  }
  async recordJoin(inviteeUserId: string, inviterUserId: string, code: string): Promise<void> {
    if (this.joins.has(inviteeUserId)) return;
    this.joins.set(inviteeUserId, {
      invitee_user_id: inviteeUserId,
      code,
      inviter_user_id: inviterUserId,
      joined_at: Date.now(),
    });
    this.save();
  }
  async joinOf(inviteeUserId: string): Promise<InviteJoin | null> {
    return this.joins.get(inviteeUserId) ?? null;
  }
  async invitedBy(inviterUserId: string): Promise<string[]> {
    const out: string[] = [];
    for (const j of this.joins.values()) {
      if (j.inviter_user_id === inviterUserId) out.push(j.invitee_user_id);
    }
    return out;
  }
  async flush(): Promise<void> {
    this.save();
  }
  private save(): void {
    atomicWriteJson(this.path, {
      codes: Object.fromEntries(this.codes),
      joins: Object.fromEntries(this.joins),
    });
  }
}

/** 文件实现的默认落点:`<dataDir>/invite.json` */
export function inviteFilePath(dataDir: string): string {
  return join(dataDir, 'invite.json');
}
