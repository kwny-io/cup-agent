/**
 * 多用户 / 市场 / 社交的云实现(#72/#73/#74)—— `SocialApi` 的实现体。
 *
 * 为什么单独一个类(而不是全塞进 CloudSource):
 *   · 这块是**拉式 REST**,与 WS 遥测无关 —— 拆开可**单测**(不用起 WebSocket);
 *   · CloudSource 只持一个实例、暴露成 `social`,数据层 5 触点少一处改动。
 *
 * 会话令牌:登录/注册后端回 `{ token }`,存 **sessionStorage**(关标签页即失效,
 * 比 localStorage 收敛;不走 httpOnly cookie —— 现 CORS 是 `*`,带凭证会被浏览器拒,
 * 见 plan §二)。后续请求带 `Authorization: Bearer <token>`。**不落盘、不打日志**。
 *
 * 契约:所有方法**从不 reject**;失败给 null / false / {ok:false}(调用方一条路径处理)。
 */
import type {
  AdminUser,
  AskFailure,
  AuthOutcome,
  BindOutcome,
  CupLlmDraft,
  CupLlmPublic,
  FriendView,
  GrowthSnapshot,
  LogPage,
  LogPartition,
  LogQuery,
  MemoryCard,
  MemoryQuery,
  PackDraft,
  PackStatus,
  PersonaPack,
  PublicUser,
  ServerProfile,
  SocialApi,
  TeamState,
} from './source.ts';
import { isGrowthSnapshot, isMemoryCard } from './source.ts';

/** 会话令牌的存储键(sessionStorage)。命名带前缀,避免与别的站点/组件撞。 */
const SESSION_KEY = 'cup.session';

export interface SocialOptions {
  apiBase: string;
  cupId: string;
  /** 注入 fetch(测试用);缺省用全局 fetch */
  fetchImpl?: typeof fetch;
  /** 注入存储(测试用);缺省 sessionStorage */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /** 写请求超时 ms */
  timeoutMs?: number;
  /**
   * 设备写端点的 API key(R10-B)。**只有** `PUT /cups/:id/profile` 用它 ——
   * 那个端点与 /goal 同属设备写端点(走 x-api-key),其余账号 / 市场 / 社交端点
   * 走 Bearer 会话(见 http.ts 路由分类)。缺省 / 空串 → 不带该头。
   */
  apiKey?: string;
}

interface Res {
  ok: boolean;
  status: number;
  data: unknown;
}

/** 安全读写 sessionStorage(隐私模式 / 不可用时静默,不炸页面) */
function safeSessionStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * 日志查询 → query string(前导 `?`,无筛选则空串)。
 * `level` 多值用逗号分隔(与后端"可重复或逗号"两法都收;逗号更短)。
 * 保留字 `q` 走 encodeURIComponent —— 关键词可能带空格 / 中文。
 */
function logQueryString(q: LogQuery): string {
  const p = new URLSearchParams();
  if (q.level && q.level.length > 0) p.set('level', q.level.join(','));
  if (q.src) p.set('src', q.src);
  if (q.q) p.set('q', q.q);
  if (typeof q.from === 'number') p.set('from', String(q.from));
  if (typeof q.to === 'number') p.set('to', String(q.to));
  if (typeof q.limit === 'number') p.set('limit', String(q.limit));
  if (q.cursor) p.set('cursor', q.cursor);
  const s = p.toString();
  return s === '' ? '' : `?${s}`;
}

export class CloudSocial implements SocialApi {
  private readonly apiBase: string;
  private readonly cupId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  private readonly timeoutMs: number;
  private readonly apiKey: string;

  constructor(opts: SocialOptions) {
    this.apiBase = opts.apiBase.replace(/\/+$/, '');
    this.cupId = opts.cupId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.storage = opts.storage === undefined ? safeSessionStorage() : opts.storage;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.apiKey = opts.apiKey ?? '';
  }

  // ── 会话令牌 ──────────────────────────────────────────────────

  private get token(): string | null {
    try {
      return this.storage?.getItem(SESSION_KEY) ?? null;
    } catch {
      return null;
    }
  }

  private setToken(t: string | null): void {
    try {
      if (t === null) this.storage?.removeItem(SESSION_KEY);
      else this.storage?.setItem(SESSION_KEY, t);
    } catch {
      /* 存储不可用:本次会话仍能用内存里的 token?——没有;故登录态本次不保 */
    }
  }

  hasSession(): boolean {
    return this.token !== null;
  }

  /** 当前会话令牌(无 → null);供 CloudSource 读端点带 Bearer(S4)。 */
  getToken(): string | null {
    return this.token;
  }

  // ── 底层请求 ─────────────────────────────────────────────────

  /**
   * 带鉴权头的 JSON 请求;从不 throw,失败归成 {ok:false,status}。
   * withApiKey=true 时额外带 `x-api-key` —— **仅** PUT /cups/:id/profile 用
   * (设备写端点走 key,不走会话;见 http.ts 的 isWriteEndpoint)。
   */
  private async req(method: string, path: string, body?: unknown, withApiKey = false): Promise<Res> {
    const ac = new AbortController();
    const timer = this.timeoutMs > 0 ? setTimeout(() => ac.abort(), this.timeoutMs) : null;
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const t = this.token;
    if (t) headers['authorization'] = `Bearer ${t}`;
    if (withApiKey && this.apiKey !== '') headers['x-api-key'] = this.apiKey;
    try {
      // 必须**裸调**:`this.fetchImpl(...)` 会把 this 绑成 CloudSocial,浏览器 fetch
      // 只认 Window/undefined 接收者,否则抛 `TypeError: Illegal invocation` ——
      // 被下面的 catch 吞成 status:0 → 显示"连不上后端"。注入的假 fetch 不在乎 this,
      // 故单测照绿,只有真浏览器会炸(踩过)。
      const callFetch = this.fetchImpl;
      const r = await callFetch(`${this.apiBase}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: ac.signal,
      });
      let data: unknown = null;
      if (r.status !== 204) {
        try {
          data = await r.json();
        } catch {
          data = null;
        }
      }
      return { ok: r.ok, status: r.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  private reasonOf(res: Res): AskFailure {
    return res.status === 0 ? 'offline' : 'error';
  }

  private errorOf(res: Res): string | undefined {
    const d = res.data;
    if (d && typeof d === 'object' && typeof (d as { error?: unknown }).error === 'string') {
      return (d as { error: string }).error;
    }
    return undefined;
  }

  // ── 会话 ─────────────────────────────────────────────────────

  async me(): Promise<PublicUser | null> {
    if (!this.token) return null;
    const r = await this.req('GET', '/auth/me');
    if (r.ok) return r.data as PublicUser;
    // 令牌过期 / 被禁用 → 清掉本地令牌,免得一直带着死令牌发请求
    if (r.status === 401) this.setToken(null);
    return null;
  }

  private async auth(path: string, body: Record<string, unknown>): Promise<AuthOutcome> {
    const r = await this.req('POST', path, body);
    if (r.ok) {
      const d = r.data as { token?: unknown; user?: unknown };
      if (typeof d?.token === 'string') {
        this.setToken(d.token);
        return { ok: true, user: d.user as PublicUser };
      }
      return { ok: false, reason: 'invalid' };
    }
    return { ok: false, reason: this.reasonOf(r), error: this.errorOf(r) };
  }

  register(email: string, password: string, nickname?: string): Promise<AuthOutcome> {
    return this.auth('/auth/register', {
      email,
      password,
      ...(nickname !== undefined ? { nickname } : {}),
    });
  }

  login(email: string, password: string): Promise<AuthOutcome> {
    return this.auth('/auth/login', { email, password });
  }

  async logout(): Promise<void> {
    await this.req('POST', '/auth/logout');
    this.setToken(null);
  }

  // ── 人格档案(#72)─────────────────────────────────────────────

  async getProfile(): Promise<ServerProfile | null> {
    const r = await this.req('GET', `/cups/${encodeURIComponent(this.cupId)}/profile`);
    return r.ok ? (r.data as ServerProfile) : null;
  }

  async saveProfile(nickname: string): Promise<ServerProfile | null> {
    // 写档案是**设备写端点**(走 x-api-key),不是会话端点 —— 与 GET 同路径但鉴权不同
    const r = await this.req(
      'PUT',
      `/cups/${encodeURIComponent(this.cupId)}/profile`,
      { nickname },
      true,
    );
    return r.ok ? (r.data as ServerProfile) : null;
  }

  // ── 长期记忆 / 回忆(第 3 阶段)─────────────────────────────────

  async getMemory(q?: MemoryQuery): Promise<MemoryCard[]> {
    const p = new URLSearchParams();
    if (q?.all) p.set('all', '1');
    else if (typeof q?.recent === 'number') p.set('recent', String(q.recent));
    // build=1 → 后端先按需补封今天那张卡(幂等;那天没数据就不建空卡),再返回
    if (q?.buildToday) p.set('build', '1');
    const qs = p.toString();
    const r = await this.req(
      'GET',
      `/cups/${encodeURIComponent(this.cupId)}/memory${qs === '' ? '' : `?${qs}`}`,
    );
    if (!r.ok) return [];
    const d = r.data as { days?: unknown };
    if (!Array.isArray(d?.days)) return [];
    return d.days.filter(isMemoryCard);
  }

  async deleteMemory(scope: 'conversation' | 'memory' | 'all'): Promise<boolean> {
    const r = await this.req(
      'DELETE',
      `/cups/${encodeURIComponent(this.cupId)}/memory?scope=${encodeURIComponent(scope)}`,
    );
    return r.ok;
  }

  async getGrowth(): Promise<GrowthSnapshot | null> {
    const r = await this.req('GET', `/cups/${encodeURIComponent(this.cupId)}/growth`);
    return r.ok && isGrowthSnapshot(r.data) ? r.data : null;
  }

  // ── 每杯自选模型(BYOK)────────────────────────────────────────
  // 与 /profile 不同:这是**账号行为** —— 后端 GET/PUT/DELETE `/cups/:id/llm` 走
  // 会话闸(Bearer)+ 归属校验(非主人 403),不走设备 x-api-key。故 req 不带 withApiKey。

  async getCupLlm(): Promise<CupLlmPublic | null> {
    const r = await this.req('GET', `/cups/${encodeURIComponent(this.cupId)}/llm`);
    if (!r.ok) return null;
    return (r.data as { config?: CupLlmPublic | null }).config ?? null;
  }

  async saveCupLlm(draft: CupLlmDraft): Promise<CupLlmPublic | null> {
    const body: Record<string, unknown> = { provider: draft.provider, model: draft.model };
    if (draft.base_url !== undefined && draft.base_url !== '') body.base_url = draft.base_url;
    // key 省略 / 空串 → 后端沿用旧密文(只改模型/端点);故只在真填了才带上
    if (draft.key !== undefined && draft.key !== '') body.key = draft.key;
    const r = await this.req('PUT', `/cups/${encodeURIComponent(this.cupId)}/llm`, body);
    if (!r.ok) return null;
    return (r.data as { config?: CupLlmPublic | null }).config ?? null;
  }

  async clearCupLlm(): Promise<boolean> {
    const r = await this.req('DELETE', `/cups/${encodeURIComponent(this.cupId)}/llm`);
    return r.ok;
  }

  // ── 人格市场(#73)─────────────────────────────────────────────

  async listPacks(): Promise<PersonaPack[]> {
    const r = await this.req('GET', '/market/packs');
    if (!r.ok) return [];
    const d = r.data as { packs?: PersonaPack[] };
    return Array.isArray(d?.packs) ? d.packs : [];
  }

  async submitPack(draft: PackDraft): Promise<PersonaPack | null> {
    const r = await this.req('POST', '/market/packs', draft);
    if (!r.ok) return null;
    return (r.data as { pack?: PersonaPack }).pack ?? null;
  }

  async subscribePack(packId: string): Promise<boolean> {
    const r = await this.req('POST', `/market/packs/${encodeURIComponent(packId)}/subscribe`);
    return r.ok;
  }

  // ── 管理后台(#73)─────────────────────────────────────────────

  async adminListUsers(): Promise<AdminUser[]> {
    const r = await this.req('GET', '/admin/users');
    if (!r.ok) return [];
    const d = r.data as { users?: AdminUser[] };
    return Array.isArray(d?.users) ? d.users : [];
  }

  async adminSetDisabled(userId: string, disabled: boolean): Promise<AdminUser | null> {
    const r = await this.req('POST', `/admin/users/${encodeURIComponent(userId)}/disable`, { disabled });
    if (!r.ok) return null;
    return (r.data as { user?: AdminUser }).user ?? null;
  }

  async adminListPacks(status?: PackStatus): Promise<PersonaPack[]> {
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    const r = await this.req('GET', `/admin/packs${q}`);
    if (!r.ok) return [];
    const d = r.data as { packs?: PersonaPack[] };
    return Array.isArray(d?.packs) ? d.packs : [];
  }

  async adminVerdict(packId: string, approve: boolean): Promise<PersonaPack | null> {
    const verb = approve ? 'approve' : 'reject';
    const r = await this.req('POST', `/admin/packs/${encodeURIComponent(packId)}/${verb}`);
    if (!r.ok) return null;
    return (r.data as { pack?: PersonaPack }).pack ?? null;
  }

  // ── 服务日志端(admin/ops/reviewer)────────────────────────────
  // 后端回 `{logs, next_cursor}`;此处整成域内 `LogPage`(rows + next_cursor)。

  async adminListLogs(q: LogQuery): Promise<LogPage | null> {
    const r = await this.req('GET', `/admin/logs${logQueryString(q)}`);
    if (!r.ok) return null;
    const d = r.data as { logs?: unknown; next_cursor?: unknown };
    const rows = Array.isArray(d?.logs) ? (d.logs as LogPage['rows']) : [];
    const next = typeof d?.next_cursor === 'string' ? d.next_cursor : null;
    return { rows, next_cursor: next };
  }

  async adminLogPartitions(): Promise<LogPartition[] | null> {
    const r = await this.req('GET', '/admin/logs/partitions');
    if (!r.ok) return null;
    const d = r.data as { partitions?: unknown };
    return Array.isArray(d?.partitions) ? (d.partitions as LogPartition[]) : [];
  }

  async adminRetainLogs(): Promise<string[] | null> {
    const r = await this.req('POST', '/admin/logs/retain');
    if (!r.ok) return null;
    const d = r.data as { dropped?: unknown };
    return Array.isArray(d?.dropped) ? (d.dropped as string[]) : [];
  }

  // ── 杯子社交(#74)─────────────────────────────────────────────

  async listFriends(): Promise<FriendView[]> {
    const r = await this.req('GET', '/social/friends');
    if (!r.ok) return [];
    const d = r.data as { friends?: FriendView[] };
    return Array.isArray(d?.friends) ? d.friends : [];
  }

  async addFriend(email: string): Promise<FriendView | null> {
    const r = await this.req('POST', '/social/friends', { email });
    if (!r.ok) return null;
    return (r.data as { friend?: FriendView }).friend ?? null;
  }

  async getBoundCup(): Promise<string | null> {
    const r = await this.req('GET', '/social/cup');
    if (!r.ok) return null;
    const id = (r.data as { cup_id?: unknown }).cup_id;
    return typeof id === 'string' && id !== '' ? id : null;
  }

  async bindCup(cupId: string, claimCode?: string): Promise<BindOutcome> {
    const body: { cup_id: string; claim_code?: string } = { cup_id: cupId };
    if (claimCode !== undefined && claimCode !== '') body.claim_code = claimCode;
    const r = await this.req('POST', '/social/cup', body);
    if (r.ok) return { ok: true };
    // 403 的「杯子绑定凭证无效」要能原样显示 —— 故把后端 error 带出去,不吞成 boolean
    return { ok: false, ...(this.errorOf(r) !== undefined ? { error: this.errorOf(r)! } : {}) };
  }

  async unbindCup(): Promise<BindOutcome> {
    const r = await this.req('DELETE', '/social/cup');
    return r.ok ? { ok: true } : { ok: false, ...(this.errorOf(r) !== undefined ? { error: this.errorOf(r)! } : {}) };
  }

  async getTeam(): Promise<TeamState | null> {
    const r = await this.req('GET', '/social/team');
    return r.ok ? (r.data as TeamState) : null;
  }
}
