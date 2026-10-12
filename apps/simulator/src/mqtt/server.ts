/**
 * 模拟器的 MQTT 出口 —— 把"假杯子"当成**一台真设备**,经外部 broker 把遥测发出去。
 *
 * 与 `src/ws/server.ts` 的分工:
 *   WS 出口给前端(直连、低延迟看数据);
 *   MQTT 出口走**设备协议**(topic 按 device_id,QoS1),喂独立进程的后端
 *   (`apps/server/src/ingest/mqtt-adapter.ts`,ADR T17)—— 三进程端到端联调那条线。
 *
 * ⚠️ 这是**全项目第二处 `import 'mqtt'`**。第一处是 `apps/server/src/ingest/mqtt-node-transport.ts`,
 *    它的头注释写着"全项目唯一"。这里点明这个例外并说明理由:同 T17 的立场 ——
 *    让 `mqtt` 依赖只在**薄壳**处落地(这里只做"连 broker + 订阅 + 发布 + 断开",
 *    不掺一行模拟逻辑),换 broker / 换 link 只改薄壳。模拟器侧原来只有 WS 出口,
 *    要接真 broker 就必然多一个薄壳,这一处是它的落地。
 *
 * 出口 seam:与 WS 出口同形 —— 只认 `broadcast(frame)`(结构化类型),
 * 于是 `engine.wireWs(mqttOut)` 能原样接上,`engine` 一行不用改。
 */
import { connect, type MqttClient } from 'mqtt';
import type { Frame } from '../core/engine.ts';
import { toFrames } from '../ws/server.ts';
import type { HelloFrame } from '../util/claim.ts';

/** 模拟器默认设备 id(与契约 §2 的 device_id 正则一致;`lid-XXX` / `base-XXX`)。 */
const DEFAULT_LID_ID = 'lid-A1B2C3';
const DEFAULT_BASE_ID = 'base-A1B2C3';

export interface MqttOutput {
  broadcast: (f: Frame) => void;
  close: () => void;
}

export interface MqttOutputOptions {
  /** broker 地址,如 mqtt://localhost:1883 */
  url: string;
  log?: (msg: string) => void;
  /** 订阅哪些设备的 down topic;默认模拟器的固定三 id 里的 lid/base */
  lidId?: string;
  baseId?: string;
  /**
   * 握手帧:连上 broker 后经 `dev/<lidId>/up` 发一次,生产真机形状(镜像固件 mqtt_uplink.c)。
   * 给可信绑定用 —— 传带 `{cup_id, device_id, claim, issued_at}` 的帧(见 util/claim.ts),
   * 后端 mqtt-adapter 会把它交给绑定校验(pg 阶段 4 前置)。不给则维持旧形 `{kind:'hello',v:1}`。
   */
  hello?: HelloFrame | { kind: 'hello'; v: 1 };
}

/** 某设备的上行 topic(设备 → 后端);与后端 mqtt-adapter 的 UPLINK_TOPIC(`dev/+/up`)对齐。 */
export function upTopic(deviceId: string): string {
  return `dev/${deviceId}/up`;
}

/** 某设备的下行 topic(后端 → 设备);与后端 mqtt-adapter 的 downTopic 逐字一致。 */
export function downTopic(deviceId: string): string {
  return `dev/${deviceId}/down`;
}

export function startMqttOutput(opts: MqttOutputOptions): MqttOutput {
  const log = opts.log ?? ((m: string) => console.log(m));
  const lidId = opts.lidId ?? DEFAULT_LID_ID;
  const baseId = opts.baseId ?? DEFAULT_BASE_ID;
  const downTopics = [downTopic(lidId), downTopic(baseId)];
  const hello = opts.hello ?? { kind: 'hello', v: 1 };

  const client: MqttClient = connect(opts.url, {
    clientId: `sim-${lidId}`, // --mqtt 只跑一个进程,id 唯一即可
    clean: true,
    reconnectPeriod: 1000,
    connectTimeout: 10_000,
    resubscribe: true, // 重连后自动重订阅(订阅归这里,不自己写退避)
  });

  client.on('connect', () => {
    log(`[mqtt] 已连接 ${opts.url}`);
    // 订阅自己的下行 topic —— 设备侧能收到指令是联调的**可见证据**
    client.subscribe(downTopics, { qos: 1 }, (err) => {
      if (err) log(`[mqtt] 订阅失败: ${err.message}`);
      else log(`[mqtt] 已订阅 ${downTopics.join(', ')}`);
    });
    // 握手:真机形状的 hello(后端 handleLine 对 kind:'hello' 在 schema 校验前放行)
    client.publish(upTopic(lidId), JSON.stringify(hello), {
      qos: 1,
      retain: false,
    });
  });
  client.on('reconnect', () => log('[mqtt] 重连中 …'));
  client.on('error', (err: Error) => log(`[mqtt] 错误: ${err.message}`));
  client.on('close', () => log('[mqtt] 连接关闭'));

  client.on('message', (topic: string, payload: Buffer) => {
    // 下行收到 Command[];设备侧**只打日志**(联调要的是"指令送达了"这个证据,不真执行)
    let text = payload.toString('utf8');
    let count = 0;
    let types = '';
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        count = parsed.length;
        types = parsed
          .map((c) => (c && typeof c === 'object' ? (c as { type?: unknown }).type : undefined))
          .filter((t) => typeof t === 'string')
          .join(', ');
      }
    } catch {
      log(`[mqtt] 收到下行(非 JSON):${text.slice(0, 120)} @ ${topic}`);
      return;
    }
    log(`[mqtt] 收到下行 ${count} 条: ${types || '(无 type)'}`);
  });

  return {
    broadcast(frame: Frame) {
      if (!client.connected) {
        // 模拟器是数据源,丢一帧不致命 —— 对齐 WS 出口"无所谓"的立场,但记一条便于排障
        log('[mqtt] 未连接,丢弃一帧');
        return;
      }
      // 每个信封**单独一条 publish**:一次一条才是真固件形状,且每信封自带 device_id 便于选 topic
      for (const envelope of toFrames(frame)) {
        const deviceId = envelope.payload.device_id;
        client.publish(upTopic(deviceId), JSON.stringify(envelope), { qos: 1, retain: false });
      }
    },
    close() {
      client.end(true);
    },
  };
}
