/**
 * MQTT 传输的真实实现 —— **全项目唯一 `import 'mqtt'` 的文件**。
 *
 * 它只负责"连 broker + 订阅 + 发布 + 断开",一行适配器逻辑都没有:
 * 校验、去重、捎回全在 `mqtt-adapter.ts`(对链路无知)。这样:
 *   - 依赖只在这一处落地(ADR T17 的 P4 例外点清楚可见)
 *   - 换 broker / 换 link(HTTP 长轮询 / BLE 网关)只重写这个文件
 *
 * **重连归 `mqtt` 客户端所有**(`reconnectPeriod`),这里**不重实现**退避 ——
 * sim-adapter 自己写退避是因为裸 `ws` 没有内置重连;MQTT 有,再叠一层会变成两套重连在打架。
 */
import { connect } from 'mqtt';
import type { MqttTransport, MqttTransportMessage } from './mqtt-transport.ts';
import type { LogLevel } from '../core/logger.ts';

/**
 * 等 PUBACK 的上限(ms)。超过就当作没送达 → 上层回队重试(R11)。
 * 取 5s:远超局域网 RTT,又不至于让"捎回失败"迟迟不发现而卡住指令队列。
 */
const PUBACK_TIMEOUT_MS = 5000;

export interface NodeMqttTransportOptions {
  url: string;
  log?: (msg: string, level?: LogLevel) => void;
  /**
   * 客户端 id。多实例部署时**必须各不相同** ——
   * MQTT-3.1.4 规定同 id 的两个客户端会互相踢下线,默认 id 撞了会永远翻飞。
   */
  clientId?: string;
}

export function createNodeMqttTransport(opts: NodeMqttTransportOptions): MqttTransport {
  const log = opts.log ?? ((m, l = 'info') => console[l](m));
  const client = connect(opts.url, {
    clientId: opts.clientId ?? 'cup-server',
    // clean session:不依赖 broker 侧排队 —— 那会和命令队列(拉取式下行,ADR T11)语义重复
    clean: true,
    reconnectPeriod: 1000,
    connectTimeout: 10_000,
    resubscribe: true, // 重连后自动重订阅
  });

  // 入站 → 交给适配器;适配器只收 { topic, payload:string }
  let onMessage: ((msg: MqttTransportMessage) => void) | null = null;
  client.on('message', (topic: string, payload: Buffer) => {
    onMessage?.({ topic, payload: payload.toString('utf8') });
  });

  client.on('connect', () => log('[mqtt] 已连接'));
  client.on('reconnect', () => log('[mqtt] 重连中 …', 'warn'));
  client.on('error', (err: Error) => log(`[mqtt] 错误: ${err.message}`, 'error'));
  client.on('close', () => log('[mqtt] 连接关闭', 'warn'));

  return {
    subscribe(topic, handler) {
      onMessage = handler;
      client.subscribe(topic, (err) => {
        if (err) log(`[mqtt] 订阅 ${topic} 失败: ${err.message}`, 'error');
        else log(`[mqtt] 已订阅 ${topic}`);
      });
    },
    publish(topic, payload) {
      // QoS1:等 broker 回 PUBACK 才算成功(R11)。mqtt.js 的 publish 回调在
      // QoS>0 时正由 PUBACK 触发(err 为 null = broker 已确认收下)。
      return new Promise<boolean>((resolve) => {
        if (!client.connected) {
          resolve(false); // 未连接,不必排进 client 的离线队列 —— 上层自己回队重试
          return;
        }
        let settled = false;
        const done = (ok: boolean): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ok);
        };
        const timer = setTimeout(() => {
          log(`[mqtt] 发布 ${topic} 超时(未收到 PUBACK)`, 'warn');
          done(false);
        }, PUBACK_TIMEOUT_MS);
        try {
          client.publish(topic, payload, { qos: 1, retain: false }, (err) => done(!err));
        } catch {
          done(false); // 序列化失败等同步异常
        }
      });
    },
    close() {
      client.end(true);
    },
  };
}
