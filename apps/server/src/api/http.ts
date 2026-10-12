/**
 * REST API —— 架构 §5.3 的实现。用 node:http 裸写路由(不引框架,P4)。
 *
 * 路由:
 *   GET  /cups/:id/today         今日概览(已喝/目标/次数/水温区间/最近事件)
 *   GET  /cups/:id/series?range= 曲线(day=分时 / week=分日)
 *   GET  /cups/:id/events?from=&to=  事件列表
 *   GET  /cups/:id/state         当前性格/水量状态(供杯部件)
 *   PUT  /cups/:id/goal          设目标 { goal_ml }
 *   POST /cups/:id/config        改配置 → 生成 config 指令(入队,日志可见)
 *   POST /cups/:id/ask           对话:body { q } → 杯子用真实数据回答
 *   GET  /healthz                存活 + 计数
 *
 * 允许跨域(开发期前端在别的端口),生产再收紧。
 *
 * 鉴权(风险台账 R10-B):写端点**默认强制**。三个写端点
 * (`PUT goal` / `POST config` / `POST ask`)必须带 `x-api-key: <key>`,
 * 缺头 / 不匹配 → 401(小 JSON `{ error: "unauthorized" }`)。
 *   · key 由上层(app.ts)决定:env `CUP_API_KEY` 优先;未设则由 createApp 生成
 *     随机 key(默认拒绝 —— 安全默认,不再是"未设即放行")。
 *   · `deps.allowUnauth === true` → **显式**豁免写鉴权(仅 dev/测试)。
 *   · key 缺失又未豁免 → 兜底 fail closed(同样 401)。
 * 只挡写、不挡读;`GET /healthz` 永远开放。判定集中在 isWriteEndpoint(),
 * 不在各处理器里散落 if。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Command } from '@cup/contract';
import { CUP } from '@cup/contract';
import type { Store } from '../store/store.ts';
import type { DailyAgg } from '../core/types.ts';
import { DEFAULT_GOAL_ML, dayKey, dayStart } from '../store/store.ts';
import type { Pipeline } from '../core/pipeline.ts';
import type { LiveHub } from './live.ts';
import type { CommandQueue } from '../core/commands.ts';
import {
  dispositionTimeline,
  generateReport,
  historyFacts,
  historyHeadline,
  type Report,
} from '../core/report.ts';
import { enrichReport, type Llm } from '../core/llm.ts';
import { runChat, type ChatDeps } from '../core/chat/agent.ts';
import { NullChatLlm } from '../core/chat/mock.ts';
import type { ChatLlm } from '../core/chat/types.ts';
import { MemoryChatStore, type ChatStore } from '../core/chat/memory.ts';
import { ingestEnvelope } from '../ingest/http-adapter.ts';
import { MemoryAccountsStore } from '../core/social/accounts.ts';
import type { ClaimService } from '../core/social/claim.ts';
import { bearerToken, login, logout, register, resolveSession } from '../core/social/auth.ts';
import { makePack, normalizePack } from '../core/social/packs.ts';
import { teamStreak } from '../core/social/streak.ts';
import {
  toAdminUser,
  toPublicUser,
  type AccountsStore,
  type PackStatus,
  type PersonaPack,
  type PublicUser,
} from '../core/social/types.ts';
import { MemoryProfileStore, type ProfileStore } from '../core/traits.ts';
import { computePersonality, traitRecord } from '../core/personality.ts';
import { closeDayCard } from '../core/memory-cards.ts';

/** 用户提问的长度上限(超了直接 400,别灌进提示词) */
const MAX_QUESTION_CHARS = 500;

export interface ApiDeps {
  store: Store;
  pipeline: Pipeline;
  live: LiveHub;
  commands: CommandQueue;
  /** 战报语气润色;NullLlm → 恒回退模板 */
  llm: Llm;
  /** 对话 agent 的模型;NullChatLlm → 聊天恒回退确定性模板句 */
  chatLlm?: ChatLlm;
  /** 对话记忆;不给则内存(不落盘) */
  chatMemory?: ChatStore;
  /**
   * 写端点鉴权 key(R10-B)。由上层(app.ts)决定:env `CUP_API_KEY` 优先;
   * 未设则由 createApp 生成随机 key(默认拒绝)。不给 = 未配置 —— 仍需鉴权,会 fail closed。
   */
  apiKey?: string;
  /**
   * 显式豁免写端点鉴权(R10-B)—— **仅 dev/测试**。true 时写端点不再要 x-api-key。
   * 默认 false(强制)。别再拿"未设 CUP_API_KEY"当开关,那是旧的隐式放行。
   */
  allowUnauth?: boolean;
  /**
   * 读端点也要鉴权(默认 false → 读端点开放,与旧行为一致)。
   * true 时读端点(今日/趋势/事件/状态/战报/性格史)**同样**要 x-api-key。
   * 这是"可选"层:真正完整的读侧鉴权仍需账号/会话体系,这里只给一个开关。
   */
  readAuth?: boolean;
  /** 账号 / 会话 / 市场 / 社交存储;不给则内存实现(不落盘) */
  accounts?: AccountsStore;
  /** 人格档案存储(#72:昵称 + 派生性格快照);不给则内存实现 */
  profiles?: ProfileStore;
  /** 首个管理员引导邮箱(env CUP_ADMIN_EMAIL);注册命中即 role='admin' */
  adminEmail?: string;
  /** 可信绑定核验(claim code);见 core/social/claim.ts */
  claims?: ClaimService;
  /**
   * 绑定杯子须出示一次性 claim code(默认 false → 只校验 cup_id 形状,与旧行为一致)。
   * 设备/模拟器两半验收后由用户开。
   */
  requireClaim?: boolean;
  log?: (msg: string, level?: 'info' | 'warn' | 'error') => void;
}

export function createApiServer(deps: ApiDeps): Server {
  // 只解析一次:对话模型与记忆必须是**跨请求存活**的实例(否则每问一句就失忆)
  const resolved: ApiDeps = {
    ...deps,
    chatLlm: deps.chatLlm ?? new NullChatLlm(),
    chatMemory: deps.chatMemory ?? new MemoryChatStore(),
    accounts: deps.accounts ?? new MemoryAccountsStore(),
    profiles: deps.profiles ?? new MemoryProfileStore(),
  };
  return createServer((req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    // route 现在 async(Store 全 Promise 化):同步抛与异步拒绝一并在此收口。
    // headersSent 守卫:处理器可能已 send 后才抛(极罕见),避免二次写头。
    void route(req, res, resolved).catch((err: unknown) => {
      if (!res.headersSent) send(res, 500, { error: (err as Error).message });
    });
  });
}

async function route(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (path === '/healthz') {
    send(res, 200, {
      ok: true,
      ...deps.pipeline.stats(),
      live_clients: deps.live.clientCount(),
    });
    return;
  }

  // ── 账号 / 会话路由(与杯子无关;不经 x-api-key,自带口令校验)──
  const auth = path.match(/^\/auth\/(register|login|logout|me)$/);
  if (auth) {
    return await authRoute(req, res, deps, auth[1]!);
  }

  // ── 人格市场(UGC;需登录会话,不走 x-api-key)──
  if (path === '/market/packs') {
    return await marketPacksRoute(req, res, deps, url);
  }
  const sub = path.match(/^\/market\/packs\/([^/]+)\/subscribe$/);
  if (sub) {
    return await marketSubscribeRoute(req, res, deps, decodeURIComponent(sub[1]!));
  }

  // ── 管理后台(会话 + role==='admin')──
  if (path === '/admin/users') {
    return await adminUsersRoute(req, res, deps);
  }
  const banUser = path.match(/^\/admin\/users\/([^/]+)\/disable$/);
  if (banUser) {
    return await adminUserDisableRoute(req, res, deps, decodeURIComponent(banUser[1]!));
  }
  if (path === '/admin/packs') {
    return await adminPacksRoute(req, res, deps, url);
  }
  const verdict = path.match(/^\/admin\/packs\/([^/]+)\/(approve|reject)$/);
  if (verdict) {
    return await adminPackVerdictRoute(req, res, deps, decodeURIComponent(verdict[1]!), verdict[2]!);
  }

  // ── 杯子社交(#74;需登录会话)──
  if (path === '/social/friends') {
    return await socialFriendsRoute(req, res, deps);
  }
  if (path === '/social/cup') {
    return await socialCupBindRoute(req, res, deps);
  }
  if (path === '/social/team') {
    return await socialTeamRoute(req, res, deps);
  }

  const m = path.match(/^\/cups\/([^/]+)\/(today|series|events|state|goal|config|ask|ingest|report\/latest|report\/history|personality\/history|profile|memory)$/);
  if (!m) {
    send(res, 404, { error: 'not found', path });
    return;
  }
  const cupId = decodeURIComponent(m[1]!);
  const action = m[2]!;
  const method = req.method ?? 'GET';

  // 写端点守卫(R10):仅在配了 key 时启用。读端点 / healthz 不受影响。
  if (!authorize(req, res, deps, method, action)) return;

  switch (action) {
    case 'today':
      return await today(res, deps, cupId);
    case 'series':
      return await series(res, deps, cupId, url);
    case 'events':
      return await events(res, deps, cupId, url);
    case 'state':
      return await state(res, deps, cupId);
    case 'goal':
      return await setGoal(req, res, deps, cupId);
    case 'config':
      return await setConfig(req, res, deps, cupId);
    case 'ask':
      return await askRoute(req, res, deps, cupId);
    case 'ingest':
      return await ingestRoute(req, res, deps, cupId);
    case 'report/latest':
      return await reportRoute(res, deps, cupId);
    case 'report/history':
      return await historyRoute(res, deps, cupId, url);
    case 'personality/history':
      return await personalityHistoryRoute(res, deps, cupId, url);
    case 'profile':
      return await profileRoute(req, res, deps, cupId);
    case 'memory':
      return await memoryRoute(req, res, deps, cupId, url);
  }
}

// ── 账号 / 会话处理器(多用户地基)────────────────────────────────
//
// 这些端点**不走 x-api-key**(它们不是设备写端点);口令进、令牌出,后续请求带
// `Authorization: Bearer <token>`。token 的解析统一走 resolveSession(deps, token)。
// 见 auth.ts 的规则层与 types.ts 的出口视图(绝不含 salt/hash)。

async function authRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
  action: string,
): Promise<void> {
  const authDeps = { store: deps.accounts!, adminEmail: deps.adminEmail };
  const method = req.method ?? 'GET';

  if (action === 'register') {
    if (method !== 'POST') return send(res, 405, { error: 'use POST' });
    const body = await readJson(req);
    const b = (body ?? {}) as Record<string, unknown>;
    const r = await register(authDeps, {
      email: typeof b.email === 'string' ? b.email : '',
      password: typeof b.password === 'string' ? b.password : '',
      nickname: typeof b.nickname === 'string' ? b.nickname : undefined,
    });
    if (!r.ok) return send(res, r.status, { error: r.error });
    return send(res, 200, { token: r.token, user: r.user });
  }

  if (action === 'login') {
    if (method !== 'POST') return send(res, 405, { error: 'use POST' });
    const body = await readJson(req);
    const b = (body ?? {}) as Record<string, unknown>;
    const r = await login(authDeps, {
      email: typeof b.email === 'string' ? b.email : '',
      password: typeof b.password === 'string' ? b.password : '',
    });
    if (!r.ok) return send(res, r.status, { error: r.error });
    return send(res, 200, { token: r.token, user: r.user });
  }

  if (action === 'logout') {
    if (method !== 'POST') return send(res, 405, { error: 'use POST' });
    await logout(authDeps, bearerToken(req.headers['authorization']));
    res.writeHead(204).end();
    return;
  }

  // me:带令牌 → 当前用户;否则 401
  const user: PublicUser | null = await resolveSession(
    authDeps,
    bearerToken(req.headers['authorization']),
  );
  if (!user) return send(res, 401, { error: 'unauthorized' });
  send(res, 200, user);
}

// ── 人格市场(UGC;#73)─────────────────────────────────────────────
//
// 这些端点要**登录会话**(Authorization: Bearer),不走 x-api-key —— 它们是"用户行为"
// 不是"设备写"。判定集中在 guardUser()/guardAdmin()(会话 + 角色),不散在各处理器。

/** 会话守卫:无有效令牌 → 401 */
async function guardUser(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
): Promise<PublicUser | null> {
  const user = await resolveSession(
    { store: deps.accounts!, adminEmail: deps.adminEmail },
    bearerToken(req.headers['authorization']),
  );
  if (!user) {
    send(res, 401, { error: 'unauthorized' });
    return null;
  }
  return user;
}

/** 管理员守卫:会话 + role==='admin';未登录 → 401,非管理员 → 403 */
async function guardAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
): Promise<PublicUser | null> {
  const user = await guardUser(req, res, deps);
  if (!user) return null;
  if (user.role !== 'admin') {
    send(res, 403, { error: '需要管理员权限' });
    return null;
  }
  return user;
}

/** 出口视图:包不含任何机密,直接原样发出(便于前端一次拿到全部字段) */
function packView(p: PersonaPack): PersonaPack {
  return {
    pack_id: p.pack_id,
    author_user_id: p.author_user_id,
    name: p.name,
    tone: p.tone,
    thresholds: p.thresholds,
    wave: p.wave,
    lines: p.lines,
    status: p.status,
    created_at: p.created_at,
  };
}

/**
 * GET  /market/packs           → 200 { packs: approved[] }(已上架;需登录)
 * POST /market/packs  {…draft} → 200 { pack }(投稿 → status:'pending';需登录)
 */
async function marketPacksRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
  url: URL,
): Promise<void> {
  const user = await guardUser(req, res, deps);
  if (!user) return;

  const method = req.method ?? 'GET';
  if (method === 'GET') {
    // 默认只看已上架;管理员可 ?status=pending 看全部(便于复用同一读口)
    const want = url.searchParams.get('status');
    const status: PackStatus | undefined =
      want === 'pending' || want === 'approved' || want === 'rejected' ? want : undefined;
    const statusFilter: PackStatus = status ?? 'approved';
    if (status && user.role !== 'admin') {
      return send(res, 403, { error: '需要管理员权限' });
    }
    const packs = await deps.accounts!.listPacks(statusFilter);
    return send(res, 200, { packs: packs.map(packView) });
  }

  if (method !== 'POST') return send(res, 405, { error: 'use GET or POST' });

  const body = await readJson(req);
  const r = normalizePack(body);
  if (!r.ok) return send(res, 400, { error: r.error });
  const pack = makePack(r.draft, user.user_id, Date.now());
  await deps.accounts!.createPack(pack);
  send(res, 200, { pack: packView(pack) });
}

/** POST /market/packs/:id/subscribe → 200 { subscribed, pack_id };包不存在 / 未上架 → 404 */
async function marketSubscribeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
  packId: string,
): Promise<void> {
  const user = await guardUser(req, res, deps);
  if (!user) return;
  if ((req.method ?? 'GET') !== 'POST') return send(res, 405, { error: 'use POST' });

  const pack = await deps.accounts!.packById(packId);
  if (!pack || pack.status !== 'approved') {
    return send(res, 404, { error: '包不存在或未上架' });
  }
  await deps.accounts!.subscribe(user.user_id, packId);
  send(res, 200, { subscribed: true, pack_id: packId });
}

// ── 管理后台(#73 审核;用户管理)───────────────────────────────────

/**
 * GET /admin/users → 200 { users: AdminUser[] }
 * 出口用 toAdminUser(带 disabled/created_at,**仍绝不含 salt/hash**)。
 */
async function adminUsersRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
): Promise<void> {
  const admin = await guardAdmin(req, res, deps);
  if (!admin) return;
  if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'use GET' });
  const accounts = await deps.accounts!.listAccounts();
  send(res, 200, { users: accounts.map(toAdminUser) });
}

/** POST /admin/users/:id/disable { disabled?: boolean } → 200 { user };默认禁用 */
async function adminUserDisableRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
  userId: string,
): Promise<void> {
  const admin = await guardAdmin(req, res, deps);
  if (!admin) return;
  if ((req.method ?? 'GET') !== 'POST') return send(res, 405, { error: 'use POST' });

  const target = await deps.accounts!.accountById(userId);
  if (!target) return send(res, 404, { error: '用户不存在' });
  if (target.user_id === admin.user_id) {
    return send(res, 400, { error: '不能禁用自己' });
  }

  const body = await readJson(req);
  const raw = (body as { disabled?: unknown }).disabled;
  // 不传默认禁用(true);显式 false 才解禁
  const disabled = raw === false ? false : true;
  await deps.accounts!.setDisabled(userId, disabled);
  const updated = await deps.accounts!.accountById(userId);
  send(res, 200, { user: toAdminUser(updated!) });
}

/**
 * GET /admin/packs?status=pending → 200 { packs }
 * status 缺省 → 全部(管理员视角)。
 */
async function adminPacksRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
  url: URL,
): Promise<void> {
  const admin = await guardAdmin(req, res, deps);
  if (!admin) return;
  if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'use GET' });
  const want = url.searchParams.get('status');
  const status: PackStatus | undefined =
    want === 'pending' || want === 'approved' || want === 'rejected' ? want : undefined;
  const packs = await deps.accounts!.listPacks(status);
  send(res, 200, { packs: packs.map(packView) });
}

/** POST /admin/packs/:id/(approve|reject) → 200 { pack };包不存在 → 404 */
async function adminPackVerdictRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
  packId: string,
  verdict: string,
): Promise<void> {
  const admin = await guardAdmin(req, res, deps);
  if (!admin) return;
  if ((req.method ?? 'GET') !== 'POST') return send(res, 405, { error: 'use POST' });

  const pack = await deps.accounts!.packById(packId);
  if (!pack) return send(res, 404, { error: '包不存在' });
  const status: PackStatus = verdict === 'approve' ? 'approved' : 'rejected';
  await deps.accounts!.setPackStatus(packId, status);
  const updated = await deps.accounts!.packById(packId);
  send(res, 200, { pack: packView(updated!) });
}

// ── 杯子社交(#74)────────────────────────────────────────────────
//
// 好友之间**只看派生结论**(昵称 + 派生性格 + streak),绝不暴露原始饮水曲线 / 聊天。
// 与迁移码 / #72 档案同一隐私口径。要登录会话,不走 x-api-key。
//
// 「互见」要个 user↔cup 绑定:账号里的 `cup_id`(#74 加的可选字段)。没绑 = 好友只看到昵称。

/** 好友出口视图 —— 好友的昵称 + 派生性格 + streak(绑了杯子才有后两者) */
interface FriendView {
  user_id: string;
  nickname: string;
  /** 绑了杯子才有;未绑 → null */
  traits: ReturnType<typeof traitRecord> | null;
  /** 单人当前 streak(与 today.streak 同源);未绑 → null */
  streak: number | null;
}

/** 由 cupId 现算派生性格 + streak(绑了才调;与 /cups/:id/today 同口径) */
async function traitsForCup(
  deps: ApiDeps,
  cupId: string,
): Promise<{ traits: ReturnType<typeof traitRecord>; streak: number }> {
  const now = Date.now();
  const today = dayKey(now);
  const agg = await deps.store.agg(cupId, today);
  const recent = (await deps.store.recentAggs(cupId, today, 7)).filter(
    (d) => d.updated_at > 0 || d.event_count > 0,
  );
  const todayOk = !!agg && agg.goal_ml > 0 && agg.drank_ml >= agg.goal_ml;
  const traits = traitRecord(computePersonality(recent, todayOk), now);
  return { traits, streak: agg?.streak ?? 0 };
}

async function friendView(
  deps: ApiDeps,
  userId: string,
  nickname: string,
  cupId?: string,
): Promise<FriendView> {
  if (!cupId) return { user_id: userId, nickname, traits: null, streak: null };
  const { traits, streak } = await traitsForCup(deps, cupId);
  return { user_id: userId, nickname, traits, streak };
}

/**
 * GET  /social/friends → 200 { friends: FriendView[] }(需登录)
 * POST /social/friends { email } → 200 { friend: FriendView }(按邮箱加好友;需登录)
 *   · 加不存在的邮箱 → 404;加自己 → 400;重复加 → 幂等 200。
 */
async function socialFriendsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
): Promise<void> {
  const me = await guardUser(req, res, deps);
  if (!me) return;
  const method = req.method ?? 'GET';

  if (method === 'GET') {
    const ids = await deps.accounts!.friends(me.user_id);
    const friends: FriendView[] = [];
    for (const id of ids) {
      const a = await deps.accounts!.accountById(id);
      friends.push(await friendView(deps, id, a?.nickname ?? id, a?.cup_id));
    }
    return send(res, 200, { friends });
  }

  if (method !== 'POST') return send(res, 405, { error: 'use GET or POST' });

  const body = await readJson(req);
  const email = typeof (body as { email?: unknown }).email === 'string'
    ? ((body as { email: string }).email)
    : '';
  const target = await deps.accounts!.accountByEmail(email);
  if (!target) return send(res, 404, { error: '找不到该用户' });
  if (target.user_id === me.user_id) return send(res, 400, { error: '不能加自己' });
  await deps.accounts!.addFriend(me.user_id, target.user_id);
  send(res, 200, {
    friend: await friendView(deps, target.user_id, target.nickname, target.cup_id),
  });
}

/**
 * POST   /social/cup { cup_id } → 200 { cup_id }(绑定我的杯子,好友才看得到我的派生性格)
 * DELETE /social/cup             → 200 { cup_id: null }(解绑)
 */
async function socialCupBindRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
): Promise<void> {
  const me = await guardUser(req, res, deps);
  if (!me) return;
  const method = req.method ?? 'GET';

  if (method === 'DELETE') {
    await deps.accounts!.setCup(me.user_id, null);
    return send(res, 200, { cup_id: null });
  }
  if (method !== 'POST') return send(res, 405, { error: 'use POST or DELETE' });

  const body = await readJson(req);
  const raw = (body as { cup_id?: unknown }).cup_id;
  const cupId = typeof raw === 'string' ? raw.trim() : '';
  if (cupId.length === 0 || cupId.length > 64) {
    return send(res, 400, { error: 'cup_id 不合法' });
  }
  // 可信绑定(R18,开关默认关):开了则必须出示设备一次性 claim code 才能绑。
  // 缺/过期/已用/不匹配/超失败上限 → **一律同一 403**,不给 oracle 区分失败原因。
  if (deps.requireClaim === true) {
    const claimCode = typeof (body as { claim_code?: unknown }).claim_code === 'string'
      ? ((body as { claim_code: string }).claim_code)
      : '';
    const ok = deps.claims ? await deps.claims.verify(cupId, claimCode) : false;
    if (!ok) return send(res, 403, { error: '杯子绑定凭证无效' });
  }
  await deps.accounts!.setCup(me.user_id, cupId);
  send(res, 200, { cup_id: cupId });
}

/**
 * GET /social/team → 200 { members, friends, streak, days }(需登录)
 *   把自己的杯子 + 所有**绑了杯子**的好友凑成一支队,算共同连续达标天数。
 *   没绑杯子 → members 不含自己,也不含未绑的好友(只用能算的成员)。
 */
async function socialTeamRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
): Promise<void> {
  const me = await guardUser(req, res, deps);
  if (!me) return;
  if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'use GET' });

  const meAccount = await deps.accounts!.accountById(me.user_id);
  const friendIds = await deps.accounts!.friends(me.user_id);

  // 能参与计算的成员:自己 + 绑了杯子的好友(各自一个 cupId)
  const memberCups: string[] = [];
  if (meAccount?.cup_id) memberCups.push(meAccount.cup_id);
  for (const id of friendIds) {
    const a = await deps.accounts!.accountById(id);
    if (a?.cup_id) memberCups.push(a.cup_id);
  }

  const today = dayKey(Date.now());
  const perMember: DailyAgg[][] = [];
  for (const cupId of memberCups) {
    perMember.push(
      (await deps.store.recentAggs(cupId, today, 30)).filter(
        (d) => d.updated_at > 0 || d.event_count > 0,
      ),
    );
  }
  const r = teamStreak(perMember, today, 30);
  send(res, 200, { members: r.members, friends: friendIds.length, streak: r.streak, days: r.days });
}

// ── 处理器 ─────────────────────────────────────────────────────────

async function today(res: ServerResponse, deps: ApiDeps, cupId: string): Promise<void> {
  const now = Date.now();
  const date = dayKey(now);
  const dayEnd = dayStart(date) + 86_400_000;
  const agg = await deps.store.agg(cupId, date);
  const recentEvents = (await deps.store.events(cupId, dayStart(date), dayEnd)).slice(-8).reverse();
  const sample = await deps.store.latestSample(cupId);
  const goal = agg?.goal_ml ?? (await deps.store.goal(cupId));
  send(res, 200, {
    cup_id: cupId,
    date,
    drank_ml: agg?.drank_ml ?? 0,
    goal_ml: goal,
    drink_count: agg?.drink_count ?? 0,
    progress: progressPct(agg?.drank_ml ?? 0, goal),
    temp_min_c: agg?.temp_min_c ?? null,
    temp_max_c: agg?.temp_max_c ?? null,
    temp_avg_c: agg?.temp_avg_c ?? null,
    streak: agg?.streak ?? 0,
    current_volume_ml: sample?.volume_ml ?? null,
    current_temp_c: sample?.temp_c ?? null,
    recent_events: recentEvents,
  });
}

async function series(res: ServerResponse, deps: ApiDeps, cupId: string, url: URL): Promise<void> {
  const range = url.searchParams.get('range') ?? 'day';
  const now = Date.now();
  if (range === 'week') {
    const today = dayKey(now);
    const buckets = (await deps.store.recentAggs(cupId, today, 7)).map((a) => ({
      label: a.date.slice(5),
      ts: dayStart(a.date),
      drank_ml: a.drank_ml,
      refill_ml: a.refill_ml,
      temp_avg_c: a.temp_avg_c,
      last_volume_ml: a.last_volume_ml,
    }));
    send(res, 200, { cup_id: cupId, range, buckets });
    return;
  }

  // day:今天分 24 小时桶
  const from = dayStart(dayKey(now));
  const to = from + 86_400_000; // 整天,不裁到"此刻" —— 模拟器可能灌入一整天(含未来时段)
  const hourMs = 3_600_000;
  const buckets = Array.from({ length: 24 }, (_, h) => ({
    label: `${String(h).padStart(2, '0')}:00`,
    ts: from + h * hourMs,
    drank_ml: 0,
    refill_ml: 0,
    temp_sum: 0,
    temp_n: 0,
    last_volume_ml: null as number | null,
  }));

  for (const e of await deps.store.events(cupId, from, to)) {
    const h = Math.min(23, Math.floor((e.ts - from) / hourMs));
    const b = buckets[h]!;
    if (e.type === 'drink') b.drank_ml += e.amount_ml ?? 0;
    else if (e.type === 'refill') b.refill_ml += e.amount_ml ?? 0;
  }
  for (const p of await deps.store.telemetry(cupId, from, to)) {
    if (p.kind !== 'lid' || !p.lid) continue;
    const h = Math.min(23, Math.floor((p.ts - from) / hourMs));
    const b = buckets[h]!;
    b.temp_sum += p.lid.temp_c;
    b.temp_n += 1;
  }

  send(res, 200, {
    cup_id: cupId,
    range,
    buckets: buckets.map((b) => ({
      label: b.label,
      ts: b.ts,
      drank_ml: b.drank_ml,
      refill_ml: b.refill_ml,
      temp_avg_c: b.temp_n > 0 ? Math.round((b.temp_sum / b.temp_n) * 10) / 10 : null,
      last_volume_ml: b.last_volume_ml,
    })),
  });
}

async function events(
  res: ServerResponse,
  deps: ApiDeps,
  cupId: string,
  url: URL,
): Promise<void> {
  const from = num(url.searchParams.get('from')) ?? 0;
  const to = num(url.searchParams.get('to')) ?? Date.now();
  const list = await deps.store.events(cupId, from, to);
  send(res, 200, { cup_id: cupId, from, to, count: list.length, events: list });
}

async function state(res: ServerResponse, deps: ApiDeps, cupId: string): Promise<void> {
  const sample = await deps.store.latestSample(cupId);
  if (!sample) {
    send(res, 404, { error: 'no data yet', cup_id: cupId });
    return;
  }
  send(res, 200, {
    ...sample,
    cup_id: cupId,
    capacity_ml: CUP.capacity_ml,
  });
}

/**
 * 每日战报(M4)。主路径:模板 + 真实数字;LLM 只润语气(失败即回退)。
 *
 * 数字骨架一律来自日聚合(store.recentAggs),**不来自 LLM** —— 验收 2。
 * 今天还没有任何数据(没聚合)时返回 404,而不是编一份空战报。
 */
async function reportRoute(res: ServerResponse, deps: ApiDeps, cupId: string): Promise<void> {
  const today = dayKey(Date.now());
  // 只把"有数据"的日子算进性格 —— 否则新杯子会被 6 个空白天判成"蔫"
  const recent = (await deps.store.recentAggs(cupId, today, 7)).filter(
    (d) => d.updated_at > 0 || d.event_count > 0,
  );
  const agg = await deps.store.agg(cupId, today);
  // 今天一条数据都没有 → 没有可讲的事实,明确 404
  if (!agg || agg.event_count === 0) {
    send(res, 404, { error: '今天还没有数据,暂无战报', cup_id: cupId, date: today });
    return;
  }
  const base = generateReport(agg, recent);
  const report: Report = await enrichReport(base, deps.llm);
  send(res, 200, { cup_id: cupId, ...report });
}

/** 历史战报天数:近 N 天(含今天)。上限 31 天,够看一月回望,也封住任意拉取。 */
const HISTORY_DAYS = 7;
const HISTORY_DAYS_MAX = 31;

/**
 * 历史战报(近 N 天)—— 纯读,无 LLM。
 *
 * 每天给「模板文案 + 数字骨架」:文案是后端模板句(与今日战报同款措辞家族),
 * 前端可原样展示,不必自己拼句子。**只返回有数据的日子**,没有的不占位。
 * 无任何数据 → 200 + 空 days(不是 404 —— "还没开始记录"是正常态,不是错误)。
 */
async function historyRoute(
  res: ServerResponse,
  deps: ApiDeps,
  cupId: string,
  url: URL,
): Promise<void> {
  const raw = Number(url.searchParams.get('days'));
  const days = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), HISTORY_DAYS_MAX) : HISTORY_DAYS;
  const today = dayKey(Date.now());
  const recent = await deps.store.recentAggs(cupId, today, days);
  const daysOut = historyFacts(recent).map((f) => ({ ...f, headline: historyHeadline(f) }));
  send(res, 200, { cup_id: cupId, days: daysOut, count: daysOut.length });
}

/**
 * 脾气变化史 —— 「杯子这几天心情怎么变的」逐日时间线(纯读,无 LLM)。
 *
 * 与 report/history 的分工:那张是**逐日喝水量**回看;这张是**逐日长期性格**回看
 * (蔫/平常/得意),给"养成卡"当只读素材。复用同一个 computePersonality 函数逐日切片,
 * 不另建性格逻辑 —— 前端看板读到的 (card) 与今日战报的 disposition 同源。
 *
 * 空白日不占位(同 historyRoute);无任何数据 → 200 + 空 days(正常态,非 404)。
 */
async function personalityHistoryRoute(
  res: ServerResponse,
  deps: ApiDeps,
  cupId: string,
  url: URL,
): Promise<void> {
  const raw = Number(url.searchParams.get('days'));
  const days = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), HISTORY_DAYS_MAX) : HISTORY_DAYS;
  const today = dayKey(Date.now());
  const recent = await deps.store.recentAggs(cupId, today, days);
  const timeline = dispositionTimeline(recent);
  send(res, 200, { cup_id: cupId, days: timeline, count: timeline.length });
}

/**
 * 人格档案(#72)—— 养成卡的**读写两端**(昵称 + 派生性格快照)。
 *
 *   GET  /cups/:id/profile → 200 { cup_id, nickname, traits }
 *     · 没有落盘档案 → 用**当下**的 computePersonality 现算一份返回(不落盘,只读不写)。
 *   PUT  /cups/:id/profile { nickname? } → 200 { cup_id, nickname, traits }
 *     · 昵称由用户给;**traits 一律服务端现算**,绝不接受客户端传来的数值(防伪造)。
 *
 * traits 的 7 天窗口同 reportRoute / personalityHistoryRoute —— 同一份 computePersonality,
 * 保证养成卡读到的性格与今日战报、脾气变化史末日**同源**。
 */
async function profileRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
  cupId: string,
): Promise<void> {
  const method = req.method ?? 'GET';

  if (method === 'GET') {
    const stored = await deps.profiles!.get(cupId);
    if (stored) {
      send(res, 200, { cup_id: cupId, nickname: stored.nickname, traits: stored.traits });
      return;
    }
    // 无档案 → 现算(不落盘)
    send(res, 200, { cup_id: cupId, nickname: '', traits: await currentTraits(deps, cupId) });
    return;
  }

  if (method !== 'PUT') return send(res, 405, { error: 'use GET or PUT' });

  const body = await readJson(req);
  const raw = (body as { nickname?: unknown }).nickname;
  if (raw !== undefined && typeof raw !== 'string') {
    return send(res, 400, { error: 'nickname 需为字符串' });
  }
  const nickname = (typeof raw === 'string' ? raw : '').trim().slice(0, PROFILE_NICKNAME_MAX);
  // traits 由服务端现算 —— 不读客户端任何数值字段
  const traits = await currentTraits(deps, cupId);
  await deps.profiles!.set(cupId, { nickname, traits });
  send(res, 200, { cup_id: cupId, nickname, traits });
}

const PROFILE_NICKNAME_MAX = 24;

/** 记忆卡回看的天数上限(与 recall 工具同口径;有界,别把一个月灌回来) */
const MEMORY_DAYS_MAX = 30;
const MEMORY_DAYS_DEFAULT = 7;

/**
 * 长期记忆(第 3 阶段)—— 读端。`GET /cups/:id/memory`
 *   · `?day=YYYY-MM-DD` → 只取那天
 *   · `?recent=N`(≤30,默认 7)→ 最近 N 天(只含有卡的天)
 *   · `?build=1` → 先按需补建那天的卡(那天有数据/对话才建),再返回
 *
 * 返回 `{ cup_id, days: MemoryCard[] }`。**只读**(build=1 会写一张卡,但仍是幂等的封存)。
 * 三档删除(第 4 阶段)会在这条路由上加 DELETE。
 */
async function memoryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
  cupId: string,
  url: URL,
): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'use GET' });

  const dayParam = url.searchParams.get('day');
  const build = url.searchParams.get('build') === '1';
  const memory = deps.chatMemory!;

  if (dayParam) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayParam)) {
      return send(res, 400, { error: 'day 需为 YYYY-MM-DD' });
    }
    if (build) await closeDayCard(deps.store, memory, cupId, dayParam, Date.now());
    const card = await deps.store.memoryCard(cupId, dayParam);
    return send(res, 200, { cup_id: cupId, days: card ? [card] : [] });
  }

  const raw = Number(url.searchParams.get('recent'));
  const days = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), MEMORY_DAYS_MAX) : MEMORY_DAYS_DEFAULT;
  const today = dayKey(Date.now());
  if (build) await closeDayCard(deps.store, memory, cupId, today, Date.now());
  const cards = await deps.store.recentMemoryCards(cupId, today, days);
  send(res, 200, { cup_id: cupId, days: cards });
}

/** 由当下日聚合现算派生性格快照(与战报/性格史同一口径) */
async function currentTraits(
  deps: ApiDeps,
  cupId: string,
): Promise<ReturnType<typeof traitRecord>> {
  const now = Date.now();
  const today = dayKey(now);
  const recent = (await deps.store.recentAggs(cupId, today, 7)).filter(
    (d) => d.updated_at > 0 || d.event_count > 0,
  );
  const agg = await deps.store.agg(cupId, today);
  const todayOk = !!agg && agg.goal_ml > 0 && agg.drank_ml >= agg.goal_ml;
  return traitRecord(computePersonality(recent, todayOk), now);
}

async function setGoal(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
  cupId: string,
): Promise<void> {
  if (req.method !== 'PUT') return send(res, 405, { error: 'use PUT' });
  const body = await readJson(req);
  const goal = num((body as { goal_ml?: unknown }).goal_ml);
  if (goal === null || goal <= 0 || goal > 10_000) {
    return send(res, 400, { error: 'goal_ml 需为 0–10000 的正数' });
  }
  await deps.store.setGoal(cupId, goal);
  send(res, 200, { cup_id: cupId, goal_ml: goal, default_goal_ml: DEFAULT_GOAL_ML });
}

async function setConfig(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
  cupId: string,
): Promise<void> {
  if (req.method !== 'POST') return send(res, 405, { error: 'use POST' });
  const body = await readJson(req);
  const payload = (body ?? {}) as Record<string, unknown>;
  // 生成一条 config 指令入队(拉取式下行:设备下次上报时捎回)。
  // 目标设备暂定 lid-*;真机配网后由 pairing 决定。
  const cmd: Command = {
    v: 1,
    cmd_id: `cfg-${Date.now()}`,
    target: 'lid-A1B2C3',
    ts: Date.now(),
    expires_at: Date.now() + 24 * 3_600_000,
    type: 'config',
    payload,
  };
  deps.commands.enqueue(cmd);
  send(res, 202, { cup_id: cupId, queued: cmd });
}

/**
 * 对话(P4):`POST /cups/:id/ask { q }` → 杯子用真实数据回答。
 *
 * 鉴权:写端点,配了 CUP_API_KEY 时须带 x-api-key(见文件头);问句长度硬限,超限 400 —— 不让超长输入进提示词。
 * 回答永不空白:模型缺席/出错/守卫拦下 → runChat 内部回退确定性模板句。
 */
async function askRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
  cupId: string,
): Promise<void> {
  if (req.method !== 'POST') return send(res, 405, { error: 'use POST' });
  const body = await readJson(req);
  const q = (body as { q?: unknown }).q;
  if (typeof q !== 'string' || q.trim().length === 0) {
    send(res, 400, { error: 'q 需为非空字符串' });
    return;
  }
  if (q.length > MAX_QUESTION_CHARS) {
    send(res, 400, { error: `q 过长(上限 ${MAX_QUESTION_CHARS} 字)` });
    return;
  }
  const chatDeps: ChatDeps = {
    store: deps.store,
    commands: deps.commands,
    chat: deps.chatLlm!,
    memory: deps.chatMemory!,
    log: deps.log ?? (() => {}),
  };
  try {
    const answer = await runChat(chatDeps, { cupId, question: q.trim() });
    send(res, 200, { cup_id: cupId, answer });
  } catch (err) {
    send(res, 500, { error: (err as Error).message });
  }
}

/**
 * HTTP ingest 中转(S9)—— 弱网补传 / 网关中转的批量上报入口。
 * body 形状见 http-adapter.ts(normalizeEnvelope 收 frame/frames/裸数组)。
 * 走的是**同一条管线**;帧不过契约 §2 就 400,并回逐条原因。
 */
async function ingestRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
  cupId: string,
): Promise<void> {
  if (req.method !== 'POST') return send(res, 405, { error: 'use POST' });
  const body = await readJson(req);
  const r = await ingestEnvelope(body, deps.pipeline, cupId);
  // 整批没一帧合规 → 400(调用方应立即知道发错了);有合规也有脏的 → 200 带计数
  const status = r.accepted + r.deduped === 0 && r.rejected > 0 ? 400 : 200;
  send(res, status, {
    cup_id: cupId,
    accepted: r.accepted,
    deduped: r.deduped,
    rejected: r.rejected,
    errors: r.errors,
  });
}

// ── 鉴权守卫(R10)────────────────────────────────────────────────

/**
 * 写端点判定 —— **集中一处**,别在各处理器里散落 if。
 * 依据"方法 + 路由动作"判定:只有真正的写请求算写端点。
 * 读端点(today/series/events/state/report/latest)、/healthz 一律放行。
 */
function isWriteEndpoint(method: string, action: string): boolean {
  if (action === 'goal') return method === 'PUT';
  if (action === 'config') return method === 'POST';
  if (action === 'ask') return method === 'POST';
  if (action === 'ingest') return method === 'POST'; // 中转上报也是写
  if (action === 'profile') return method === 'PUT'; // 写档案(昵称+性格快照)是写
  return false;
}

/**
 * 写端点鉴权(R10-B)—— 默认强制。
 * 读端点一律放行;写端点必须带 `x-api-key` 且值相等,否则 401(小 JSON)。
 *   · allowUnauth → 显式豁免(仅 dev/测试)。
 *   · 无 key(未配置)又未豁免 → fail closed(仍 401)。
 * @returns true = 放行继续处理;false = 已回 401,调用方应 return。
 */
function authorize(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
  method: string,
  action: string,
): boolean {
  const write = isWriteEndpoint(method, action);
  // 读端点:默认放行;readAuth=true 时也纳入鉴权(可选层)。
  if (!write && deps.readAuth !== true) return true;
  if (deps.allowUnauth) return true; // 显式豁免(dev/测试)

  const key = deps.apiKey;
  const header = req.headers['x-api-key'];
  const provided = Array.isArray(header) ? header[0] : header;
  if (key && provided === key) return true;

  send(res, 401, { error: 'unauthorized' });
  return false;
}

// ── 工具 ───────────────────────────────────────────────────────────

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  // authorization:账号会话用 Bearer 令牌(见 §二);缺它浏览器预检会拒掉带令牌的请求
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-api-key,authorization');
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      try {
        resolve(buf.length > 0 ? JSON.parse(buf) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function progressPct(drank: number, goal: number): number {
  if (goal <= 0) return 0;
  return Math.min(100, Math.round((drank / goal) * 100));
}
