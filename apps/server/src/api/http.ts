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
 * 鉴权(风险台账 R10-B / S4)—— **两条轴**,收口在 authorize():
 *   · **写端点**(`PUT goal` / `POST config` / `POST ask` / `POST ingest` / `PUT profile`)
 *     走**设备钥**:必须带 `x-api-key: <key>`,缺头 / 不匹配 → 401(小 JSON
 *     `{ error: "unauthorized" }`)。key 由上层(app.ts)决定:env `CUP_API_KEY` 优先;
 *     未设则由 createApp 生成随机 key(默认拒绝 —— 安全默认,不再是"未设即放行")。
 *   · **读端点**(今日/趋势/事件/状态/战报/性格史 + `GET profile` / `GET memory`)
 *     走**账号会话 + 归属**(S4,默认强制):未登录 401;登录了但不是这只杯的主人 403
 *     (不区分未绑/绑了别只 —— 不给探测他人 cup id 的 oracle)。数据随杯走,故"能读这只杯"= 账户已绑它。
 *   · `deps.allowUnauth === true` → **显式豁免读+写**(仅 dev/测试)。
 * `OPTIONS` 预检与 `GET /healthz` 永远开放。判定集中在 isWriteEndpoint(),
 * 不在各处理器里散落 if。(`--read-auth` 旧占位旗已退役:S4 的会话闸取代它。)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Command } from '@cup/contract';
import { CUP } from '@cup/contract';
import type { DeleteScope, Store } from '../store/store.ts';
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
import { isCupLlmProvider, type CupLlmService } from '../core/cup-llm.ts';
import type { CupActivePackStore } from '../core/active-pack.ts';
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
import type { LogLevel } from '../core/logger.ts';
import { LOG_LEVELS } from '../core/logger.ts';
import { LOG_PAGE_MAX, type LogQuery, type ServerLogStore } from '../core/log-store.ts';
import { applyRetention, listPartitions, type RetentionOptions } from '../store/pg/migrate.ts';
import { query, type Pool } from '../store/pg/pool.ts';
import { computePersonality, traitRecord } from '../core/personality.ts';
import { deriveGrowth, GROWTH_DAYS } from '../core/growth.ts';
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
  /**
   * 按杯取"用户自选模型"(登录后给自己那只杯配的 provider/model/key)。缺席 / 未配 → null。
   * 返回非 null 时,`/ask` 改为**账户鉴权**:要求登录会话(401)且 `cup_id` 确属该用户(403)。
   * 未配(返回 null)→ 回退 `chatLlm`,设备/单杯旧路径零变化。见文件头"鉴权"。
   */
  resolveChatLlm?: (cupId: string) => Promise<ChatLlm | null>;
  /** 对话记忆;不给则内存(不落盘) */
  chatMemory?: ChatStore;
  /**
   * 写端点鉴权 key(R10-B)。由上层(app.ts)决定:env `CUP_API_KEY` 优先;
   * 未设则由 createApp 生成随机 key(默认拒绝)。不给 = 未配置 —— 仍需鉴权,会 fail closed。
   */
  apiKey?: string;
  /**
   * 显式豁免读+写端点鉴权(R10-B / S4)—— **仅 dev/测试**。true 时写端点不再要
   * x-api-key、读端点不再要会话。默认 false(强制)。
   * 别再拿"未设 CUP_API_KEY"当开关,那是旧的隐式放行。
   */
  allowUnauth?: boolean;
  /** 账号 / 会话 / 市场 / 社交存储;不给则内存实现(不落盘) */
  accounts?: AccountsStore;
  /** 人格档案存储(#72:昵称 + 派生性格快照);不给则内存实现 */
  profiles?: ProfileStore;
  /** 首个管理员引导邮箱(env CUP_ADMIN_EMAIL);注册命中即 role='admin' */
  adminEmail?: string;
  /** 运维邮箱名单(env CUP_OPS_EMAILS);注册命中即 role='ops' */
  opsEmails?: readonly string[];
  /** 审核邮箱名单(env CUP_REVIEWER_EMAILS);注册命中即 role='reviewer' */
  reviewerEmails?: readonly string[];
  /** 可信绑定核验(claim code);见 core/social/claim.ts */
  claims?: ClaimService;
  /** 每杯模型配置(BYOK);给了则 `/ask` 用该杯自己的模型,并开放 `/cups/:id/llm` 读写口 */
  cupLlm?: CupLlmService;
  /**
   * 每杯当前生效的人格包(存储见 core/active-pack.ts);给了则开放 `/cups/:id/pack` 读写口。
   * 不给 → 该口回 503(不装死,也不静默丢配置)。包全文仍从 `accounts.packById` 取。
   */
  activePack?: CupActivePackStore;
  /**
   * 绑定杯子须出示一次性 claim code(默认 false → 只校验 cup_id 形状,与旧行为一致)。
   * 设备/模拟器两半验收后由用户开。
   */
  requireClaim?: boolean;
  /** 服务日志读写口(结构化日志落库);不给 → `/admin/logs` 返回空表(服务照常) */
  serverLogs?: ServerLogStore;
  /** 保留策略选项(psql 日志/遥测/事件保留天数);给 `POST /admin/logs/retain` 用 */
  retention?: RetentionOptions;
  /** pg 连接池(仅 PG 模式);给 `/admin/logs/partitions` + `retain` 用。无则两路由回空表/空数组。 */
  pgPool?: Pool;
  /** 触发保留清理时的报错口(默认静默);便于测试断言 */
  log?: (msg: string, level?: LogLevel) => void;
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
  const reqLog = (resolved.log ?? (() => {})) as (msg: string, level?: LogLevel) => void;
  return createServer((req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    // 请求 id:贯穿日志,便于把一条请求的多行串起来(也回给客户端便于对账)。
    const reqId = randomBytes(6).toString('hex');
    const started = Date.now();
    res.setHeader('x-request-id', reqId);
    // route 现在 async(Store 全 Promise 化):同步抛与异步拒绝一并在此收口。
    // headersSent 守卫:处理器可能已 send 后才抛(极罕见),避免二次写头。
    void route(req, res, resolved)
      .catch((err: unknown) => {
        if (!res.headersSent) send(res, 500, { error: (err as Error).message });
      })
      .finally(() => {
        // 一行/请求:方法 路径 → 状态 耗时(带 reqId,便于与客户端对账、串起该请求的多行)。
        // 5xx 记 error,4xx 记 warn,其余 info;/healthz 是探针,高频噪声 → 降到 debug(默认级别下不打)。
        const status = res.statusCode;
        const path = req.url ?? '/';
        const level: LogLevel = path === '/healthz' ? 'debug' : status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
        reqLog(
          `${req.method ?? 'GET'} ${path} → ${status} ${Date.now() - started}ms rid=${reqId}`,
          level,
        );
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
  if (path === '/market/subscriptions') {
    return await marketSubscriptionsRoute(req, res, deps);
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
  if (path === '/admin/logs') {
    return await adminLogsRoute(req, res, deps, url);
  }
  if (path === '/admin/logs/partitions') {
    return await adminLogPartitionsRoute(req, res, deps);
  }
  if (path === '/admin/logs/retain') {
    return await adminLogRetainRoute(req, res, deps);
  }

  // ── 杯子社交(#74;需登录会话)──
  if (path === '/social/friends') {
    return await socialFriendsRoute(req, res, deps);
  }
  const delFriend = path.match(/^\/social\/friends\/([^/]+)$/);
  if (delFriend) {
    return await socialFriendDeleteRoute(req, res, deps, decodeURIComponent(delFriend[1]!));
  }
  if (path === '/social/privacy') {
    return await socialPrivacyRoute(req, res, deps);
  }
  if (path === '/social/cup') {
    return await socialCupBindRoute(req, res, deps);
  }
  if (path === '/social/team') {
    return await socialTeamRoute(req, res, deps);
  }

  // ── 注销账号(删除第 4 阶段;需登录会话)──
  if (path === '/account') {
    return await accountDeleteRoute(req, res, deps);
  }

  const m = path.match(/^\/cups\/([^/]+)\/(today|series|events|state|goal|config|ask|ingest|report\/latest|report\/history|personality\/history|growth|profile|memory|llm|pack)$/);
  if (!m) {
    send(res, 404, { error: 'not found', path });
    return;
  }
  const cupId = decodeURIComponent(m[1]!);
  const action = m[2]!;
  const method = req.method ?? 'GET';

  // `/llm` = 用户给"自己那只杯"配模型(BYOK)→ 走**账号会话**闸(同 /social/*),不走设备 x-api-key。
  if (action === 'llm') return await cupLlmRoute(req, res, deps, cupId);

  // `/pack` = 用户给"自己那只杯"换当前生效人格包(P4.2)→ 同 `/llm` 走**会话 + 归属**闸。
  if (action === 'pack') return await cupPackRoute(req, res, deps, cupId);

  // `DELETE /memory` = 用户删"自己那只杯"的记忆(第 4 阶段三档删除)→ 同 `/llm` 走**账号会话**闸
  // (会话 + 归属),**不走设备 x-api-key** —— 共享的 x-api-key 不足以证明"你是这只杯的主人"。
  // 故它不在 isWriteEndpoint 的 x-api-key 写集合里 —— 这里已用更强的会话+归属闸把它短路掉了。
  if (action === 'memory' && (req.method ?? 'GET') === 'DELETE') {
    return await memoryDeleteRoute(req, res, deps, cupId, url);
  }

  // 端点守卫:写走 x-api-key,读走会话+归属(S4)。/healthz 与 OPTIONS 已在上游放行。
  if (!(await authorize(req, res, deps, method, action, cupId))) return;

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
    case 'growth':
      return await growthRoute(res, deps, cupId);
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
  const authDeps = {
    store: deps.accounts!,
    adminEmail: deps.adminEmail,
    opsEmails: deps.opsEmails,
    reviewerEmails: deps.reviewerEmails,
  };
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
    { store: deps.accounts!, adminEmail: deps.adminEmail, opsEmails: deps.opsEmails, reviewerEmails: deps.reviewerEmails },
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

/** 日志查看守卫:会话 + role ∈ {admin, ops, reviewer};未登录 → 401,其余角色 → 403 */
async function guardLogReader(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
): Promise<PublicUser | null> {
  const user = await guardUser(req, res, deps);
  if (!user) return null;
  if (user.role !== 'admin' && user.role !== 'ops' && user.role !== 'reviewer') {
    send(res, 403, { error: '需要运维/审核或管理员权限' });
    return null;
  }
  return user;
}

/** 日志运维守卫:会话 + role ∈ {admin, ops}(reviewer 只读,不得触发清理)→ 未登录 401,其余 403 */
async function guardLogOps(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
): Promise<PublicUser | null> {
  const user = await guardUser(req, res, deps);
  if (!user) return null;
  if (user.role !== 'admin' && user.role !== 'ops') {
    send(res, 403, { error: '需要运维或管理员权限' });
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

/**
 * GET /market/subscriptions → 200 { pack_ids: string[] }(当前登录用户订过的包;需登录)
 *
 * 只回 **已上架** 的包 —— 若订过的包后来被下架/驳回,订阅记录留着但不再生效,不返回,
 * 省得前端拿一个不存在的包去装。灭订阅记录不在此口(留待 v0 之后)。
 */
async function marketSubscriptionsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
): Promise<void> {
  const user = await guardUser(req, res, deps);
  if (!user) return;
  if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'use GET' });

  const ids = await deps.accounts!.subscriptions(user.user_id);
  const live: string[] = [];
  for (const id of ids) {
    const pack = await deps.accounts!.packById(id);
    if (pack && pack.status === 'approved') live.push(id);
  }
  send(res, 200, { pack_ids: live });
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

// ── 服务日志(admin/ops/reviewer 回看)───────────────────────────
//
// 读 = admin/ops/reviewer(guardLogReader);触发保留清理 = admin/ops(guardLogOps,reviewer 只读)。
// 无 PG(pool)时 `serverLogs` 为空 → `GET /admin/logs` 返回空表(服务照常),不报错。

/** 把 query 里的 level 参数(可重复或逗号分隔)解析成级别白名单;非法值丢弃。 */
function parseLevels(url: URL): LogLevel[] | undefined {
  const raw = url.searchParams.getAll('level').flatMap((v) => v.split(','));
  const out = raw.map((s) => s.trim().toLowerCase()).filter((s): s is LogLevel => (LOG_LEVELS as readonly string[]).includes(s));
  return out.length > 0 ? [...new Set(out)] : undefined;
}

/**
 * GET /admin/logs?level=&src=&q=&from=&to=&limit=&cursor=
 *   → 200 { logs: LogRow[], next_cursor: string | null }
 * 无日志 store → 空表。limit 缺省 100、上限 {@link LOG_PAGE_MAX}。
 */
async function adminLogsRoute(req: IncomingMessage, res: ServerResponse, deps: ApiDeps, url: URL): Promise<void> {
  const reader = await guardLogReader(req, res, deps);
  if (!reader) return;
  if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'use GET' });

  const q: LogQuery = {
    levels: parseLevels(url),
    q: url.searchParams.get('q') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
  };
  const src = url.searchParams.get('src');
  if (src !== null) q.src = src;
  const from = num(url.searchParams.get('from'));
  if (from !== null) q.from = from;
  const to = num(url.searchParams.get('to'));
  if (to !== null) q.to = to;
  const limit = num(url.searchParams.get('limit'));
  if (limit !== null) q.limit = Math.min(Math.max(1, limit), LOG_PAGE_MAX);

  if (!deps.serverLogs) return send(res, 200, { logs: [], next_cursor: null });
  const page = await deps.serverLogs.query(q);
  send(res, 200, { logs: page.rows, next_cursor: page.next_cursor });
}

/** GET /admin/logs/partitions → 200 { partitions: { name, bytes }[] };无 PG → 空。 */
async function adminLogPartitionsRoute(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  const reader = await guardLogReader(req, res, deps);
  if (!reader) return;
  if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'use GET' });
  if (!deps.pgPool) return send(res, 200, { partitions: [] });
  const names = await listPartitions(deps.pgPool, 'server_logs');
  const sizes = await query<{ relname: string; bytes: number | string }>(
    deps.pgPool,
    `SELECT c.relname AS relname, pg_total_relation_size(c.oid) AS bytes
       FROM pg_class c
       JOIN pg_inherits i ON i.inhrelid = c.oid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = $1`,
    ['server_logs'],
  );
  const byName = new Map(sizes.map((r) => [r.relname, Number(r.bytes)]));
  const partitions = names.map((name) => ({ name, bytes: byName.get(name) ?? 0 }));
  send(res, 200, { partitions });
}

/**
 * POST /admin/logs/retain → 200 { dropped: string[] }
 * **不可逆**(删过期整月分区);幂等。reviewer → 403(只读)。
 */
async function adminLogRetainRoute(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  const ops = await guardLogOps(req, res, deps);
  if (!ops) return;
  if ((req.method ?? 'GET') !== 'POST') return send(res, 405, { error: 'use POST' });
  if (!deps.pgPool) return send(res, 200, { dropped: [] });
  const dropped = await applyRetention(deps.pgPool, deps.retention ?? {}, deps.log ?? (() => {}));
  send(res, 200, { dropped });
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
  visible?: boolean,
): Promise<FriendView> {
  // P4.4 隐私开关:对方关掉可见 → 只给昵称(traits/streak 一律 null)。
  // 缺省(undefined) = 可见(设计稿 Q8)。「解绑杯子」也走同一出口(无 cupId = 本就无 traits)。
  if (!cupId || visible === false) return { user_id: userId, nickname, traits: null, streak: null };
  const { traits, streak } = await traitsForCup(deps, cupId);
  return { user_id: userId, nickname, traits, streak };
}

/**
 * GET    /social/friends     → 200 { friends: FriendView[] }(需登录)
 * POST   /social/friends { email } → 200 { friend: FriendView }(按邮箱加好友;需登录)
 *   · 加不存在的邮箱 → 404;加自己 → 400;重复加 → 幂等 200。
 * DELETE /social/friends/:id → 200 { ok: true }(删好友;P4.4,G5「只能加不能删」的出口)
 *   · 无向边,任一方向调都清掉那条边;不存在 → 幂等 200(不报错)。
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
      friends.push(await friendView(deps, id, a?.nickname ?? id, a?.cup_id, a?.visible));
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
    friend: await friendView(deps, target.user_id, target.nickname, target.cup_id, target.visible),
  });
}

/** DELETE /social/friends/:id → 200 { ok: true }(删好友;P4.4) */
async function socialFriendDeleteRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
  friendUserId: string,
): Promise<void> {
  const me = await guardUser(req, res, deps);
  if (!me) return;
  if ((req.method ?? 'GET') !== 'DELETE') return send(res, 405, { error: 'use DELETE' });
  await deps.accounts!.removeFriend(me.user_id, friendUserId);
  send(res, 200, { ok: true });
}

/**
 * GET /social/privacy → 200 { visible: boolean }(我的可见性开关;缺省 = true)
 * PUT /social/privacy { visible } → 200 { visible }(P4.4 隐私开关)
 */
async function socialPrivacyRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
): Promise<void> {
  const me = await guardUser(req, res, deps);
  if (!me) return;
  const method = req.method ?? 'GET';

  if (method === 'GET') {
    const acct = await deps.accounts!.accountById(me.user_id);
    return send(res, 200, { visible: acct?.visible !== false });
  }
  if (method !== 'PUT') return send(res, 405, { error: 'use GET or PUT' });

  const body = await readJson(req);
  const raw = (body as { visible?: unknown }).visible;
  if (typeof raw !== 'boolean') return send(res, 400, { error: 'visible 必须是布尔' });
  await deps.accounts!.setVisible(me.user_id, raw);
  send(res, 200, { visible: raw });
}

/**
 * GET    /social/cup             → 200 { cup_id: string|null }(我绑的杯子;没绑 = null)
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

  if (method === 'GET') {
    const acct = await deps.accounts!.accountById(me.user_id);
    return send(res, 200, { cup_id: acct?.cup_id ?? null });
  }
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
 * 成长快照(养成闭环,优先级 1)—— `GET /cups/:id/growth`(纯读,无 LLM,无落盘)。
 *
 * 与 /profile 的 traits 分工:那是**当下性格**(7 天窗口的达标率 / 温度 / 续杯);
 * 这是**随时间累积的成长进度**(一起多久 / 阶段 / 里程碑阶梯 / 今天新解锁什么),
 * 天然要更长窗口。数字全来自 `recentAggs`,派生逻辑在 core/growth.ts(纯函数,可单测)。
 *
 * 无任何数据 → 200 + 阶段「新生」+ 全未达成(正常态,非 404 —— 刚开箱就是这样)。
 */
async function growthRoute(res: ServerResponse, deps: ApiDeps, cupId: string): Promise<void> {
  const today = dayKey(Date.now());
  const recent = await deps.store.recentAggs(cupId, today, GROWTH_DAYS);
  const growth = deriveGrowth(recent);
  send(res, 200, { cup_id: cupId, today, growth });
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

/**
 * 记忆卡回看的天数上限 —— 「回忆」要翻"那年今日 / 一起第 N 天",一个月的窗口不够,
 * 放到一年有界(366 = 含闰年),仍走 `recentMemoryCards` 单次区间查询,不新增 store 方法。
 * recall 工具另有自己的窄窗口(见 chat/tools.ts),与此解耦,故这里放宽不影响喂模型的量。
 */
const MEMORY_DAYS_MAX = 366;
const MEMORY_DAYS_DEFAULT = 7;

/**
 * 长期记忆(第 3 阶段)—— 读端。`GET /cups/:id/memory`
 *   · `?day=YYYY-MM-DD` → 只取那天
 *   · `?recent=N`(≤366,默认 7)→ 最近 N 天(只含有卡的天)
 *   · `?all=1` → 取全部有卡的日(等价 `recent=366`,给「回忆」一次翻完)
 *   · `?build=1` → 先按需补建那天的卡(那天有数据/对话才建),再返回
 *
 * 返回 `{ cup_id, days: MemoryCard[] }`。**只读**(build=1 会写一张卡,但仍是幂等的封存)。
 * 三档删除(第 4 阶段)见下方 `memoryDeleteRoute`(同路由的 DELETE 方法)。
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

  // all=1 → 一年整窗(有界);否则按 recent(默认 7),同样钳到上限
  const all = url.searchParams.get('all') === '1';
  const raw = Number(url.searchParams.get('recent'));
  const days = all
    ? MEMORY_DAYS_MAX
    : Number.isFinite(raw) && raw >= 1
      ? Math.min(Math.floor(raw), MEMORY_DAYS_MAX)
      : MEMORY_DAYS_DEFAULT;
  const today = dayKey(Date.now());
  if (build) await closeDayCard(deps.store, memory, cupId, today, Date.now());
  const cards = await deps.store.recentMemoryCards(cupId, today, days);
  send(res, 200, { cup_id: cupId, days: cards });
}

/**
 * 长期记忆(第 4 阶段)—— **三档删除**。`DELETE /cups/:id/memory?scope=…`
 *
 * 鉴权**强于**设备写端点:走账号会话(401)+ **归属**(非本杯主人 403),不走共享 x-api-key ——
 * x-api-key 是设备面共享的,证明不了"你是这只杯的主人"(R18 修法的落点)。
 *
 * 三档(硬删、无墓碑;见计划「三档删除」):
 *   · `conversation` → 对话轮 + 长期画像(「聊过什么」)
 *   · `memory`       → 记忆卡 + 人格档案(「那些日子」)
 *   · `all`          → 以上全部 + telemetry/events/daily_agg/goal/最新样本(一切都归零)
 *
 * scope 必填且必须合法 —— 不默认、不猜测,免得手滑删光。
 */
async function memoryDeleteRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
  cupId: string,
  url: URL,
): Promise<void> {
  const me = await guardUser(req, res, deps);
  if (!me) return;
  if (!(await guardCupOwner(res, deps, cupId, me.user_id))) return;

  const raw = url.searchParams.get('scope') ?? '';
  if (raw !== 'conversation' && raw !== 'memory' && raw !== 'all') {
    return send(res, 400, { error: 'scope 需为 conversation / memory / all' });
  }
  const scope: DeleteScope = raw;

  // Store 域:conversation 档在 Store 名下无事(no-op);memory 只删卡;all 全删。
  const counts = await deps.store.forget(cupId, scope);
  const done = { conversation: false, memory: false, traits: false };
  if (scope === 'conversation' || scope === 'all') {
    await deps.chatMemory?.deleteTurns(cupId);
    await deps.chatMemory?.deleteProfile(cupId);
    done.conversation = true;
  }
  if (scope === 'memory' || scope === 'all') {
    await deps.profiles?.delete(cupId);
    done.traits = true;
  }
  send(res, 200, { cup_id: cupId, scope, deleted: { ...done, counts } });
}

/**
 * 账号注销(第 4 阶段)—— `DELETE /account`。需登录会话。
 *   · 先抹掉该账号**名下那只杯**的全部数据(等价 `scope=all`),再删账号 + 会话。
 *   · 硬删,无墓碑(GDPR「被遗忘权」面);账号未绑杯 → 只删账号本身。
 * 杯子的原始遥测另有**保留期**约束(分区策略),与此处的账号级删除是两条独立线。
 */
async function accountDeleteRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
): Promise<void> {
  if ((req.method ?? 'GET') !== 'DELETE') return send(res, 405, { error: 'use DELETE' });
  const me = await guardUser(req, res, deps);
  if (!me) return;

  const acct = await deps.accounts!.accountById(me.user_id);
  const cupId = acct?.cup_id ?? null;
  if (cupId) {
    await deps.store.forget(cupId, 'all');
    await deps.chatMemory?.deleteTurns(cupId);
    await deps.chatMemory?.deleteProfile(cupId);
    await deps.profiles?.delete(cupId);
  }
  await deps.accounts!.deleteAccount(me.user_id); // 账号 + 订阅 + 好友边
  await deps.accounts!.dropSessionsForUser(me.user_id); // 旧令牌立即失效
  send(res, 200, { user_id: me.user_id, cup_id: cupId, deleted: true });
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
  // 用户自选模型:配了(stored 非 null)则本杯走**账户鉴权** —— 登录 401 / 非本杯 403,
  // 并改用该杯模型;未配 → 下面的 chatDeps.chat 回退全局 chatLlm(设备/单杯旧路径零变化)。
  const chat: ChatLlm | null = deps.resolveChatLlm ? await deps.resolveChatLlm(cupId) : null;
  if (chat) {
    const user = await resolveSession(
      { store: deps.accounts!, adminEmail: deps.adminEmail, opsEmails: deps.opsEmails, reviewerEmails: deps.reviewerEmails },
      bearerToken(req.headers['authorization']),
    );
    if (!user) return send(res, 401, { error: 'unauthorized' });
    const account = deps.accounts ? await deps.accounts.accountById(user.user_id) : null;
    if (account?.cup_id !== cupId) {
      return send(res, 403, { error: '这只杯不属于你' });
    }
  }
  const chatDeps: ChatDeps = {
    store: deps.store,
    commands: deps.commands,
    chat: chat ?? deps.chatLlm ?? new NullChatLlm(),
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
 * 归属校验 —— 会话用户是否是这只杯的主人(`Account.cup_id` 指向该杯)。
 * 与 `/llm` / 将来的删除端点共用:数据随杯走,故"能操作这只杯"= 账户已绑它。
 * 未绑 / 绑的是别只杯 → 一律 403(**不区分**,不给探测他人杯 id 的 oracle)。
 * @returns true = 放行;false = 已回 403,调用方应 return。
 */
async function guardCupOwner(
  res: ServerResponse,
  deps: ApiDeps,
  cupId: string,
  userId: string,
): Promise<boolean> {
  const acct = await deps.accounts!.accountById(userId);
  if (acct?.cup_id !== cupId) {
    send(res, 403, { error: '无权操作该杯' });
    return false;
  }
  return true;
}

/**
 * 每杯模型配置(BYOK)—— `GET/PUT/DELETE /cups/:id/llm`。
 *
 * 与设备写端点(/goal、/config 走 x-api-key)**不同**:这是"用户给自己那只杯配模型",
 * 是**账号行为** → 走**会话闸**(Authorization: Bearer,同 /social/*),再叠**归属**:
 * 只有已绑这只杯的用户能读写它的模型配置(否则 403)。
 *
 * 出口永远是 `CupLlmPublic` —— 绝不含 key(明文或密文);`key` 进来只经 `CupLlmService`
 * 加密后落库,HTTP 层不碰 crypto、不回显。
 */
async function cupLlmRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
  cupId: string,
): Promise<void> {
  const me = await guardUser(req, res, deps);
  if (!me) return;
  if (!(await guardCupOwner(res, deps, cupId, me.user_id))) return;
  const svc = deps.cupLlm;
  if (!svc) return send(res, 503, { error: '本实例未启用每杯模型配置' });
  const method = req.method ?? 'GET';

  if (method === 'GET') {
    const cfg = await svc.get(cupId);
    return send(res, 200, { cup_id: cupId, config: cfg });
  }

  if (method === 'DELETE') {
    await svc.clear(cupId);
    return send(res, 200, { cup_id: cupId, config: null });
  }

  if (method !== 'PUT') return send(res, 405, { error: 'use GET, PUT or DELETE' });

  const body = await readJson(req);
  const b = (body ?? {}) as Record<string, unknown>;
  const provider = b.provider;
  if (!isCupLlmProvider(provider)) {
    return send(res, 400, { error: "provider 需为 'anthropic' 或 'openai'" });
  }
  const model = typeof b.model === 'string' ? b.model.trim() : '';
  if (model.length === 0 || model.length > 128) {
    return send(res, 400, { error: 'model 需为非空字符串(≤128 字)' });
  }
  let baseUrl: string | undefined;
  if (typeof b.base_url === 'string' && b.base_url.trim().length > 0) {
    if (b.base_url.length > 512) return send(res, 400, { error: 'base_url 过长' });
    baseUrl = b.base_url.trim();
  }
  // key 可省 / 空串 → 沿用已有密文(只改模型/端点时不逼用户重填 key)。
  let key: string | undefined;
  if (typeof b.key === 'string' && b.key.trim().length > 0) {
    if (b.key.length > 4096) return send(res, 400, { error: 'key 过长' });
    key = b.key.trim();
  }
  const input = baseUrl !== undefined ? { provider, model, base_url: baseUrl, key } : { provider, model, key };
  const cfg = await svc.set(cupId, input);
  send(res, 200, { cup_id: cupId, config: cfg });
}

/**
 * 当前生效人格包(P4.2)—— `GET/PUT/DELETE /cups/:id/pack`。
 *
 * 与 `/llm` 同类:这是**账号行为**(给自己那只杯换人格包),故走**会话闸 + 归属**,
 * 不走设备 x-api-key。出口恒为**包全文**(前端渲染要 thresholds/wave;没装 → `pack: null`),
 * 与设计稿 §2.4 A 一致:「回当前生效的包全文」。
 *
 * 存储是 `CupActivePackStore`(per-CUP,只存 `cup_id → pack_id` 关系,见 core/active-pack.ts);
 * 包全文从 `deps.accounts.packById` 取。**装了才生效**:PUT 只落杯级那一行,不写回 per-user
 * 的 `subscriptions`(订阅 ≠ 生效)。未配该 store → 503(不装死,也不静默丢配置)。
 */
async function cupPackRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
  cupId: string,
): Promise<void> {
  const me = await guardUser(req, res, deps);
  if (!me) return;
  if (!(await guardCupOwner(res, deps, cupId, me.user_id))) return;
  const store = deps.activePack;
  if (!store) return send(res, 503, { error: '本实例未启用杯子人格包切换' });
  const method = req.method ?? 'GET';

  if (method === 'GET') {
    const id = await store.get(cupId);
    const pack = id ? await deps.accounts?.packById(id) : null;
    // 包被下架/删掉 → 视同没装(别把悬垂 id 的包回给前端)
    return send(res, 200, { pack: pack && pack.status === 'approved' ? pack : null });
  }

  if (method === 'DELETE') {
    await store.clear(cupId);
    return send(res, 200, { pack: null });
  }

  if (method !== 'PUT') return send(res, 405, { error: 'use GET, PUT or DELETE' });

  const body = await readJson(req);
  const packId = (body as { pack_id?: unknown }).pack_id;
  if (typeof packId !== 'string' || packId.trim().length === 0) {
    return send(res, 400, { error: '缺 pack_id' });
  }
  const pack = await deps.accounts?.packById(packId.trim());
  if (!pack || pack.status !== 'approved') {
    return send(res, 404, { error: '包不存在或未上架' });
  }
  await store.set(cupId, pack.pack_id);
  send(res, 200, { pack });
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
 * 读端点判定 —— **按方法 + 动作显式列举**,与写端点对称。
 *
 * 为什么要单独一张表而不是"非写即读":`GET /ingest`、`GET /config` 之类**方法不对**的
 * 请求应落到下游的 405(只收 POST),不能被读闸拦成 401 —— 否则错误码撒谎。
 * `profile`/`memory` 的 GET 是读、PUT/POST 是写;`llm` 端点自带会话闸(不走这里)。
 */
function isReadEndpoint(method: string, action: string): boolean {
  if (method !== 'GET') return false;
  return (
    action === 'today' ||
    action === 'series' ||
    action === 'events' ||
    action === 'state' ||
    action === 'report/latest' ||
    action === 'report/history' ||
    action === 'personality/history' ||
    action === 'growth' ||
    action === 'profile' ||
    action === 'memory'
  );
}

/**
 * 端点鉴权,收口一处 —— **两条轴**,默认都强制。
 *
 * 写端点(`isWriteEndpoint` 真)→ **设备钥**:必须带 `x-api-key` 且值相等,否则 401。
 * 读端点(`isReadEndpoint` 真)→ **账号会话 + 归属**(S4):未登录 401;登录了但杯不归你 403。
 *   · allowUnauth → 显式豁免读+写(仅 dev/测试),优先于两者。
 *   · 既非写也非读(如 `GET /ingest` 这类**方法不对**的请求)→ **放行**,落到下游的
 *     405,别拿 401 撒谎(方法错 ≠ 没授权)。
 *
 * @returns true = 放行继续处理;false = 已回 401/403,调用方应 return。
 */
async function authorize(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
  method: string,
  action: string,
  cupId: string,
): Promise<boolean> {
  if (deps.allowUnauth) return true; // 显式豁免(dev/测试),读+写通吃

  if (isWriteEndpoint(method, action)) {
    const key = deps.apiKey;
    const header = req.headers['x-api-key'];
    const provided = Array.isArray(header) ? header[0] : header;
    if (key && provided === key) return true;
    send(res, 401, { error: 'unauthorized' });
    return false;
  }

  if (isReadEndpoint(method, action)) {
    // 读端点:账号会话 + 归属(数据随杯走,故"能读" = 账户已绑它)。
    const me = await guardUser(req, res, deps);
    if (!me) return false; // 未登录 → 已回 401
    return guardCupOwner(res, deps, cupId, me.user_id); // 非主人 → 已回 403
  }

  return true; // 既非写也非读(方法不对)→ 让下游回 405
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
