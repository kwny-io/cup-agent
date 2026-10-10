/**
 * 模拟器 MQTT 出口 · 真 broker 联调 —— 把"模拟器当成一台真设备、经外部 broker
 * 发数据"这条路走通(三进程端到端联调里设备那一端)。
 *
 * 手法照 `apps/server/test/mqtt-broker.test.ts`:
 *   - 起**真 broker**(`aedes`,纯 JS,dev-only;之于 MQTT = `ws` 之于 WebSocket);
 *   - 起**真 mqtt 客户端**(出口本身),再起一个"后端观察者"客户端收上行;
 *   - 不做任何 stub —— 验的是 `src/mqtt/server.ts` 这个薄壳本身能不能跑通。
 *
 * 拓扑:
 *   观察者(扮演后端) ⇄ aedes broker ⇄ startMqttOutput(真出口)
 *   出口 publish `dev/<device_id>/up` → 观察者收到;观察者 publish `dev/<id>/down` → 出口收下打日志。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as NetServer } from 'node:net';
import { connect, type MqttClient } from 'mqtt';
import { Aedes } from 'aedes';
import { UpstreamFrameSchema, type Command } from '@cup/contract';
import { Engine, startMqttOutput, type Frame } from '@cup/simulator';

const CUP = 'cup-A1B2C3';
const LID = 'lid-A1B2C3';
const BASE = 'base-A1B2C3';

// ── 测试台:真 broker + 一个"后端观察者"客户端(订阅 dev/+/up)──────

interface Rig {
  url: string;
  observer: MqttClient;
  /** 观察者收到的上行消息(按到达顺序) */
  msgs: { topic: string; payload: string }[];
  dispose: () => Promise<void>;
}

async function startRig(): Promise<Rig> {
  const broker = await Aedes.createBroker();
  const net: NetServer = createServer(broker.handle);
  await new Promise<void>((r) => net.listen(0, '127.0.0.1', () => r()));
  const addr = net.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `mqtt://127.0.0.1:${port}`;

  const observer = connect(url, { clientId: 'observer', clean: true, reconnectPeriod: 0 });
  await onceConnect(observer);
  const msgs: { topic: string; payload: string }[] = [];
  observer.on('message', (topic: string, payload: Buffer) => {
    msgs.push({ topic, payload: payload.toString('utf8') });
  });
  // 扮演后端:订阅通配上行
  await new Promise<void>((r) => observer.subscribe('dev/+/up', { qos: 1 }, () => r()));

  const dispose = async (): Promise<void> => {
    observer.end(true);
    await new Promise<void>((r) => broker.close(() => r()));
    await new Promise<void>((r) => net.close(() => r()));
  };
  return { url, observer, msgs, dispose };
}

/** 给一个真 mqtt 客户端挂一次性 connect 监听 + 超时 */
function onceConnect(client: MqttClient): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等 connect 超时')), 4000);
    client.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** 轮询等待,直到条件满足或超时 */
async function waitUntil(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitUntil 超时');
    await delay(20);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 造一帧引擎产出形状的帧(lid + base + 一条 drink 事件) */
function sampleFrame(): Frame {
  const ts = Date.now();
  return {
    lid: {
      v: 1,
      device_id: LID,
      cup_id: CUP,
      ts,
      seq: 1,
      sample_ms: 300_000,
      temp_c: 55,
      level_mm: 65,
      level_pct: 50,
      motion: 'idle',
      tilt_deg: 0,
      tilt_dir: 0,
      battery_pct: 80,
      charging: false,
    },
    base: {
      v: 1,
      device_id: BASE,
      cup_id: CUP,
      ts,
      seq: 1,
      weight_g: 485,
      stable: true,
      present: true,
      temp_c: 30,
      charging: false,
      battery_pct: 90,
    },
    events: [
      {
        v: 1,
        cup_id: CUP,
        device_id: BASE,
        ts,
        type: 'drink',
        amount_ml: 120,
        confidence: 0.95,
        derived_by: 'base',
      },
    ],
  };
}

// ── 用例 ─────────────────────────────────────────────────────────

test('真 broker:broadcast 一帧 → 三个信封各自上 dev/<device_id>/up 且过契约', async () => {
  const rig = await startRig();
  const out = startMqttOutput({ url: rig.url, log: () => {} });
  try {
    await delay(200); // 出口连 broker(与 server 测试同款等待)
    out.broadcast(sampleFrame());
    // 等三个**契约信封**(kind 非 hello)都到齐
    const isEnvelope = (m: { payload: string }): boolean =>
      (JSON.parse(m.payload) as { kind?: string }).kind !== 'hello';
    await waitUntil(() => rig.msgs.filter(isEnvelope).length >= 3);

    // M2 要求:连接后向 dev/<lid>/up 发一次 {"kind":"hello","v":1}(镜像 WS 出口)
    const hello = rig.msgs.find(
      (m) => m.topic === `dev/${LID}/up` && (JSON.parse(m.payload) as { kind?: string }).kind === 'hello',
    );
    assert.ok(hello, '连接后应发一次 hello 握手到 dev/<lid>/up');

    for (const m of rig.msgs) {
      const env: unknown = JSON.parse(m.payload);
      // 握手帧不是契约报文,单独排除
      if ((env as { kind?: string }).kind === 'hello') continue;
      // 报文必须过契约 §2
      const parsed = UpstreamFrameSchema.safeParse(env);
      assert.ok(parsed.success, `报文应过契约:${m.payload}`);
      // 关键不变量:topic 里的 id == 报文 payload.device_id(后端会校验,不符即拒收)
      const deviceId = parsed.data!.payload.device_id;
      assert.equal(m.topic, `dev/${deviceId}/up`, 'topic 的 id 必须等于 payload.device_id');
    }

    // 三个信封的 device_id 都在(不 \n 拼批:一次一条)
    const ids = new Set(
      rig.msgs
        .map((m) => (JSON.parse(m.payload) as { payload?: { device_id?: string } }).payload?.device_id)
        .filter(Boolean),
    );
    assert.ok(ids.has(LID) && ids.has(BASE), 'lid 与 base 信封都单独发出');
  } finally {
    out.close();
    await rig.dispose();
  }
});

test('真 broker:engine.wireWs(出口) 后,engine.step 产出的帧确实上了 broker', async () => {
  const rig = await startRig();
  const out = startMqttOutput({ url: rig.url, log: () => {} });
  try {
    await delay(200);
    const engine = new Engine({
      config: { seed: 42, scale: 60, startMs: Date.UTC(2026, 9, 7), reportMs: 10_000, verbose: false },
      steps: [],
      sink: () => {},
    });
    engine.wireWs(out); // 出口只因有 broadcast 就被接上 —— engine 一行没改
    engine.runToEnd(60_000); // 同步跑出若干上报帧

    await waitUntil(() => rig.msgs.some((m) => m.topic === `dev/${BASE}/up`));
    const baseMsgs = rig.msgs.filter((m) => m.topic === `dev/${BASE}/up`);
    assert.ok(baseMsgs.length >= 2, `engine 的多帧上报应持续上 broker,实得 ${baseMsgs.length}`);
    const env = UpstreamFrameSchema.safeParse(JSON.parse(baseMsgs[0]!.payload));
    assert.ok(env.success && env.data.kind === 'base', 'engine 产出的是合法 base 遥测');
  } finally {
    out.close();
    await rig.dispose();
  }
});

test('真 broker:向 dev/<lid>/down 发指令 → 出口收下不崩,后续仍能上行', async () => {
  const rig = await startRig();
  const logs: string[] = [];
  const out = startMqttOutput({ url: rig.url, log: (m) => logs.push(m) });
  try {
    await delay(300); // 等出口订阅完成
    const cmd: Command = {
      v: 1,
      cmd_id: 'c-1',
      target: LID,
      ts: Date.now(),
      expires_at: Date.now() + 60_000,
      type: 'remind',
      payload: { text: '喝水' },
    };
    // 观察者(扮演后端)向设备下行
    rig.observer.publish(`dev/${LID}/down`, JSON.stringify([cmd]), { qos: 1 });
    await waitUntil(() => logs.some((l) => l.includes('收到下行')));

    // 出口没崩:还能继续上行
    const before = rig.msgs.length;
    out.broadcast(sampleFrame());
    await waitUntil(() => rig.msgs.length > before);
    assert.ok(logs.some((l) => l.includes('收到下行 1 条')), '应打出"收到下行 1 条"');
  } finally {
    out.close();
    await rig.dispose();
  }
});
