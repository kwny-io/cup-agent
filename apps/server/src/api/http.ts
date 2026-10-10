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
  log?: (msg: string, level?: 'info' | 'warn' | 'error') => void;
}

export function createApiServer(deps: ApiDeps): Server {
  // 只解析一次:对话模型与记忆必须是**跨请求存活**的实例(否则每问一句就失忆)
  const resolved: ApiDeps = {
    ...deps,
    chatLlm: deps.chatLlm ?? new NullChatLlm(),
    chatMemory: deps.chatMemory ?? new MemoryChatStore(),
  };
  return createServer((req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    try {
      route(req, res, resolved);
    } catch (err) {
      send(res, 500, { error: (err as Error).message });
    }
  });
}

function route(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): void {
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

  const m = path.match(/^\/cups\/([^/]+)\/(today|series|events|state|goal|config|ask|report\/latest|report\/history|personality\/history)$/);
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
      return today(res, deps, cupId);
    case 'series':
      return series(res, deps, cupId, url);
    case 'events':
      return events(res, deps, cupId, url);
    case 'state':
      return state(res, deps, cupId);
    case 'goal':
      return setGoal(req, res, deps, cupId);
    case 'config':
      return setConfig(req, res, deps, cupId);
    case 'ask':
      return askRoute(req, res, deps, cupId);
    case 'report/latest':
      return void reportRoute(res, deps, cupId);
    case 'report/history':
      return historyRoute(res, deps, cupId, url);
    case 'personality/history':
      return personalityHistoryRoute(res, deps, cupId, url);
  }
}

// ── 处理器 ─────────────────────────────────────────────────────────

function today(res: ServerResponse, deps: ApiDeps, cupId: string): void {
  const now = Date.now();
  const date = dayKey(now);
  const dayEnd = dayStart(date) + 86_400_000;
  const agg = deps.store.agg(cupId, date);
  const recentEvents = deps.store.events(cupId, dayStart(date), dayEnd).slice(-8).reverse();
  const sample = deps.store.latestSample(cupId);
  send(res, 200, {
    cup_id: cupId,
    date,
    drank_ml: agg?.drank_ml ?? 0,
    goal_ml: agg?.goal_ml ?? deps.store.goal(cupId),
    drink_count: agg?.drink_count ?? 0,
    progress: progressPct(agg?.drank_ml ?? 0, agg?.goal_ml ?? deps.store.goal(cupId)),
    temp_min_c: agg?.temp_min_c ?? null,
    temp_max_c: agg?.temp_max_c ?? null,
    temp_avg_c: agg?.temp_avg_c ?? null,
    streak: agg?.streak ?? 0,
    current_volume_ml: sample?.volume_ml ?? null,
    current_temp_c: sample?.temp_c ?? null,
    recent_events: recentEvents,
  });
}

function series(res: ServerResponse, deps: ApiDeps, cupId: string, url: URL): void {
  const range = url.searchParams.get('range') ?? 'day';
  const now = Date.now();
  if (range === 'week') {
    const today = dayKey(now);
    const buckets = deps.store.recentAggs(cupId, today, 7).map((a) => ({
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

  for (const e of deps.store.events(cupId, from, to)) {
    const h = Math.min(23, Math.floor((e.ts - from) / hourMs));
    const b = buckets[h]!;
    if (e.type === 'drink') b.drank_ml += e.amount_ml ?? 0;
    else if (e.type === 'refill') b.refill_ml += e.amount_ml ?? 0;
  }
  for (const p of deps.store.telemetry(cupId, from, to)) {
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

function events(res: ServerResponse, deps: ApiDeps, cupId: string, url: URL): void {
  const from = num(url.searchParams.get('from')) ?? 0;
  const to = num(url.searchParams.get('to')) ?? Date.now();
  const list = deps.store.events(cupId, from, to);
  send(res, 200, { cup_id: cupId, from, to, count: list.length, events: list });
}

function state(res: ServerResponse, deps: ApiDeps, cupId: string): void {
  const sample = deps.store.latestSample(cupId);
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
  const recent = deps.store
    .recentAggs(cupId, today, 7)
    .filter((d) => d.updated_at > 0 || d.event_count > 0);
  const agg = deps.store.agg(cupId, today);
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
function historyRoute(res: ServerResponse, deps: ApiDeps, cupId: string, url: URL): void {
  const raw = Number(url.searchParams.get('days'));
  const days = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), HISTORY_DAYS_MAX) : HISTORY_DAYS;
  const today = dayKey(Date.now());
  const recent = deps.store.recentAggs(cupId, today, days);
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
function personalityHistoryRoute(res: ServerResponse, deps: ApiDeps, cupId: string, url: URL): void {
  const raw = Number(url.searchParams.get('days'));
  const days = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), HISTORY_DAYS_MAX) : HISTORY_DAYS;
  const today = dayKey(Date.now());
  const recent = deps.store.recentAggs(cupId, today, days);
  const timeline = dispositionTimeline(recent);
  send(res, 200, { cup_id: cupId, days: timeline, count: timeline.length });
}

function setGoal(req: IncomingMessage, res: ServerResponse, deps: ApiDeps, cupId: string): void {
  if (req.method !== 'PUT') return send(res, 405, { error: 'use PUT' });
  readJson(req).then((body) => {
    const goal = num((body as { goal_ml?: unknown }).goal_ml);
    if (goal === null || goal <= 0 || goal > 10_000) {
      send(res, 400, { error: 'goal_ml 需为 0–10000 的正数' });
      return;
    }
    deps.store.setGoal(cupId, goal);
    send(res, 200, { cup_id: cupId, goal_ml: goal, default_goal_ml: DEFAULT_GOAL_ML });
  });
}

function setConfig(req: IncomingMessage, res: ServerResponse, deps: ApiDeps, cupId: string): void {
  if (req.method !== 'POST') return send(res, 405, { error: 'use POST' });
  readJson(req).then((body) => {
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
  });
}

/**
 * 对话(P4):`POST /cups/:id/ask { q }` → 杯子用真实数据回答。
 *
 * 鉴权:写端点,配了 CUP_API_KEY 时须带 x-api-key(见文件头);问句长度硬限,超限 400 —— 不让超长输入进提示词。
 * 回答永不空白:模型缺席/出错/守卫拦下 → runChat 内部回退确定性模板句。
 */
function askRoute(req: IncomingMessage, res: ServerResponse, deps: ApiDeps, cupId: string): void {
  if (req.method !== 'POST') return send(res, 405, { error: 'use POST' });
  readJson(req).then(async (body) => {
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
  if (!isWriteEndpoint(method, action)) return true; // 读端点放行
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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-api-key');
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
