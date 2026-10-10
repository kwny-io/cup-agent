/**
 * 独立 broker 进程 —— **开发/联调专用**,给"三进程端到端"补上缺的那台 broker。
 *
 * 为什么需要它:MQTT 链路此前只在**进程内**验证过(`test/mqtt-broker.test.ts` 起一个
 * 临时 aedes broker)。但**真机部署形状**是三个独立进程:
 *
 *   模拟器(设备) ──MQTT──> broker(本进程) ──MQTT──> 后端(独立进程)
 *
 * 本文件就是把中间那台 broker 单独拉出来,好让三个进程真正分开跑。
 *
 * 用法:
 *   node apps/server/src/dev-broker-cli.ts                 # :1883
 *   node apps/server/src/dev-broker-cli.ts --port 1884
 *
 * 依赖:`aedes` 是**根 devDependency**(纯 JS 内存 broker)。它**不进运行时依赖名单**
 * (仍是 `ws` / `mqtt` / zod / @cup/contract / react 那五个,ADR T17 的 P4 立场不破)——
 * 因为它只在本文件(dev 工具)里被 import。这也是本文件与 `mqtt-node-transport.ts` 的区别:
 * 后者是运行时外壳,前者是开发脚手架。
 *
 * 注意:本文件像所有 `cli.ts` 一样**import 即执行(`void main()`)** —— 它只给人 `node` 跑,
 * 不被任何模块 import(故下面的函数**不导出**,避免"import 一下就顺手起了台 broker")。
 * 要用可复用的编程接口请进 `mqtt-adapter.ts`。
 */
import { createServer, type Server as NetServer } from 'node:net';
import { Aedes } from 'aedes';

interface Args {
  port: number;
  host: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    port: Number(process.env.CUP_MQTT_PORT ?? 1883),
    host: process.env.CUP_MQTT_HOST ?? '0.0.0.0',
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--port':
        a.port = Number(v);
        i++;
        break;
      case '--host':
        a.host = v ?? a.host;
        i++;
        break;
      case '--help':
        console.log('node apps/server/src/dev-broker-cli.ts [--port 1883] [--host 0.0.0.0]');
        console.log('');
        console.log('环境变量:CUP_MQTT_PORT / CUP_MQTT_HOST(参数优先)');
        process.exit(0);
    }
  }
  return a;
}

/** 起 broker,返回句柄 */
async function startDevBroker(port: number, host: string): Promise<{ net: NetServer; close: () => Promise<void> }> {
  const broker = await Aedes.createBroker();
  const net = createServer(broker.handle);

  broker.on('client', (c) => console.log(`[broker] 客户端接入: ${c?.id ?? '(匿名)'}`));
  broker.on('clientDisconnect', (c) => console.log(`[broker] 客户端断开: ${c?.id ?? '(匿名)'}`));
  broker.on('subscribe', (subs, c) => {
    for (const s of subs) console.log(`[broker] ${c?.id ?? '(匿名)'} 订阅 ${s.topic}`);
  });
  broker.on('publish', (pkt, c) => {
    // 只记上行 topic,避免把下行(后端回给设备)和 broker 内部包也刷屏
    if (pkt.topic?.endsWith('/up')) console.log(`[broker] ${c?.id ?? '(匿名)'} → ${pkt.topic}`);
  });

  await new Promise<void>((r, rej) => {
    net.once('error', rej);
    net.listen(port, host, () => r());
  });
  return {
    net,
    close: async () => {
      await new Promise<void>((r) => broker.close(() => r()));
      await new Promise<void>((r) => net.close(() => r()));
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { close } = await startDevBroker(args.port, args.host);
  console.log('─'.repeat(56));
  console.log(`dev broker 已起 | mqtt://${args.host}:${args.port}`);
  console.log('  上行 dev/<device_id>/up · 下行 dev/<device_id>/down');
  console.log('  模拟器: node apps/simulator/src/cli.ts --mqtt mqtt://localhost:' + args.port);
  console.log('  后端:   node apps/server/src/cli.ts --mqtt mqtt://localhost:' + args.port);
  console.log('─'.repeat(56));

  const shutdown = (): void => {
    void close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
