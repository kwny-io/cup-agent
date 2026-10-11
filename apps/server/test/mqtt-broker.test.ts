/**
 * MQTT 链路 · 真 broker 联调 —— 关掉 mqtt-adapter 那条线**唯一**没被真链路跑过的一环。
 *
 * 为什么单开一个测试文件(而不是并进 mqtt-adapter.test.ts):
 *   - `mqtt-adapter.test.ts` 用**注入 stub**,验的是适配器**逻辑**(零 broker、零网络);
 *   - 这里起一个**真 broker**(`aedes`,纯 JS,dev-only)+ 真 `mqtt` 客户端 + 真 socket,
 *     验的是**链路**(`mqtt-node-transport.ts` 这个薄壳本身能不能跑通),最外层走
 *     `createApp({ mqttUrl })` —— 亦即 P1 的验收:"真机发上来的数据,下游一行不改就能收"。
 *
 * 这正对齐 `acceptance.test.ts` 里"起一个真 WebSocketServer 当模拟器"的手法:
 * `aedes` 之于 MQTT,就是 `ws` 之于 WebSocket。它只在 devDependencies 里,
 * **运行时的五个名字不变**(ADR T17 的 P4 立场不破)。
 *
 * 拓扑:
 *   测试(扮演设备,真 mqtt 客户端) ⇄ aedes broker ⇄ createApp({mqttUrl})(真传输 + 适配器)
 * 上行 publish `dev/<id>/up` → 后端 Store;后端 `commands.enqueue` → 下次上行捎回
 * `dev/<id>/down` → 设备收到。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as NetServer } from 'node:net';
import { connect, type MqttClient } from 'mqtt';
import { Aedes } from 'aedes';
import type { Command } from '@cup/contract';
import { createApp } from '@cup/server';

const CUP_ID = 'cup-A1B2C3';
const BASE = 'base-A1B2C3';
const LID = 'lid-A1B2C3';

// ── 测试台:一个真 broker + 一条真客户端连接 ─────────────────────

/**
 * 起真 broker + 一条"设备"客户端。`createApp` 由各用例自己建(它要连同一个 url)。
 * 之所以把 broker 和 app 分开建:app 的连接是异步 attach 的,broker 必须先在。
 */
async function startRig(): Promise<{ broker: Aedes; net: NetServer; url: string; device: MqttClient; dispose: () => Promise<void> }> {
  const broker = await Aedes.createBroker();
  const net = createServer(broker.handle);
  await new Promise<void>((r) => net.listen(0, '127.0.0.1', () => r()));
  const addr = net.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `mqtt://127.0.0.1:${port}`;

  const device = connect(url, { clientId: `device-${LID}`, clean: true, reconnectPeriod: 0 });
  await once_(device, 'connect');

  const dispose = async (): Promise<void> => {
    device.end(true);
    await new Promise<void>((r) => broker.close(() => r()));
    await new Promise<void>((r) => net.close(() => r()));
  };
  return { broker, net, url, device, dispose };
}

/** 给一个真 mqtt 客户端挂一次性监听 + 超时 */
function once_(client: MqttClient, event: 'connect'): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等 ${event} 超时`)), 4000);
    client.once(event, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** 在客户端上等一条**指定 topic** 的消息,收第一条即解 */
function nextOn(client: MqttClient, topic: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等 ${topic} 的消息超时`)), timeoutMs);
    const handler = (t: string, payload: Buffer): void => {
      if (t !== topic) return;
      clearTimeout(timer);
      client.off('message', handler);
      resolve(payload.toString('utf8'));
    };
    client.on('message', handler);
  });
}

// ── 夹具:真·契约帧(与 mqtt-adapter.test.ts 同形,但走真链路)────

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

function lidFrame(deviceId = LID, extra: Record<string, unknown> = {}): unknown {
  return {
    kind: 'lid',
    payload: {
      v: 1,
      device_id: deviceId,
      cup_id: CUP_ID,
      ts: Date.now(),
      seq: 0,
      sample_ms: 300_000,
      temp_c: 55,
      level_mm: 65,
      level_pct: 50,
      motion: 'idle',
      tilt_deg: 0,
      tilt_dir: 0,
      battery_pct: 80,
      charging: false,
      ...extra,
    },
  };
}

function cmd(overrides: Partial<Command> = {}): Command {
  return {
    v: 1,
    cmd_id: 'c-1',
    target: LID,
    ts: Date.now(),
    expires_at: Date.now() + 60_000,
    type: 'remind',
    payload: { text: '喝水' },
    ...overrides,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 用例 ─────────────────────────────────────────────────────────

test('真 broker:上行 base 遥测 → 适配器 → 管线 → Store(485g→200ml)', async () => {
  const rig = await startRig();
  const app = createApp({ mqttUrl: rig.url, log: () => {} });
  try {
    // 等 app 的 mqtt 客户端连上并订阅完成
    await delay(200);
    rig.device.publish(`dev/${BASE}/up`, JSON.stringify(baseFrame()), { qos: 1 });
    await delay(200);

    assert.ok(app.mqtt, '应挂上 mqtt 适配器');
    assert.equal(app.mqtt!.accepted(), 1, `应有 1 帧被接受,实得 ${app.mqtt!.accepted()}`);
    assert.equal((await app.store.latestSample(CUP_ID))?.volume_ml, 200, '485g → 200ml');
    assert.equal((await app.store.latestSample(CUP_ID))?.derived_by, 'base');
  } finally {
    await app.close();
    await rig.dispose();
  }
});

test('真 broker:多行 \\n 批(base + event)一次发布都进', async () => {
  const rig = await startRig();
  const app = createApp({ mqttUrl: rig.url, log: () => {} });
  try {
    await delay(200);
    const batch = [
      JSON.stringify(lidFrame()),
      JSON.stringify({
        kind: 'event',
        payload: {
          v: 1,
          cup_id: CUP_ID,
          device_id: LID,
          ts: Date.now(),
          type: 'drink',
          amount_ml: 120,
          confidence: 0.9,
          derived_by: 'lid',
        },
      }),
    ].join('\n');
    rig.device.publish(`dev/${LID}/up`, batch, { qos: 1 });
    await delay(200);

    assert.equal(app.mqtt!.accepted(), 2, `多行批应有 2 帧被接受,实得 ${app.mqtt!.accepted()}`);
  } finally {
    await app.close();
    await rig.dispose();
  }
});

test('真 broker:捎回 —— 入队指令在下一次上行时经 dev/<id>/down 递回设备', async () => {
  const rig = await startRig();
  const app = createApp({ mqttUrl: rig.url, log: () => {} });
  try {
    await delay(200);
    // 设备先订阅自己的下行 topic
    await new Promise<void>((r) => rig.device.subscribe(`dev/${LID}/down`, () => r()));
    const down = nextOn(rig.device, `dev/${LID}/down`);

    // 后端起一条指令(模拟"改目标 → 生成 config 指令入队")
    app.commands.enqueue(cmd({ cmd_id: 'c-down-1', target: LID }));

    // 设备上行一次 → 捎回
    rig.device.publish(`dev/${LID}/up`, JSON.stringify(lidFrame()), { qos: 1 });

    const payload = await down;
    const got = JSON.parse(payload) as Command[];
    assert.equal(got.length, 1, '应捎回 1 条');
    assert.equal(got[0]!.cmd_id, 'c-down-1');
    assert.equal(got[0]!.target, LID);
    // 取走后队列空
    assert.equal(app.commands.peek(LID).length, 0);

    // 再上行一次:队列已空 → 不再发(设备侧 200ms 内不应再收到)
    let extra = false;
    const h = (): void => {
      extra = true;
    };
    rig.device.on('message', h);
    rig.device.publish(`dev/${LID}/up`, JSON.stringify(lidFrame(LID, { seq: 1 })), { qos: 1 });
    await delay(200);
    rig.device.off('message', h);
    assert.equal(extra, false, '空队列不应再发下行');
  } finally {
    await app.close();
    await rig.dispose();
  }
});

test('真 broker:坏契约报文 → 拒收,好报文照常进库、下游不受影响', async () => {
  const rig = await startRig();
  const logs: string[] = [];
  const app = createApp({ mqttUrl: rig.url, log: (m) => logs.push(m) });
  try {
    await delay(200);
    rig.device.publish(`dev/${BASE}/up`, JSON.stringify(baseFrame(BASE, { temp_c: 999 })), { qos: 1 });
    await delay(150);
    rig.device.publish(`dev/${BASE}/up`, 'not json {{{', { qos: 1 });
    await delay(150);
    rig.device.publish(`dev/${BASE}/up`, JSON.stringify(baseFrame()), { qos: 1 });
    await delay(200);

    assert.equal(app.mqtt!.rejected(), 2, `应拒收 2 条,实得 ${app.mqtt!.rejected()}`);
    assert.equal(app.mqtt!.accepted(), 1, `应接受 1 条,实得 ${app.mqtt!.accepted()}`);
    assert.equal(app.pipeline.stats().rejected, 2);
    assert.ok(logs.some((l) => l.includes('拒收')), '应有拒收日志');
    assert.equal((await app.store.latestSample(CUP_ID))?.volume_ml, 200, '好报文仍进库');
  } finally {
    await app.close();
    await rig.dispose();
  }
});

test('真 broker:topic 设备与报文 device_id 不符 → 拒收(防固件发错 topic)', async () => {
  const rig = await startRig();
  const app = createApp({ mqttUrl: rig.url, log: () => {} });
  try {
    await delay(200);
    rig.device.publish(`dev/base-AAAAAA/up`, JSON.stringify(baseFrame('base-BBBBBB')), { qos: 1 });
    await delay(200);
    assert.equal(app.mqtt!.rejected(), 1);
    assert.equal(await app.store.latestSample(CUP_ID), null, '不符的帧不进库');
  } finally {
    await app.close();
    await rig.dispose();
  }
});

test('真 broker:close() 后不再收;transports 真断开(不悬挂 handle)', async () => {
  const rig = await startRig();
  const app = createApp({ mqttUrl: rig.url, log: () => {} });
  await delay(200);
  assert.equal(app.mqtt!.accepted(), 0);
  await app.close();
  // 关后再发:不应再被处理(计数器冻结)
  rig.device.publish(`dev/${BASE}/up`, JSON.stringify(baseFrame()), { qos: 1 });
  await delay(200);
  assert.equal(app.mqtt!.accepted(), 0, 'close 后不应再接收');
  await rig.dispose();
});
