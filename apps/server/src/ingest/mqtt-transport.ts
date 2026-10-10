/**
 * MQTT 传输 seam —— 与 `Llm` / `ChatLlm` / `DataSource` 同类:
 * 上层(适配器)只认这个接口,不认 `mqtt` 包。
 *
 * 为什么要这一层:MQTT 裸写代价太高(见 ADR T17 的依赖理由),所以真实现引 `mqtt` 包;
 * 但测试若也依赖它,就得拖一个 broker 进来。把"传输"抽成接口后:
 *   - 真实现 = `mqtt-node-transport.ts`(唯一 `import 'mqtt'` 的文件)
 *   - 测试实现 = 一个 12 行 stub,**零依赖、零网络、零 broker**
 * 和 `sim-adapter` 用真 WebSocketServer 测是同一目的,只是 MQTT 没有零依赖的"本地 broker",
 * 于是这里改用注入。
 *
 * `payload` 用 `string`(不是 `Uint8Array`)是刻意的:模拟器适配器那边也是先
 * `data.toString()` 再切行 —— 把 Buffer 类型挡在 seam 外,适配器逻辑对两条链路一模一样。
 */

/** 一条入站 MQTT 消息(payload 已按 utf8 解好)。 */
export interface MqttTransportMessage {
  topic: string;
  payload: string;
}

export interface MqttTransport {
  /**
   * 订阅通配 topic(如 `dev/+/up`)。`onMessage` 每条入站消息回调一次。
   * 会自动重订阅(reconnect 后),这是 `mqtt` 客户端 `resubscribe` 的行为;
   * seam 不暴露重连细节 —— 重连归真实现所有。
   */
  subscribe(topic: string, onMessage: (msg: MqttTransportMessage) => void): void;
  /** 发布。成功 true;失败(未连接 / 抛错)false —— **不抛**。 */
  publish(topic: string, payload: string): boolean;
  /** 断开并释放。**同步**返回(对齐 `app.close()` 里同步的 `adapter?.stop()`)。 */
  close(): void;
}
