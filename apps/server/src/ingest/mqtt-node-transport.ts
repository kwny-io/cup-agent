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

export interface NodeMqttTransportOptions {
  url: string;
  log?: (msg: string, level?: 'info' | 'warn' | 'error') => void;
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
      try {
        // fire-and-forget:返回的是此刻是否已连接,不代表 broker 已收(见 ADR T17 的已知限制)
        client.publish(topic, payload, { qos: 1, retain: false });
        return client.connected;
      } catch {
        return false; // 未连接 / 序列化失败 → 让上层重新入队
      }
    },
    close() {
      client.end(true);
    },
  };
}
