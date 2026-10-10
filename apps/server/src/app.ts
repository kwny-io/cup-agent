/**
 * 组装 —— 把 Store / Pipeline / LiveHub / API / sim-adapter 缝成一个可跑的后端。
 *
 * 拆出来的好处:测试可以只组装"Store + Pipeline",不碰网络;
 * 也可以在随机端口起真 HTTP,做端到端。
 */
import { MemoryStore, type Store } from './store/store.ts';
import { Pipeline } from './core/pipeline.ts';
import { CommandQueue } from './core/commands.ts';
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
import { ProactiveScheduler } from './core/proactive.ts';
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
  /** 对话记忆(跨天);不给则用内存实现(P3 前不落盘) */
  chatMemory?: ChatStore;
  /**
   * 数据目录:给则启用文件持久化(目标 + 对话轮),重启不丢(ADR T14)。
   * 不给则纯内存(测试/离线用)。
   */
  dataDir?: string;
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
  log?: (msg: string, level?: 'info' | 'warn' | 'error') => void;
}

export interface App {
  store: Store;
  pipeline: Pipeline;
  live: LiveHub;
  commands: CommandQueue;
  llm: Llm;
  chatLlm: ChatLlm;
  chatMemory: ChatStore;
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
  const log = opts.log ?? ((m, l = 'info') => console[l](m));
  // 有 dataDir → 文件持久化:目标恢复 + 变更回调 + 对话轮落盘(ADR T14)。
  // 用一个可选钩子接进 MemoryStore,**不动 Store 接口**(T3「只换实现,不动上层」)。
  const persist = opts.dataDir ? new FilePersistence(opts.dataDir) : null;
  const store =
    opts.store ??
    new MemoryStore(
      persist
        ? { goals: persist.goals(), onGoal: (cupId, ml) => persist.setGoal(cupId, ml) }
        : {},
    );
  const live = new LiveHub();
  const commands = new CommandQueue();
  const llm = opts.llm ?? new NullLlm();
  const chatLlm = opts.chatLlm ?? new NullChatLlm();
  const chatMemory = opts.chatMemory ?? (persist ? new FileChatStore(persist) : new MemoryChatStore());
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

  // 管线产出 → 实时推送。这就是"WS 在模拟器发数据时能实时收到"的连线(验收 3)。
  const pipeline = new Pipeline(store, {
    sample: (s) => live.broadcast({ kind: 'sample', cup_id: s.cup_id, payload: s }),
    event: (e) => live.broadcast({ kind: 'event', cup_id: e.cup_id, payload: e }),
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
    apiKey,
    allowUnauth: opts.allowUnauth,
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
      await chatMemory.flush(); // 会话记忆落盘(内存实现 no-op)
      await persist?.flush(); // 目标 + 画像落盘
      await new Promise<void>((r) => server.close(() => r()));
    },
  };

  if (opts.simUrl) {
    adapter = startSimAdapter({ url: opts.simUrl, pipeline, log });
    app.adapter = adapter;
  }

  if (opts.mqttUrl) {
    // 注入的 transport 优先 —— 测试给 stub,连真 broker 的构造就不会发生
    const transport =
      opts.mqttTransport ??
      createNodeMqttTransport({ url: opts.mqttUrl, log, clientId: opts.mqttClientId });
    mqtt = startMqttAdapter({ url: opts.mqttUrl, pipeline, commands, transport, log });
    app.mqtt = mqtt;
  }

  proactive?.start();
  return app;
}
