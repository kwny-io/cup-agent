/**
 * 社交域存储 —— `AccountsStore` 的**内存**与**文件**两个实现(照 ChatStore 手法)。
 *
 * 跨天不丢的口径同 ADR T14:单进程、查询只有"按 id/邮箱取一个" → 一个 JSON 文件足够。
 * 文件实现复用 `JsonFile` 基类(去抖 + tmp+rename 原子写),与 state.json 同一套机制。
 *
 * **绝不出口 salt/hash**:本文件只在账号内部存解密所需字段;出口一律走 `toPublicUser`。
 */
import { join } from 'node:path';
import { JsonFile } from '../persist-file.ts';
import {
  friendPair,
  normalizeEmail,
  type Account,
  type AccountsStore,
  type CupClaim,
  type Friendship,
  type PackStatus,
  type PersonaPack,
  type Session,
} from './types.ts';

interface SocialState {
  accounts: Record<string, Account>;
  /** token → 会话 */
  sessions: Record<string, Session>;
  packs: Record<string, PersonaPack>;
  /** userId → 已订阅 packId 列表 */
  subscriptions: Record<string, string[]>;
  friends: Friendship[];
  /** device_id → claim(可信绑定;PK=device_id,见 types.ts 的 CupClaim 注) */
  claims: Record<string, CupClaim>;
}

function emptyState(): SocialState {
  return { accounts: {}, sessions: {}, packs: {}, subscriptions: {}, friends: [], claims: {} };
}

function friendKey(a: string, b: string): string {
  const [x, y] = friendPair(a, b);
  return `${x}|${y}`;
}

// ── 内存实现 ─────────────────────────────────────────────────────

export class MemoryAccountsStore implements AccountsStore {
  private accounts = new Map<string, Account>(); // userId → account
  private byEmail = new Map<string, string>(); // email → userId
  private sessions = new Map<string, Session>(); // token → session
  private packs = new Map<string, PersonaPack>();
  private subs = new Map<string, Set<string>>(); // userId → packIds
  private friendEdges = new Map<string, Friendship>(); // pairKey → friendship
  private claims = new Map<string, CupClaim>(); // deviceId → claim

  async createAccount(a: Account): Promise<void> {
    this.accounts.set(a.user_id, a);
    this.byEmail.set(normalizeEmail(a.email), a.user_id);
  }

  async accountByEmail(email: string): Promise<Account | null> {
    const id = this.byEmail.get(normalizeEmail(email));
    return id ? (this.accounts.get(id) ?? null) : null;
  }

  async accountById(id: string): Promise<Account | null> {
    return this.accounts.get(id) ?? null;
  }

  async listAccounts(): Promise<Account[]> {
    return [...this.accounts.values()].sort((x, y) => x.created_at - y.created_at);
  }

  async setDisabled(id: string, v: boolean): Promise<void> {
    const a = this.accounts.get(id);
    if (a) this.accounts.set(id, { ...a, disabled: v });
  }

  async setCup(id: string, cupId: string | null): Promise<void> {
    const a = this.accounts.get(id);
    if (!a) return;
    if (cupId === null) {
      const { cup_id: _drop, ...rest } = a;
      this.accounts.set(id, rest);
    } else {
      this.accounts.set(id, { ...a, cup_id: cupId });
    }
  }

  async putSession(s: Session): Promise<void> {
    this.sessions.set(s.token, s);
  }

  async session(token: string): Promise<Session | null> {
    return this.sessions.get(token) ?? null;
  }

  async dropSession(token: string): Promise<void> {
    this.sessions.delete(token);
  }

  async createPack(p: PersonaPack): Promise<void> {
    this.packs.set(p.pack_id, p);
  }

  async packById(id: string): Promise<PersonaPack | null> {
    return this.packs.get(id) ?? null;
  }

  async listPacks(status?: PackStatus): Promise<PersonaPack[]> {
    const all = [...this.packs.values()].sort((x, y) => y.created_at - x.created_at);
    return status ? all.filter((p) => p.status === status) : all;
  }

  async setPackStatus(id: string, status: PackStatus): Promise<void> {
    const p = this.packs.get(id);
    if (p) this.packs.set(id, { ...p, status });
  }

  async subscribe(userId: string, packId: string): Promise<void> {
    const set = this.subs.get(userId) ?? new Set<string>();
    set.add(packId);
    this.subs.set(userId, set);
  }

  async subscriptions(userId: string): Promise<string[]> {
    return [...(this.subs.get(userId) ?? new Set<string>())];
  }

  async addFriend(a: string, b: string): Promise<void> {
    if (a === b) return;
    const [x, y] = friendPair(a, b);
    this.friendEdges.set(friendKey(a, b), { a_user_id: x, b_user_id: y, created_at: Date.now() });
  }

  async friends(userId: string): Promise<string[]> {
    const out: string[] = [];
    for (const f of this.friendEdges.values()) {
      if (f.a_user_id === userId) out.push(f.b_user_id);
      else if (f.b_user_id === userId) out.push(f.a_user_id);
    }
    return out;
  }

  async putClaim(c: CupClaim): Promise<void> {
    this.claims.set(c.device_id, c);
  }

  async claimByDevice(deviceId: string): Promise<CupClaim | null> {
    return this.claims.get(deviceId) ?? null;
  }

  async claimsByCup(cupId: string): Promise<CupClaim[]> {
    return [...this.claims.values()].filter((c) => c.cup_id === cupId);
  }

  async markClaimUsed(deviceId: string, usedAt: number): Promise<void> {
    const c = this.claims.get(deviceId);
    if (c && c.used_at === undefined) this.claims.set(deviceId, { ...c, used_at: usedAt });
  }

  async flush(): Promise<void> {
    // 内存实现无持久,no-op
  }
}

// ── 文件实现 ─────────────────────────────────────────────────────

export class FileAccountsStore implements AccountsStore {
  private readonly file: JsonFile<SocialState>;

  constructor(dir: string) {
    this.file = new JsonFile<SocialState>(join(dir, 'social.json'), emptyState(), (p) => ({
      accounts: p.accounts ?? {},
      sessions: p.sessions ?? {},
      packs: p.packs ?? {},
      subscriptions: p.subscriptions ?? {},
      friends: p.friends ?? [],
      claims: p.claims ?? {},
    }));
  }

  // JsonFile 暴露 `data` 访问器(改完 flushSoon);这里起个短名免得满屏 this.file.data
  private get s(): SocialState {
    return this.file.data;
  }

  async createAccount(a: Account): Promise<void> {
    this.s.accounts[a.user_id] = a;
    this.file.flushSoon();
  }

  async accountByEmail(email: string): Promise<Account | null> {
    const target = normalizeEmail(email);
    for (const a of Object.values(this.s.accounts)) {
      if (normalizeEmail(a.email) === target) return a;
    }
    return null;
  }

  async accountById(id: string): Promise<Account | null> {
    return this.s.accounts[id] ?? null;
  }

  async listAccounts(): Promise<Account[]> {
    return Object.values(this.s.accounts).sort((x, y) => x.created_at - y.created_at);
  }

  async setDisabled(id: string, v: boolean): Promise<void> {
    const a = this.s.accounts[id];
    if (a) {
      this.s.accounts[id] = { ...a, disabled: v };
      this.file.flushSoon();
    }
  }

  async setCup(id: string, cupId: string | null): Promise<void> {
    const a = this.s.accounts[id];
    if (!a) return;
    if (cupId === null) {
      const { cup_id: _drop, ...rest } = a;
      this.s.accounts[id] = rest;
    } else {
      this.s.accounts[id] = { ...a, cup_id: cupId };
    }
    this.file.flushSoon();
  }

  async putSession(s: Session): Promise<void> {
    this.s.sessions[s.token] = s;
    this.file.flushSoon();
  }

  async session(token: string): Promise<Session | null> {
    return this.s.sessions[token] ?? null;
  }

  async dropSession(token: string): Promise<void> {
    if (this.s.sessions[token]) {
      delete this.s.sessions[token];
      this.file.flushSoon();
    }
  }

  async createPack(p: PersonaPack): Promise<void> {
    this.s.packs[p.pack_id] = p;
    this.file.flushSoon();
  }

  async packById(id: string): Promise<PersonaPack | null> {
    return this.s.packs[id] ?? null;
  }

  async listPacks(status?: PackStatus): Promise<PersonaPack[]> {
    const all = Object.values(this.s.packs).sort((x, y) => y.created_at - x.created_at);
    return status ? all.filter((p) => p.status === status) : all;
  }

  async setPackStatus(id: string, status: PackStatus): Promise<void> {
    const p = this.s.packs[id];
    if (p) {
      this.s.packs[id] = { ...p, status };
      this.file.flushSoon();
    }
  }

  async subscribe(userId: string, packId: string): Promise<void> {
    const cur = this.s.subscriptions[userId] ?? [];
    if (!cur.includes(packId)) {
      this.s.subscriptions[userId] = cur.concat(packId);
      this.file.flushSoon();
    }
  }

  async subscriptions(userId: string): Promise<string[]> {
    return [...(this.s.subscriptions[userId] ?? [])];
  }

  async addFriend(a: string, b: string): Promise<void> {
    if (a === b) return;
    const key = friendKey(a, b);
    if (this.s.friends.some((f) => friendKey(f.a_user_id, f.b_user_id) === key)) return;
    const [x, y] = friendPair(a, b);
    this.s.friends.push({ a_user_id: x, b_user_id: y, created_at: Date.now() });
    this.file.flushSoon();
  }

  async friends(userId: string): Promise<string[]> {
    const out: string[] = [];
    for (const f of this.s.friends) {
      if (f.a_user_id === userId) out.push(f.b_user_id);
      else if (f.b_user_id === userId) out.push(f.a_user_id);
    }
    return out;
  }

  async putClaim(c: CupClaim): Promise<void> {
    this.s.claims[c.device_id] = c;
    this.file.flushSoon();
  }

  async claimByDevice(deviceId: string): Promise<CupClaim | null> {
    return this.s.claims[deviceId] ?? null;
  }

  async claimsByCup(cupId: string): Promise<CupClaim[]> {
    return Object.values(this.s.claims).filter((c) => c.cup_id === cupId);
  }

  async markClaimUsed(deviceId: string, usedAt: number): Promise<void> {
    const c = this.s.claims[deviceId];
    if (c && c.used_at === undefined) {
      this.s.claims[deviceId] = { ...c, used_at: usedAt };
      this.file.flushSoon();
    }
  }

  async flush(): Promise<void> {
    await this.file.flush();
  }
}
