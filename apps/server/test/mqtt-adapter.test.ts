/**
 * mqtt-adapter 测试 —— 零新测试依赖:不起 broker、不起网络端口。
 *
 * 靠的是注入的 `MqttTransport` seam(见 ingest/mqtt-transport.ts):
 * `StubTransport` 十几行,把"入站消息"直接喂给适配器、把"出站发布"记进数组。
 * 这是 sim-adapter 用真 WebSocketServer 的同一目的,只是 MQTT 没有零依赖的本地 broker。
 *
 * 钉死的行为:拒收(坏 JSON / 坏契约 / topic 与 payload 设备不符)、hello 放行、
 * 去重不计 accepted、多行批、捎回恰好一次、过期过滤、发布失败回队、stop 守卫、
 * 以及**不碰任何 MQTT 服务**的 app 级集成(P1 端到端)。
 *
 * 注意:契约要求信封 kind 与 device_id 前缀一致(base-* 报 base,lid-* 报 lid),
 * 所以遥测夹具统一用 BASE;lid 只用在 topic 纯函数与不符校验上。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Command } from '@cup/contract';
import {
  createApp,
  MemoryStore,
  Pipeline,
  CommandQueue,
  startMqttAdapter,
  parseUplinkTopic,
  UPLINK_TOPIC,
  type MqttTransport,
  type MqttTransportMessage,
} from '@cup/server';

const CUP_ID = 'cup-A1B2C3';
const BASE = 'base-A1B2C3';
const LID = 'lid-A1B2C3';

// ── 测试替身:零依赖传输 ─────────────────────────────────────────

class StubTransport implements MqttTransport {
  topics: string[] = [];
  published: { topic: string; payload: string }[] = [];
  closed = false;
  private handler: ((m: MqttTransportMessage) => void) | null = null;

  subscribe(topic: string, onMessage: (m: MqttTransportMessage) => void): void {
    this.topics.push(topic);
    this.handler = onMessage;
  }
  publish(topic: string, payload: string): boolean {
    this.published.push({ topic, payload });
    return true;
  }
  close(): void {
    this.closed = true;
  }
  /** 模拟 broker 推来一条消息 */
  deliver(topic: string, payload: string): void {
    this.handler?.({ topic, payload });
  }
}

/** 发布永远失败,用来验捎回失败回队 */
class FlakyTransport extends StubTransport {
  override publish(): boolean {
    return false;
  }
}

// ── 夹具 ─────────────────────────────────────────────────────────

function setup(transport: StubTransport = new StubTransport()) {
  const store = new MemoryStore();
  const pipeline = new Pipeline(store);
  const commands = new CommandQueue();
  const logs: string[] = [];
  const handle = startMqttAdapter({
    pipeline,
    commands,
    transport,
    log: (m) => logs.push(m),
  });
  return { store, pipeline, commands, logs, handle, transport };
}

/** 一个合法底座遥测帧,485g → 200ml */
function baseFrame(deviceId = BASE, extra: Record<string, unknown> = {}): unknown {
  return {
    kind: 'base',
    payload: {
      v: 1,
      device_id: deviceId,
      cup_id: CUP_ID,
      ts: Date.now(),
      seq: 0,
      weight_g: 485,
      stable: true,
      present: true,
      temp_c: 30,
      charging: false,
      battery_pct: 90,
      ...extra,
    },
  };
}

function drinkEvent(deviceId = BASE): unknown {
  return {
    kind: 'event',
    payload: {
      v: 1,
      cup_id: CUP_ID,
      device_id: deviceId,
      ts: Date.now(),
      type: 'drink',
      amount_ml: 120,
      confidence: 0.9,
      derived_by: 'base',
    },
  };
}

function cmd(overrides: Partial<Command> = {}): Command {
  return {
    v: 1,
    cmd_id: 'c-1',
    target: BASE,
    ts: Date.now(),
    expires_at: Date.now() + 60_000,
    type: 'remind',
    payload: { text: '喝水' },
    ...overrides,
  };
}

// ── 校验 / 放行 / 去重 / 批 ─────────────────────────────────────

test('坏 JSON → 拒收 + noteRejected + 日志', () => {
  const { pipeline, handle, logs, transport } = setup();
  transport.deliver(`dev/${BASE}/up`, 'not json {{{');
  assert.equal(handle.accepted(), 0);
  assert.equal(handle.rejected(), 1);
  assert.equal(pipeline.stats().rejected, 1);
  assert.ok(logs.some((l) => l.includes('拒收')));
});

test('契约越界字段 → 拒收,不进库', () => {
  const { store, pipeline, handle, transport } = setup();
  transport.deliver(`dev/${BASE}/up`, JSON.stringify(baseFrame(BASE, { temp_c: 999 })));
  assert.equal(handle.rejected(), 1);
  assert.equal(pipeline.stats().rejected, 1);
  assert.equal(store.latestSample(CUP_ID), null);
});

test('{kind:hello} 静默放行,不计接受也不计拒收', () => {
  const { handle, transport } = setup();
  transport.deliver(`dev/${BASE}/up`, JSON.stringify({ kind: 'hello' }));
  assert.equal(handle.accepted(), 0);
  assert.equal(handle.rejected(), 0);
});

test('合法帧 → 接受 + 进库(485g → 200ml)', () => {
  const { store, handle, transport } = setup();
  transport.deliver(`dev/${BASE}/up`, JSON.stringify(baseFrame()));
  assert.equal(handle.accepted(), 1);
  assert.equal(store.latestSample(CUP_ID)?.volume_ml, 200);
});

test('去重不计 accepted(同一帧投两次 → accepted 仍 1)', () => {
  const { handle, transport } = setup();
  const line = JSON.stringify(baseFrame());
  transport.deliver(`dev/${BASE}/up`, line);
  transport.deliver(`dev/${BASE}/up`, line);
  assert.equal(handle.accepted(), 1);
  assert.equal(handle.rejected(), 0);
});

test('一次发布多行(\\n 批):base + event 都进', () => {
  const { handle, transport } = setup();
  transport.deliver(
    `dev/${BASE}/up`,
    [JSON.stringify(baseFrame()), JSON.stringify(drinkEvent())].join('\n'),
  );
  assert.equal(handle.accepted(), 2);
});

// ── 捎回 ────────────────────────────────────────────────────────

test('捎回:合法上行 → 从 dev/<id>/down 递出队列,且恰好一次', () => {
  const { commands, transport } = setup();
  commands.enqueue(cmd({ cmd_id: 'c-42' }));
  transport.deliver(`dev/${BASE}/up`, JSON.stringify(baseFrame()));

  assert.equal(transport.published.length, 1, '应恰好发布一次');
  assert.equal(transport.published[0]!.topic, `dev/${BASE}/down`);
  const out = JSON.parse(transport.published[0]!.payload) as Command[];
  assert.equal(out.length, 1);
  assert.equal(out[0]!.cmd_id, 'c-42');
  assert.equal(commands.peek(BASE).length, 0, '取走后队列应空');

  // 第二次上行:队列已空 → 不再发布
  transport.deliver(`dev/${BASE}/up`, JSON.stringify(baseFrame(BASE, { seq: 1 })));
  assert.equal(transport.published.length, 1, '第二次不应再发布');
});

test('捎回:过期指令被丢弃,不发布', () => {
  const { commands, transport } = setup();
  commands.enqueue(cmd({ expires_at: Date.now() - 1 }));
  transport.deliver(`dev/${BASE}/up`, JSON.stringify(baseFrame()));
  assert.equal(transport.published.length, 0);
  assert.equal(commands.peek(BASE).length, 0, '过期者在 takeFor 里已被丢');
});

test('捎回:发布失败 → 指令回队,不丢', () => {
  const transport = new FlakyTransport();
  const { commands } = setup(transport);
  commands.enqueue(cmd({ cmd_id: 'c-keep' }));
  transport.deliver(`dev/${BASE}/up`, JSON.stringify(baseFrame()));
  assert.equal(transport.published.length, 0, '失败时不记入 published');
  assert.equal(commands.peek(BASE).length, 1, '指令应回队');
  assert.equal(commands.peek(BASE)[0]!.cmd_id, 'c-keep');
});

// ── topic 校验 / stop ───────────────────────────────────────────

test('未知 topic(段数/形状不对)→ 忽略,不算报文拒收', () => {
  const { handle, logs, transport } = setup();
  transport.deliver('dev/nope/up', JSON.stringify(baseFrame()));
  assert.equal(handle.accepted(), 0);
  assert.equal(handle.rejected(), 0, 'topic 垃圾不是 §2 拒收');
  assert.ok(logs.some((l) => l.includes('未知 topic')));
});

test('topic 设备 与 报文 device_id 不符 → 拒收', () => {
  const { pipeline, handle, transport } = setup();
  transport.deliver(`dev/base-AAAAAA/up`, JSON.stringify(baseFrame('base-BBBBBB')));
  assert.equal(handle.rejected(), 1);
  assert.equal(pipeline.stats().rejected, 1);
});

test('stop() → 关传输,后续消息不再处理', () => {
  const { handle, transport } = setup();
  handle.stop();
  assert.equal(transport.closed, true);
  transport.deliver(`dev/${BASE}/up`, JSON.stringify(baseFrame()));
  assert.equal(handle.accepted(), 0);
});

test('订阅的是通配 topic', () => {
  const { transport } = setup();
  assert.deepEqual(transport.topics, [UPLINK_TOPIC]);
});

test('parseUplinkTopic 纯函数边界', () => {
  assert.equal(parseUplinkTopic(`dev/${LID}/up`), LID);
  assert.equal(parseUplinkTopic(`dev/${BASE}/up`), BASE);
  assert.equal(parseUplinkTopic('dev/nope/up'), null);
  assert.equal(parseUplinkTopic('cup/A1B2C3/up'), null);
  assert.equal(parseUplinkTopic(`dev/${LID}`), null);
  assert.equal(parseUplinkTopic('/up'), null);
  assert.equal(parseUplinkTopic(`dev/${LID}/up/x`), null);
});

// ── app 级集成,不碰任何 MQTT 服务 ───────────────────────────────

test('createApp 注入 stub transport → 适配器→管线→Store 全通;close 关传输', async () => {
  const transport = new StubTransport();
  const app = createApp({ mqttUrl: 'mqtt://stub', mqttTransport: transport, log: () => {} });
  assert.ok(app.mqtt, '应挂上 mqtt 适配器');

  transport.deliver(`dev/${BASE}/up`, JSON.stringify(baseFrame()));
  assert.equal(app.mqtt!.accepted(), 1);
  assert.equal(app.store.latestSample(CUP_ID)?.volume_ml, 200);

  app.commands.enqueue(cmd());
  transport.deliver(`dev/${BASE}/up`, JSON.stringify(baseFrame(BASE, { seq: 2 })));
  assert.equal(transport.published[0]?.topic, `dev/${BASE}/down`);

  await app.close();
  assert.equal(transport.closed, true);
});

test('不给 mqttUrl → 无 mqtt 适配器(默认离线)', () => {
  const app = createApp({ log: () => {} });
  assert.equal(app.mqtt, null);
});
