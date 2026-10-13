/**
 * 组装 —— 把 Store / Pipeline / LiveHub / API / sim-adapter 缝成一个可跑的后端。
 *
 * 拆出来的好处:测试可以只组装"Store + Pipeline",不碰网络;
 * 也可以在随机端口起真 HTTP,做端到端。
 */
import { MemoryStore, type Store } from './store/store.ts';
import { Pipeline } from './core/pipeline.ts';
import { CommandQueue } from './core/commands.ts';
import { makeGrowthNotifier } from './core/growth-notify.ts';
import { LiveHub } from './api/live.ts';
import { createApiServer } from './api/http.ts';
import { startSimAdapter, type SimAdapterHandle } from './ingest/sim-adapter.ts';
import { startMqttAdapter, type MqttAdapterHandle } from './ingest/mqtt-adapter.ts';
import { createNodeMqttTransport } from './ingest/mqtt-node-transport.ts';
import type { MqttTransport } from './ingest/mqtt-transport.ts';
import { NullLlm, type Llm } from './core/llm.ts';
import { NullChatLlm } from './core/chat/mock.ts';
import type { ChatLlm } from './core/chat/types.ts';
import { MemoryChatStore, type ChatStore } from './core/chat/memory.ts';
import { FileChatStore } from './core/chat/file-memory.ts';
import { FilePersistence } from './core/persist.ts';
import { FileAccountsStore, MemoryAccountsStore } from './core/social/accounts.ts';
import type { AccountsStore } from './core/social/types.ts';
import { ClaimService, resolveClaimPepper } from './core/social/claim.ts';
import { FileProfileStore, MemoryProfileStore, type ProfileStore } from './core/traits.ts';
import {
  CupLlmService,
  FileCupLlmStore,
  MemoryCupLlmStore,
  cupLlmFilePath,
  resolveLlmEncKey,
  type CupLlmStore,
} from './core/cup-llm.ts';
import { ProactiveScheduler } from './core/proactive.ts';
import { consoleSink, createLogger, type LogLevel } from './core/logger.ts';
import { composeSinks, createLogPipeline, type LogSinkHandle } from './core/log-pipeline.ts';
import { redactFields } from './core/redact.ts';
import type { ServerLogStore } from './core/log-store.ts';
import { MemoryServerLogStore } from './store/memory-server-logs.ts';
import { createPgPool, type Pool } from './store/pg/pool.ts';
import { PgServerLogStore } from './store/pg/server-logs.ts';
import type { RetentionOptions } from './store/pg/migrate.ts';
import { PgStore } from './store/pg/store.ts';
import { PgChatStore } from './store/pg/chat.ts';
import { PgAccountsStore } from './store/pg/accounts.ts';
import { PgProfileStore } from './store/pg/profile.ts';
import { PgCupLlmStore } from './store/pg/cup-llm.ts';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';

export interface AppOptions {
  /** 模拟器 WS 地址;不给则只起 API(测试/离线可用) */
  simUrl?: string;
  /** 真机 MQTT broker 地址(如 mqtt://localhost:1883);不给则不起 MQTT 适配器 */
  mqttUrl?: string;
  /** MQTT 传输注入点;不给则由 mqttUrl 造真实 mqtt 客户端。测试注入 stub(零网络) */
  mqttTransport?: MqttTransport;
  /** MQTT 客户端 id;多实例部署必须各不相同(默认 cup-server) */
  mqttClientId?: string;
  store?: Store;
  /** 性格层战报的 LLM;不给则用 NullLlm → 永远回退模板(主路径,见 ADR T12) */
  llm?: Llm;
  /** 对话 agent 的模型;不给则用 NullChatLlm → 聊天恒回退确定性模板句 */
  chatLlm?: ChatLlm;
  /**
   * 按杯取"用户自选模型"(登录后给自己那只杯配的 provider/model/key)。
   * 给了它 `/ask` 才可能走账户鉴权(仅当该杯确实配了模型时);不给则 `/ask` 行为不变。
   * 由 cli 从 `CupLlmStore` 造(见 pg/llm 线,窗口 B);测试可注入假实现。
   */
  resolveChatLlm?: (cupId: string) => Promise<ChatLlm | null>;
  /** 对话记忆(跨天);不给则用内存实现(P3 前不落盘) */
  chatMemory?: ChatStore;
  /**
   * 数据目录:给则启用文件持久化(目标 + 对话轮),重启不丢(ADR T14)。
   * 不给则纯内存(测试/离线用)。
   */
  dataDir?: string;
  /**
   * Postgres 连接串(第 2 阶段)。给则四个 store 全走 Pg 实现(十万用户规模);
   * 不给则退到 dataDir 文件实现 / 内存实现。优先级:注入 store > pgUrl > dataDir > memory。
   * **迁移由调用方(cli)在 createApp 之前跑**(见 store/pg/migrate.ts)。
   */
  pgUrl?: string;
  /** 已建好的 pg 连接池(测试注入;给了它则忽略 pgUrl)。`app.close()` 会关它。 */
  pgPool?: Pool;
  /** 开启主动开口(P5);不给则不起调度器(默认关,避免测试里乱说话) */
  proactive?: boolean;
  /** 要照看的杯子;默认空(需显式给,免得对未配网的 id 说话) */
  cups?: string[];
  /** 画像蒸馏阈值:自上次蒸馏后新增多少轮才再蒸一次;缺省用 distill.ts 默认值 */
  profileMinNewTurns?: number;
  /**
   * 写端点鉴权 key(R10-B)。由 cli 从 env `CUP_API_KEY` 读入;
   * **不给则生成随机 key**(默认强制,安全默认)。空串等同不给。
   */
  apiKey?: string;
  /**
   * 显式豁免写端点鉴权(R10-B)—— **仅 dev/测试**。true 时不生成 key、不挡写。
   * 默认 false(强制)。旧的"未设 CUP_API_KEY 即放行"语义已废除。
   */
  allowUnauth?: boolean;
  /**
   * 账号 / 会话 / 市场 / 社交存储;不给则有 dataDir → 文件实现(social.json),
   * 否则内存实现(测试/离线用)。
   */
  accounts?: AccountsStore;
  /** 人格档案存储(#72);不给则随 dataDir 走文件实现,否则内存 */
  profiles?: ProfileStore;
  /** 每杯模型配置(BYOK);不给则随 pgUrl / dataDir 选实现,否则内存 */
  cupLlm?: CupLlmStore;
  /** 每杯 key 的**加密**密钥;不给则由 env `CUP_LLM_ENC_KEY` / dataDir 解析(见 resolveLlmEncKey) */
  llmEncKey?: Buffer;
  /**
   * 首个管理员引导邮箱(cli 从 env `CUP_ADMIN_EMAIL` 读入)。注册命中该邮箱 →
   * role='admin'。**不新增注册口子**:管理员也只能走正常注册。
   */
  adminEmail?: string;
  /** 运维邮箱名单(cli 从 env `CUP_OPS_EMAILS` 读入,逗号分隔);注册命中 → role='ops' */
  opsEmails?: readonly string[];
  /** 审核邮箱名单(cli 从 env `CUP_REVIEWER_EMAILS` 读入,逗号分隔);注册命中 → role='reviewer' */
  reviewerEmails?: readonly string[];
  /**
   * 绑定杯子须出示设备一次性 claim code(可信绑定,风险 R18)。
   * **默认 false** → 绑定行为与从前一致(零回归);设备/模拟器两半验收后由用户开。
   */
  requireClaim?: boolean;
  /** claim 的 pepper;不给则由 env `CUP_CLAIM_PEPPER` / dataDir 解析(见 resolveClaimPepper) */
  claimPepper?: Buffer;
  /** 日志函数;不给则用内置结构化 logger(级别/格式见下两参) */
  log?: (msg: string, level?: LogLevel) => void;
  /** 内置 logger 的最低级别(缺省 info;env CUP_LOG_LEVEL) */
  logLevel?: LogLevel;
  /** 内置 logger 的输出格式(缺省 text;env CUP_LOG_FORMAT=json 切 JSON) */
  logFormat?: 'text' | 'json';
  /**
   * 日志持久化:JSONL 文件出口目录(env `CUP_LOG_DIR`)。给了才落文件;
   * 与 pgUrl 任一存在即启用持久化管线。不给且无 pgUrl → 行为与从前一致(只打控制台)。
   */
  logDir?: string | null;
  /**
   * 控制台静音(env `--quiet`)。**不影响持久化**:只把 console sink 摘掉,
   * 落库/落文件照常 —— "安静跑但仍然可回看"。
   */
  logQuiet?: boolean;
  /** 服务日志存储(测试注入;不给则 PG 模式用 Pg 实现、否则内存实现) */
  serverLogs?: ServerLogStore;
  /** 保留策略选项(传给 `/admin/logs/retain`;env 由 cli 读入) */
  retention?: RetentionOptions;
}

export interface App {
  store: Store;
  pipeline: Pipeline;
  live: LiveHub;
  commands: CommandQueue;
  llm: Llm;
  chatLlm: ChatLlm;
  chatMemory: ChatStore;
  /** 账号 / 会话 / 市场 / 社交存储(文件或内存) */
  accounts: AccountsStore;
  /** 可信绑定核验(claim code;见 core/social/claim.ts) */
  claims: ClaimService;
  /** 人格档案存储(#72:昵称 + 派生性格快照) */
  profiles: ProfileStore;
  /** 每杯模型配置门面(BYOK;见 core/cup-llm.ts) */
  cupLlm: CupLlmService;
  /** 服务日志存储(结构化日志落库/内存) */
  serverLogs: ServerLogStore;
  /** 文件持久化句柄(未启用 dataDir 时为 null) */
  persist: FilePersistence | null;
  /** 主动开口调度器(未开启 proactive 时为 null) */
  proactive: ProactiveScheduler | null;
  /** 写端点鉴权 key(R10-B):豁免时为 null;否则为生效的 key(env 或随机生成) */
  apiKey: string | null;
  /** key 是否由 createApp 随机生成(供 cli 决定是否打到横幅;env 提供的则不回显) */
  apiKeyGenerated: boolean;
  server: Server;
  listen(port: number, host?: string): Promise<number>;
  /** 已连上的模拟器适配器(若配了 simUrl) */
  adapter: SimAdapterHandle | null;
  /** 真机 MQTT 适配器(若配了 mqttUrl);与 adapter 可并存 */
  mqtt: MqttAdapterHandle | null;
  close(): Promise<void>;
}

export function createApp(opts: AppOptions = {}): App {
  // 有 dataDir → 文件持久化:目标恢复 + 变更回调 + 对话轮落盘(ADR T14)。
  // 用一个可选钩子接进 MemoryStore,**不动 Store 接口**(T3「只换实现,不动上层」)。
  // 注意:选 Pg 时不建 persist(持久化的活儿归 DB;state.json 不参与)。
  const pool = opts.pgPool ?? (opts.pgUrl ? createPgPool(opts.pgUrl) : null);
  // 服务日志存储(照四个 store 三元式):注入 > PG > 内存。
  const serverLogs = opts.serverLogs ?? (pool ? new PgServerLogStore(pool) : new MemoryServerLogStore());
  // 持久化管线:**只在"未注入 log"且"有落点"时**启 —— 注入 log 的既有测试完全走老路(零回归),
  // 且 `--quiet` 只摘 console sink、不影响落库/落文件。管线激活时强制 json 格式(sink 拿到的是
  // 已序列化字符串,只有 JSON 行能结构还原成列)。
  const persistent: LogSinkHandle | null =
    !opts.log && (pool || opts.logDir)
      ? createLogPipeline({ append: (rows) => serverLogs.append(rows), dir: opts.logDir ?? null, now: Date.now })
      : null;
  const log =
    opts.log ??
    createLogger({
      level: opts.logLevel,
      format: persistent ? 'json' : opts.logFormat,
      sink: persistent
        ? opts.logQuiet
          ? persistent.sink
          : composeSinks(consoleSink, persistent.sink)
        : undefined,
      redact: persistent ? redactFields : undefined,
    });
  const persist = !pool && opts.dataDir ? new FilePersistence(opts.dataDir) : null;
  const store =
    opts.store ??
    (pool
      ? new PgStore(pool)
      : new MemoryStore(
          persist
            ? { goals: persist.goals(), onGoal: (cupId, ml) => persist.setGoal(cupId, ml) }
            : {},
        ));
  const live = new LiveHub();
  const commands = new CommandQueue();
  const llm = opts.llm ?? new NullLlm();
  const chatLlm = opts.chatLlm ?? new NullChatLlm();
  const chatMemory =
    opts.chatMemory ??
    (pool ? new PgChatStore(pool) : persist ? new FileChatStore(persist) : new MemoryChatStore());
  // 账号 / 会话 / 市场 / 社交(独立文件 social.json,与 state.json 同一套原子写机制)。
  const accounts =
    opts.accounts ??
    (pool
      ? new PgAccountsStore(pool)
      : opts.dataDir
        ? new FileAccountsStore(opts.dataDir)
        : new MemoryAccountsStore());
  // 人格档案(#72):挂在 state.json 的 traits 段上(无 dataDir 则内存)
  const profiles =
    opts.profiles ??
    (pool
      ? new PgProfileStore(pool)
      : persist
        ? new FileProfileStore(persist)
        : new MemoryProfileStore());
  // 可信绑定(claim code):收码规则厚、路由薄;pepper 由 env/dataDir 解析(明文码绝不落盘)。
  const claimPepper = opts.claimPepper ?? resolveClaimPepper(opts.dataDir);
  const claims = new ClaimService({ store: accounts, pepper: claimPepper, log });
  // 每杯模型配置(BYOK):key 密文落库,门面把加解密收在 core 里(HTTP 层不碰 crypto)。
  const cupLlmStore =
    opts.cupLlm ??
    (pool
      ? new PgCupLlmStore(pool)
      : opts.dataDir
        ? new FileCupLlmStore(cupLlmFilePath(opts.dataDir))
        : new MemoryCupLlmStore());
  const llmEncKey = opts.llmEncKey ?? resolveLlmEncKey(opts.dataDir);
  const cupLlm = new CupLlmService({ store: cupLlmStore, key: llmEncKey });
  const cups = opts.cups ?? [];

  // 主动开口(P5):只有显式开启才起 —— 默认关,免得测试/离线环境里乱说话。
  const proactive = opts.proactive
    ? new ProactiveScheduler({
        store,
        commands,
        chat: chatLlm,
        memory: chatMemory,
        live,
        log,
        cups: () => cups,
        minNewTurns: opts.profileMinNewTurns,
      })
    : null;

  // 成长庆祝(养成闭环):事件落定后旁挂判"今天是否新跨里程碑"→ 入队 remind 下行。
  // 旁路观察者,改不动写路径;业务判定在后端,固件只认 reason='milestone'(见 growth-notify.ts)。
  const notifyGrowth = makeGrowthNotifier({ store, commands, log });

  // 管线产出 → 实时推送。这就是"WS 在模拟器发数据时能实时收到"的连线(验收 3)。
  const pipeline = new Pipeline(store, {
    sample: (s) => live.broadcast({ kind: 'sample', cup_id: s.cup_id, payload: s }),
    event: (e) => {
      live.broadcast({ kind: 'event', cup_id: e.cup_id, payload: e });
      notifyGrowth(e);
    },
    telemetry: (p) => live.broadcast({ kind: 'telemetry', cup_id: p.cup_id, payload: p }),
  });

  // 写端点鉴权 key(R10-B):
  //   · opts.allowUnauth → 显式豁免(dev/测试),不生成、不挡。
  //   · opts.apiKey(env CUP_API_KEY)非空 → 用它。
  //   · 否则 → 生成随机 key:写端点默认强制(没有 key 谁也别写)。
  const envKey = opts.apiKey || '';
  const apiKeyGenerated = opts.allowUnauth !== true && envKey === '';
  const apiKey = opts.allowUnauth === true ? undefined : envKey || randomBytes(24).toString('hex');

  const server = createApiServer({
    store,
    pipeline,
    live,
    commands,
    llm,
    chatLlm,
    chatMemory,
    resolveChatLlm: opts.resolveChatLlm ?? ((cupId) => cupLlm.chatLlm(cupId)),
    apiKey,
    allowUnauth: opts.allowUnauth,
    accounts,
    profiles,
    adminEmail: opts.adminEmail,
    opsEmails: opts.opsEmails,
    reviewerEmails: opts.reviewerEmails,
    claims,
    requireClaim: opts.requireClaim,
    cupLlm,
    serverLogs,
    pgPool: pool ?? undefined,
    retention: opts.retention,
    log,
  });
  live.attach(server);

  let adapter: SimAdapterHandle | null = null;
  let mqtt: MqttAdapterHandle | null = null;

  const app: App = {
    store,
    pipeline,
    live,
    commands,
    llm,
    chatLlm,
    chatMemory,
    accounts,
    claims,
    profiles,
    cupLlm,
    serverLogs,
    persist,
    proactive,
    apiKey: apiKey ?? null,
    apiKeyGenerated,
    server,
    adapter,
    mqtt,
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const addr = server.address();
          const actual = typeof addr === 'object' && addr ? addr.port : port;
          resolve(actual);
        });
      });
    },
    async close() {
      proactive?.stop();
      adapter?.stop();
      mqtt?.stop();
      live.close();
      await chatMemory.flush(); // 会话记忆落盘(内存/Pg 实现 no-op)
      await accounts.flush(); // 账号 / 会话 / 市场 / 社交落盘(内存/Pg 实现 no-op)
      await profiles.flush(); // 人格档案落盘(内存/Pg 实现 no-op)
      await cupLlm.flush(); // 每杯模型配置落盘(内存/Pg 实现 no-op)
      await persist?.flush(); // 目标 + 画像落盘(仅文件实现)
      await persistent?.close(); // 排干日志缓冲(落库 + 落文件)—— 须在 pool.end() 之前
      await pool?.end(); // 关 pg 连接池(仅 Pg 模式)
      await new Promise<void>((r) => server.close(() => r()));
    },
  };

  // hello 里的 claim code → 落库(未开 requireClaim 时也照收,不影响绑定行为)。
  const onHello = (deviceId: string, hello: Record<string, unknown>): Promise<void> =>
    claims.noteHello(deviceId, hello);

  if (opts.simUrl) {
    adapter = startSimAdapter({ url: opts.simUrl, pipeline, log, onHello });
    app.adapter = adapter;
  }

  if (opts.mqttUrl) {
    // 注入的 transport 优先 —— 测试给 stub,连真 broker 的构造就不会发生
    const transport =
      opts.mqttTransport ??
      createNodeMqttTransport({ url: opts.mqttUrl, log, clientId: opts.mqttClientId });
    mqtt = startMqttAdapter({ url: opts.mqttUrl, pipeline, commands, transport, log, onHello });
    app.mqtt = mqtt;
  }

  proactive?.start();
  return app;
}
