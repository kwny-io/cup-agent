/**
 * 模拟器 CLI —— M0 的交付物。
 *
 * 用法:
 *   node apps/simulator/src/cli.ts                        # 实时跑典型一天(scale=60)
 *   node apps/simulator/src/cli.ts --scale 86400          # 1 秒 = 1 天(瞬时跑完)
 *   node apps/simulator/src/cli.ts --scenario smoke        # 简短冒烟
 *   node apps/simulator/src/cli.ts --days 3                # 连续跑 3 天
 *   node apps/simulator/src/cli.ts --ws 8787               # 同时起 WebSocket 服务
 *   node apps/simulator/src/cli.ts --mqtt mqtt://localhost:1883  # 经外部 broker 发(设备协议)
 *   node apps/simulator/src/cli.ts --quiet                 # 只看事件,不看每步日志
 */
import { Engine, dayStartMs, type Frame } from './core/engine.ts';
import { typicalDay, smoke } from './scenarios/day.ts';
import { startWsServer } from './ws/server.ts';
import { startMqttOutput } from './mqtt/server.ts';
import type { CupEvent } from '@cup/contract';

interface Args {
  scale: number;
  scenario: 'day' | 'smoke';
  days: number;
  wsPort: number | null;
  mqttUrl: string | null;
  verbose: boolean;
  seed: number;
  start: string | null;
  reportMs: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    scale: 60,
    scenario: 'day',
    days: 1,
    wsPort: null,
    mqttUrl: null,
    verbose: true,
    seed: 42,
    start: null,
    reportMs: 300_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--scale':
        a.scale = Number(v);
        i++;
        break;
      case '--scenario':
        a.scenario = v === 'smoke' ? 'smoke' : 'day';
        i++;
        break;
      case '--days':
        a.days = Number(v);
        i++;
        break;
      case '--ws':
        a.wsPort = Number(v);
        i++;
        break;
      case '--mqtt':
        a.mqttUrl = v ?? null;
        i++;
        break;
      case '--quiet':
        a.verbose = false;
        break;
      case '--seed':
        a.seed = Number(v);
        i++;
        break;
      case '--start':
        a.start = v ?? null;
        i++;
        break;
      case '--report-ms':
        a.reportMs = Number(v);
        i++;
        break;
      case '--help':
        console.log(
          'node apps/simulator/src/cli.ts [--scale N] [--scenario day|smoke] [--days N] [--ws PORT] [--mqtt URL] [--quiet] [--seed N] [--start HH:MM] [--report-ms N]',
        );
        process.exit(0);
    }
  }
  return a;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  let startMs = dayStartMs(Date.now());
  if (args.start) {
    const [h, m] = args.start.split(':').map(Number);
    startMs += ((h ?? 0) * 60 + (m ?? 0)) * 60 * 1000;
  }

  const baseSteps = args.scenario === 'smoke' ? smoke() : typicalDay();
  const steps = args.days > 1 ? repeatDays(baseSteps, args.days) : baseSteps;

  const stats = { lid: 0, base: 0, events: {} as Record<string, number> };

  const ws = args.wsPort !== null ? startWsServer(args.wsPort) : null;
  const mqtt =
    args.mqttUrl !== null
      ? startMqttOutput({ url: args.mqttUrl, log: (m) => console.log(m) })
      : null;

  const sink = (frame: Frame): void => {
    if (frame.lid) stats.lid++;
    if (frame.base) stats.base++;
    for (const e of frame.events) stats.events[e.type] = (stats.events[e.type] ?? 0) + 1;
    if (args.verbose) {
      for (const e of frame.events) console.log(`    ⚡ ${e.type}${detail(e)}`);
    }
  };

  const engine = new Engine({
    config: {
      seed: args.seed,
      scale: args.scale,
      startMs,
      reportMs: args.reportMs,
      verbose: args.verbose,
    },
    steps,
    sink,
  });
  // 出口接线:--ws 与 --mqtt 可同给(前端看 WS、后端吃 MQTT)→ fan-out 到两个出口;
  // 只给一个则直连;都没给则不接实时出口(下方走瞬时 runToEnd)。
  const output =
    ws && mqtt
      ? {
          broadcast: (f: Frame) => {
            ws.broadcast(f);
            mqtt.broadcast(f);
          },
        }
      : (ws ?? mqtt);
  engine.wireWs(output);

  console.log('─'.repeat(64));
  console.log(`模拟器启动 | 场景=${args.scenario} 天数=${args.days} 加速=${args.scale}× seed=${args.seed}`);
  console.log(`虚拟起点=${new Date(startMs).toLocaleString()}`);
  console.log(`设备 lid=${engine.config.lidId} base=${engine.config.baseId} cup=${engine.config.cupId}`);
  if (ws) console.log(`WebSocket: ws://localhost:${args.wsPort}`);
  if (mqtt) console.log(`MQTT: ${args.mqttUrl}(出口 ws+mqtt fan-out=${ws && mqtt ? '开' : '关'})`);
  console.log('─'.repeat(64));

  const t0 = Date.now();
  const finish = (ticks: number): void => {
    const realMs = Date.now() - t0;
    const fin = engine.world.snapshot(engine.clock.nowMs);
    console.log('─'.repeat(64));
    console.log(`✅ 完成 | 真实耗时 ${(realMs / 1000).toFixed(2)}s (${ticks} ticks)`);
    console.log(`   上报: 杯盖 ${stats.lid} 帧,底座 ${stats.base} 帧`);
    console.log(
      `   事件: ${
        Object.entries(stats.events)
          .map(([k, v]) => `${k}×${v}`)
          .join('  ') || '(无)'
      }`,
    );
    console.log(`   最终: ${fin.volumeMl.toFixed(0)}ml @ ${fin.tempC.toFixed(1)}°C`);
    console.log('─'.repeat(64));
    ws?.close();
    mqtt?.close();
  };

  if (ws || mqtt) {
    // 实时模式:数据流式发出,供前端订阅 / 后端消费;Ctrl-C 结束
    console.log('实时模式(Ctrl-C 结束)…');
    void engine.runRealtime().then(() => finish(0));
  } else {
    const { ticks } = engine.runToEnd(args.scenario === 'smoke' ? 20_000 : 3_600_000);
    finish(ticks);
  }
}

function repeatDays(steps: ReturnType<typeof typicalDay>, days: number) {
  const dayMs = 24 * 60 * 60 * 1000;
  const out: typeof steps = [];
  for (let d = 0; d < days; d++) {
    for (const s of steps) {
      out.push({ ...s, atMs: s.atMs + d * dayMs, label: `D${d + 1} ${s.label}` });
    }
  }
  return out;
}

function detail(e: CupEvent): string {
  const parts: string[] = [];
  if (e.amount_ml !== undefined) parts.push(`${e.amount_ml}ml`);
  if (e.temp_c !== undefined) parts.push(`${e.temp_c.toFixed(1)}°C`);
  return parts.length > 0 ? `  (${parts.join(', ')})` : '';
}

main();
