/**
 * mqtt-adapter —— 后端接真机的入口(P1 适配器的第二个实现)。
 *
 * `sim-adapter.ts` 头注释早就指着这一天:"将来接真机:新增 mqtt-adapter,
 * 把'连 WS'换成'订阅 topic',下游(管线/Store/API)一行不动 —— 这就是 P1 的意义。"
 * 这个文件就是那句话。
 *
 * 它做四件事:
 *   1. 订阅通配 topic `dev/+/up`(见 ADR T17 的 topic 契约)
 *   2. 按行切 JSON,逐条用 `UpstreamFrameSchema` 校验(和 sim-adapter 逐字节一致)
 *   3. 合法的交管线;不合法的**记日志并丢弃**,绝不让脏数据进 Store
 *   4. **捎回**:设备这次上报时,把它排队中的指令从下行 topic 递回去(拉取式下行,ADR T11)
 *
 * 为什么 topic 按 **device_id** 而非 cup_id:
 * `CommandQueue` 就是按 `Command.target`(= device_id)分队列的,**topic 的键 == 队列的键,1:1**,
 * 于是没有 cup↔device 映射、没有陈旧状态。cup_id 在报文 payload 里(§2 每个信封都带),
 * 管线/Store 照旧从那里读 —— 一点没丢。详见 ADR T17。
 *
 * 传输是**注入**的(见 `mqtt-transport.ts`):真实现引 `mqtt` 包,测试注入 stub,
 * 于是适配器逻辑零依赖、零网络可测。
 */
import { UpstreamFrameSchema } from '@cup/contract';
import type { Pipeline } from '../core/pipeline.ts';
import type { CommandQueue } from '../core/commands.ts';
import type { MqttTransport, MqttTransportMessage } from './mqtt-transport.ts';

/** 上行通配订阅:一个订阅吃下所有设备。 */
export const UPLINK_TOPIC = 'dev/+/up';

/** 设备 id 形状 —— 与契约 §2 的 device_id 正则一致(`lid-XXX` / `base-XXX`)。 */
const DEVICE_ID_RE = /^(lid|base)-[A-Z0-9]+$/;

/** 某设备的下行 topic(捎回指令)。 */
export function downTopic(deviceId: string): string {
  return `dev/${deviceId}/down`;
}

/**
 * 从 `dev/<device_id>/up` 抽出 device_id;形状不对(段数 / 段名 / id 正则任一不满足)→ null。
 * 抽成纯函数:零依赖、零网络可单测(见 mqtt-adapter.test.ts)。
 */
export function parseUplinkTopic(topic: string): string | null {
  const parts = topic.split('/');
  if (parts.length !== 3) return null;
  const [head, id, tail] = parts;
  if (head !== 'dev' || tail !== 'up') return null;
  if (typeof id !== 'string' || !DEVICE_ID_RE.test(id)) return null;
  return id;
}

export interface MqttAdapterOptions {
  pipeline: Pipeline;
  /** 捎回要从这里取指令 —— 比 sim-adapter 多这一个依赖(拉取式下行,ADR T11)。 */
  commands: CommandQueue;
  /** MQTT 传输(必给)。真机 = createNodeMqttTransport;测试 = stub。 */
  transport: MqttTransport;
  /** broker 地址,仅用于日志/诊断(连接本身归 transport 所有)。 */
  url?: string;
  /** 日志出口;默认 console。测试里可换成收集器 */
  log?: (msg: string, level?: 'info' | 'warn' | 'error') => void;
  /** 覆盖上行订阅 topic;默认 UPLINK_TOPIC */
  uplinkTopic?: string;
  /** 覆盖下行 topic 生成;默认 downTopic */
  downlinkTopic?: (deviceId: string) => string;
}

export interface MqttAdapterHandle {
  stop: () => void;
  /** 已接受的帧数 */
  accepted: () => number;
  /** 被契约校验拒收的帧数 */
  rejected: () => number;
}

export function startMqttAdapter(opts: MqttAdapterOptions): MqttAdapterHandle {
  const log = opts.log ?? ((m, l = 'info') => console[l](m));
  const uplink = opts.uplinkTopic ?? UPLINK_TOPIC;
  const down = opts.downlinkTopic ?? downTopic;
  let accepted = 0;
  let rejected = 0;
  let stopped = false;

  const reject = (why: string): void => {
    rejected += 1;
    opts.pipeline.noteRejected();
    log(`[mqtt-adapter] 拒收:${why}`, 'error');
  };

  const handleLine = (deviceId: string, text: string): void => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      reject(`不是合法 JSON — ${text.slice(0, 120)}`);
      return;
    }

    // 握手帧 {kind:'hello'} 不是契约报文,静默放行(与 sim-adapter 同处理)
    if (raw && typeof raw === 'object' && (raw as { kind?: string }).kind === 'hello') {
      log('[mqtt-adapter] 收到 hello 握手');
      return;
    }

    const parsed = UpstreamFrameSchema.safeParse(raw);
    if (!parsed.success) {
      const why = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      reject(`不符合契约 §2 — ${why}`);
      return;
    }

    // 完整性:topic 里的设备必须与报文里的 device_id 一致(防固件发错 topic)
    if (parsed.data.payload.device_id !== deviceId) {
      reject(
        `topic 设备 ${deviceId} 与报文 device_id ${parsed.data.payload.device_id} 不符`,
      );
      return;
    }

    if (opts.pipeline.ingest(parsed.data)) accepted += 1;
  };

  /** 捎回:把该设备排队中的指令递回去(取一次、空不发、失败回队)。 */
  const deliver = (deviceId: string): void => {
    if (stopped) return;
    const due = opts.commands.takeFor(deviceId); // 顺带丢掉过期指令
    if (due.length === 0) return; // 空数组不发 —— 不制造无意义的 broker 噪声
    const topic = down(deviceId);
    if (!opts.transport.publish(topic, JSON.stringify(due))) {
      opts.commands.requeue(due);
      log(`[mqtt-adapter] 捎回失败,${due.length} 条指令回队待下次上行重试`, 'warn');
      return;
    }
    log(`[mqtt-adapter] 捎回 ${due.length} 条指令 → ${topic}`);
  };

  const handleMessage = (msg: MqttTransportMessage): void => {
    if (stopped) return;
    const deviceId = parseUplinkTopic(msg.topic);
    if (!deviceId) {
      // topic 垃圾不算"报文拒收"(那是 §2 语义),只记 warn、不动计数器
      log(`[mqtt-adapter] 未知 topic,忽略:${msg.topic}`, 'warn');
      return;
    }
    // 一次发布可能多行(lid + 若干 event,见模拟器 ws/server.ts 的 \n 批)
    for (const line of msg.payload.split('\n')) {
      const text = line.trim();
      if (text.length === 0) continue;
      handleLine(deviceId, text);
    }
    // 捎回在整条消息处理完**只调一次**(而不是每行一次)
    deliver(deviceId);
  };

  opts.transport.subscribe(uplink, handleMessage);
  log(`[mqtt-adapter] 订阅 ${uplink}${opts.url ? `(broker ${opts.url})` : ''}`);

  return {
    stop() {
      stopped = true;
      opts.transport.close();
    },
    accepted: () => accepted,
    rejected: () => rejected,
  };
}
