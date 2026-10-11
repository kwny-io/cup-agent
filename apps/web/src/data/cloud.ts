/**
 * 连后端的 WebSocket 数据源 —— 架构 §6.3 里的 CloudSource(M1 之后)。
 *
 * 与 SimulatorSource 的区别:
 *   模拟器源直连假杯子,拿的是原始遥测;
 *   云源连**后端**,拿的是后端**已融合、已聚合**过的东西 —— 这才是产品形态。
 *
 * 后端 WS 协议(见 apps/server/src/api/live.ts):
 *   每行一条 {kind, cup_id, payload}
 *     hello      连上先发,跳过
 *     telemetry  payload = TelemetryPoint(带原始 lid/base)→ 还原成 LiveFrame 喂杯子
 *     event      payload = CupEvent → 进事件流
 *     sample     payload = FusedSample(后端融合结果)→ 看板水位/水量的真身
 *
 * 看板要的"今日已喝 / 次数 / 水温 / 连续天数"是**跨天聚合**,WS 给不了,
 * 所以这里额外**拉 REST** `/today`(混合模式:推送走 WS,快照走 REST)。
 * 这也正是 lib/stats.ts 注释里说的"M1 后端上线后,数字由后端日聚合给出"。
 */
import { BaseTelemetrySchema, EventSchema, LidTelemetrySchema } from '@cup/contract';
import type { BaseTelemetry, CupEvent, LidTelemetry } from '@cup/contract';
import {
  Emitter,
  isChatAnswer,
  isProactiveMessage,
  isServerHistory,
  isServerPersonalityHistory,
  isServerSeries,
  type AskResult,
  type DataSource,
  type GoalResult,
  type LiveFrame,
  type ProactiveMessage,
  type ServerHistory,
  type ServerPersonalityHistory,
  type ServerReport,
  type ServerToday,
  type ServerSeries,
  type SocialApi,
} from './source.ts';
import { postJson, putJson, type HttpOutcome } from './http.ts';
import { CloudSocial } from './social.ts';

export interface CloudOptions {
  /** 后端 API 根,如 http://localhost:8788 */
  apiBase?: string;
  /** 订阅哪个杯(id 由配对决定,先用模拟器默认) */
  cupId?: string;
  /** 直给 WS 地址;缺省由 apiBase 推导成 /cups/:id/live */
  wsUrl?: string;
  /** 拉 /today 的间隔 ms(0 = 只在连上时拉一次) */
  pollMs?: number;
  /** 拉 /report/latest 的间隔 ms(0 = 只在连上时拉一次);战报变化慢,默认 60s */
  reportMs?: number;
  /** /ask 超时 ms(超过即判 timeout,不让 UI 无限等);默认 15s */
  askTimeoutMs?: number;
  /**
   * 写请求(POST/PUT)的 API key(R10-B 起后端写端点默认鉴权)。
   * 只发往写端点;缺省 / 空串 → 不带该头,读路径始终不受影响。
   */
  apiKey?: string;
}

const DEFAULT_API = 'http://localhost:8788';
const DEFAULT_CUP = 'cup-A1B2C3';

/**
 * 归一化 API 根:
 *   `?cloud=1`(开关式)→ 默认后端;`?cloud=http://host:port` → 指定后端。
 * 也容忍省略协议的 `localhost:8788`。
 */
function resolveApiBase(raw: string | undefined): string {
  if (!raw || raw === '1' || raw === 'true') return DEFAULT_API;
  if (/^https?:\/\//.test(raw)) return raw.replace(/\/+$/, '');
  return `http://${raw.replace(/\/+$/, '')}`;
}

export class CloudSource implements DataSource {
  readonly kind = 'cloud';
  private apiBase: string;
  private cupId: string;
  private wsUrl: string;
  private pollMs: number;
  private reportMs: number;
  private askTimeoutMs: number;
  /** 写端点鉴权密钥(秘密:不落盘、不打日志、不进 URL) */
  private apiKey: string;
  /**
   * 多用户 / 市场 / 社交面(#72/#73/#74)—— 拉式 REST,与 WS 遥测无关,
   * 故拆成独立小对象(见 ./social.ts)。模拟器 / mock 源没有这块。
   */
  readonly social: SocialApi;

  private ws: WebSocket | null = null;
  private em = new Emitter();
  private buffer: LiveFrame = { events: [] };
  private flushScheduled = false;
  private stopped = false;
  private retryMs = 500;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reportTimer: ReturnType<typeof setInterval> | null = null;
  /** 事件去重:重连会重拉当天历史,不挡会与实时事件重复 */
  private seen = new Set<string>();
  private seenOrder: string[] = [];

  constructor(opts: CloudOptions = {}) {
    this.apiBase = resolveApiBase(opts.apiBase);
    this.cupId = opts.cupId ?? DEFAULT_CUP;
    this.wsUrl = opts.wsUrl ?? deriveWs(this.apiBase, this.cupId);
    this.pollMs = opts.pollMs ?? 5000;
    this.reportMs = opts.reportMs ?? 60_000;
    this.askTimeoutMs = opts.askTimeoutMs ?? 15_000;
    this.apiKey = opts.apiKey ?? '';
    this.social = new CloudSocial({ apiBase: this.apiBase, cupId: this.cupId, apiKey: this.apiKey });
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  disconnect(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopPolling();
    this.stopReports();
    this.ws?.close();
    this.ws = null;
    this.em.emit('state', 'closed');
  }

  on<K extends 'frame' | 'state' | 'server' | 'report' | 'proactive' | 'series' | 'daySeries' | 'history' | 'personality'>(
    evt: K,
    cb: Parameters<DataSource['on']>[1],
  ): () => void {
    return this.em.on(evt, cb as never);
  }

  /**
   * 问杯子一句话 —— `POST /cups/:cupId/ask`。
   *
   * 与 WS 那些"推"不同,这是**拉**:用户打字才发。
   *
   * 契约:**从不 reject**,失败也 resolve 成 {ok:false, reason} —— 让调用方
   * 只需一条路径处理,避免忘记 catch 时 pending 永久卡死。带 askTimeoutMs 超时:
   * 后端挂着不回包时不会把 UI 无限期钉在"杯子在想…"。
   * LLM 秒级延迟,默认给 15s(模板兜底会更快,这是上限)。
   */
  async ask(q: string): Promise<AskResult> {
    const res = await this.postJson<{ cup_id?: string; answer?: unknown }>(
      `/cups/${encodeURIComponent(this.cupId)}/ask`,
      { q },
      this.askTimeoutMs,
    );
    if (res.kind !== 'ok') return { ok: false, reason: res.kind };
    const answer = res.data?.answer;
    return isChatAnswer(answer) ? { ok: true, answer } : { ok: false, reason: 'invalid' };
  }

  /**
   * 改每日目标 —— `PUT /cups/:cupId/goal`,体 { goal_ml }。
   *
   * 契约与 ask 一致:**从不 reject**,失败 resolve 成 {ok:false, reason}。
   * 成功后**立刻**补拉一次 `/today`:目标是要立刻反映到看板所有卡(今日进度条 /
   * 打卡 / 趋势达标线)上的,不能等下一次 WS 或 5s 轮询 —— 那会让用户以为没生效。
   * 不乐观改前端值:以后端回包里的 goal_ml 为准(后端才是真相源)。
   */
  async setGoal(goalMl: number): Promise<GoalResult> {
    const res = await this.putJson<{ cup_id?: string; goal_ml?: unknown }>(
      `/cups/${encodeURIComponent(this.cupId)}/goal`,
      { goal_ml: goalMl },
      this.askTimeoutMs,
    );
    if (res.kind !== 'ok') return { ok: false, reason: res.kind };
    const g = res.data?.goal_ml;
    if (typeof g !== 'number') return { ok: false, reason: 'invalid' };
    void this.fetchToday(); // 立即回灌,让看板所有卡同步
    return { ok: true, goalMl: g };
  }

  private open(): void {
    if (this.stopped) return;
    this.em.emit('state', 'connecting');
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    // StrictMode 双挂载 / 重连:只认"当前"这个 socket 的事件(同 SimulatorSource)
    const current = () => this.ws === ws;

    ws.onopen = () => {
      if (!current()) return;
      this.retryMs = 500;
      this.em.emit('state', 'open');
      // 连上先补一次历史 + 今日快照,免得看板空着等第一条数据
      void this.seed();
      this.startPolling();
      this.startReports();
    };
    ws.onclose = () => {
      if (!current()) return;
      this.stopPolling();
      this.stopReports();
      this.scheduleRetry();
    };
    ws.onerror = () => {
      if (!current()) return;
      this.em.emit('state', 'error');
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (!current()) return;
      const text = typeof ev.data === 'string' ? ev.data : '';
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          continue;
        }
        this.absorb(raw);
      }
    };
  }

  private scheduleRetry(): void {
    if (this.stopped) {
      this.em.emit('state', 'closed');
      return;
    }
    this.em.emit('state', 'connecting');
    this.retryTimer = setTimeout(() => this.open(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 5000);
  }

  /** 解析一行后端帧,按 kind 分流 */
  private absorb(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const frame = raw as { kind?: unknown; payload?: unknown };
    switch (frame.kind) {
      case 'telemetry': {
        // TelemetryPoint:{lid?, base?}(后端内部类型,这里按结构取)
        const p = frame.payload as { lid?: unknown; base?: unknown } | null;
        if (!p) return;
        const lid = LidTelemetrySchema.safeParse(p.lid);
        if (lid.success) {
          this.buffer.lid = lid.data as LidTelemetry;
          this.markDirty();
        }
        const base = BaseTelemetrySchema.safeParse(p.base);
        if (base.success) {
          this.buffer.base = base.data as BaseTelemetry;
          this.markDirty();
        }
        return;
      }
      case 'event': {
        const e = EventSchema.safeParse(frame.payload);
        if (e.success && this.noteEvent(e.data as CupEvent)) this.markDirty();
        return;
      }
      case 'proactive': {
        const m = frame.payload;
        if (isProactiveMessage(m)) this.em.emit('proactive', m as ProactiveMessage);
        return;
      }
      case 'sample':
      case 'hello':
        return; // 融合样本暂不给杯子;杯子要原始 tid 才动得起来
    }
  }

  /** 事件去重:同 (ts,type,amount) 只认一次 */
  private noteEvent(e: CupEvent): boolean {
    const key = `${e.ts}|${e.type}|${e.amount_ml ?? ''}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.seenOrder.push(key);
    if (this.seenOrder.length > 4096) {
      const old = this.seenOrder.shift();
      if (old) this.seen.delete(old);
    }
    return true;
  }

  private markDirty(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.flushScheduled = false;
    const f = this.buffer;
    this.buffer = { events: [] };
    if (!f.lid && !f.base && f.events.length === 0) return;
    this.em.emit('frame', f);
  }

  // ── REST:今日快照 + 当天历史(WS 之外的补齐)─────────────────────

  private seed(): void {
    void this.fetchToday();
    void this.fetchTodayEvents();
    void this.fetchReport();
    void this.fetchSeries();
    void this.fetchDaySeries();
    void this.fetchHistory();
    void this.fetchPersonality();
  }

  private startPolling(): void {
    if (this.pollTimer || this.pollMs <= 0) return;
    this.pollTimer = setInterval(() => void this.fetchToday(), this.pollMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** 战报变化慢(一天一句),用低频轮询即可;连上先拉一次 */
  private startReports(): void {
    if (this.reportTimer || this.reportMs <= 0) return;
    this.reportTimer = setInterval(() => {
      void this.fetchReport();
      // 趋势卡里"今天"那根柱子会随当天饮水增长 —— 只拉一次会让它整会话冻结,
      // 与旁边实时更新的"今日"面板自相矛盾。搭战报的同档低频一起刷。
      void this.fetchSeries();
      // 饮水曲线今日那根时柱同理:会随当天增长,不刷就冻结(同档低频)
      void this.fetchDaySeries();
      // 历史里"今天"那条(喝了多少/headline)同样会随当天增长,同档低频刷
      void this.fetchHistory();
      // 脾气变化史末日的 disposition 随今天是否达标而变,同档低频刷
      void this.fetchPersonality();
    }, this.reportMs);
  }

  private stopReports(): void {
    if (this.reportTimer) clearInterval(this.reportTimer);
    this.reportTimer = null;
  }

  private async fetchToday(): Promise<void> {
    const today = await this.getJson<ServerToday>(
      `/cups/${encodeURIComponent(this.cupId)}/today`,
    );
    if (today) this.em.emit('server', today);
  }

  /**
   * 拉战报。今天还没数据时后端返回 404 → getJson 得 null,静默不 emit
   * (前端保持"暂无战报",不编一份空的)。有则把成品文案 + 长期性格送出去。
   */
  private async fetchReport(): Promise<void> {
    const r = await this.getJson<ServerReport>(
      `/cups/${encodeURIComponent(this.cupId)}/report/latest`,
    );
    if (r) this.em.emit('report', r);
  }

  /**
   * 拉近 7 天趋势(趋势卡用)。跨天聚合,后端日聚合里就有 —— WS 给不了,
   * 所以跟 today/report 一样走 REST 补齐。连上拉一次即可(按天变,不必高频轮询)。
   */
  private async fetchSeries(): Promise<void> {
    const s = await this.getJson<ServerSeries>(
      `/cups/${encodeURIComponent(this.cupId)}/series?range=week`,
    );
    if (isServerSeries(s)) this.em.emit('series', s);
  }

  /**
   * 拉今日 24 小时分桶(饮水曲线用)。云模式只收得到"连上之后"的 WS 事件,
   * 今天早些时候的喝水量拿不到 —— 曲线若自己现算会少半截。后端这份是**整天**分桶,
   * 故曲线以后端为准;没有后端(mock / 纯模拟器)时组件回落 `hourlyIntake`。
   */
  private async fetchDaySeries(): Promise<void> {
    const s = await this.getJson<ServerSeries>(
      `/cups/${encodeURIComponent(this.cupId)}/series?range=day`,
    );
    if (isServerSeries(s)) this.em.emit('daySeries', s);
  }

  /**
   * 拉历史战报(逐日回看卡用)。跨天聚合,后端日聚合里就有 —— WS 给不了,
   * 同 today/report/series 走 REST 补齐。历史变化慢(一天最多多一条),低频即可。
   */
  private async fetchHistory(): Promise<void> {
    const h = await this.getJson<ServerHistory>(
      `/cups/${encodeURIComponent(this.cupId)}/report/history`,
    );
    if (isServerHistory(h)) this.em.emit('history', h);
  }

  /**
   * 拉脾气变化史(养成卡用)。逐日长期性格,后端由 computePersonality 逐日切片 —— WS 给不了,
   * 同 today/report/history 走 REST 补齐。变化慢(一天最多多一条),低频即可。
   */
  private async fetchPersonality(): Promise<void> {
    const p = await this.getJson<ServerPersonalityHistory>(
      `/cups/${encodeURIComponent(this.cupId)}/personality/history`,
    );
    if (isServerPersonalityHistory(p)) this.em.emit('personality', p);
  }

  private async fetchTodayEvents(): Promise<void> {
    const from = dayStart(Date.now());
    const to = from + 86_400_000;
    const res = await this.getJson<{ events?: CupEvent[] }>(
      `/cups/${encodeURIComponent(this.cupId)}/events?from=${from}&to=${to}`,
    );
    if (!res?.events) return;
    for (const e of res.events) {
      if (EventSchema.safeParse(e).success && this.noteEvent(e)) {
        this.buffer.events.push(e);
      }
    }
    if (this.buffer.events.length > 0) this.markDirty();
  }

  private async getJson<T>(path: string): Promise<T | null> {
    try {
      const r = await fetch(`${this.apiBase}${path}`);
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch {
      return null; // 后端没起 / 网络抖:静默,WS 重连与轮询会再试
    }
  }

  /**
   * 写端点的鉴权头:仅在配了非空 key 时带 —— 未配时与旧行为逐字一致(不出现该头)。
   * 之所以在这里现拼而非构造时固定:key 为空时绝不能发出 `x-api-key: ''`。
   */
  private authHeaders(): Record<string, string> {
    return this.apiKey !== '' ? { 'x-api-key': this.apiKey } : {};
  }

  /**
   * POST 并解析 JSON。与 getJson 不同:返回**带原因**的结果,而不是一律 null ——
   * 因为 ask 需要区分"没连上 / 超时 / 后端报错"给用户不同的提示。
   * 实体在 ./http.ts(postJson),抽出去是为了可单测。
   */
  private postJson<T>(
    path: string,
    body: unknown,
    timeoutMs = 0,
  ): Promise<HttpOutcome<T>> {
    return postJson<T>(`${this.apiBase}${path}`, body, timeoutMs, fetch, this.authHeaders());
  }

  /** 与 postJson 同;分离只因目标端点是 PUT。实体同样在 ./http.ts,可单测。 */
  private putJson<T>(
    path: string,
    body: unknown,
    timeoutMs = 0,
  ): Promise<HttpOutcome<T>> {
    return putJson<T>(`${this.apiBase}${path}`, body, timeoutMs, fetch, this.authHeaders());
  }
}

/** 本地日零点(与后端 dayStart 一致:按浏览器本地时区) */
function dayStart(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** http(s)://host:port → ws(s)://host:port/cups/:id/live */
function deriveWs(apiBase: string, cupId: string): string {
  const u = new URL(apiBase);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = `/cups/${encodeURIComponent(cupId)}/live`;
  u.search = '';
  return u.toString();
}
