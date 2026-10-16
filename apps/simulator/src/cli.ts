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
 *   node apps/simulator/src/cli.ts --backfill 90 --target goal   # 向后端回填 90 天历史(成长/连击)
 */
import { Engine, dayStartMs, type Frame } from './core/engine.ts';
import { typicalDay, smoke } from './scenarios/day.ts';
import { runBackfill, type BackfillTier } from './scenarios/backfill.ts';
import { startWsServer } from './ws/server.ts';
import { startMqttOutput } from './mqtt/server.ts';
import { parseControl, applyControl } from './core/control.ts';
import { deriveSeed64 } from './util/rng.ts';
import { generateClaim, buildHello, type HelloFrame } from './util/claim.ts';
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
  /** 回填天数(非 null 则走回填模式:不再实时跑,只把历史灌进后端) */
  backfill: number | null;
  backfillTarget: BackfillTier;
  server: string;
  apiKey: string | null;
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
    backfill: null,
    backfillTarget: 'goal',
    server: process.env.CUP_SERVER ?? 'http://localhost:8788',
    apiKey: process.env.CUP_API_KEY ?? null,
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
      case '--backfill':
        a.backfill = Number(v);
        i++;
        break;
      case '--target':
        a.backfillTarget = v === 'sparse' ? 'sparse' : 'goal';
        i++;
        break;
      case '--server':
        a.server = v ?? a.server;
        i++;
        break;
      case '--api-key':
        a.apiKey = v ?? null;
        i++;
        break;
      case '--help':
        console.log(
          'node apps/simulator/src/cli.ts [--scale N] [--scenario day|smoke] [--days N] [--ws PORT] [--mqtt URL] [--quiet] [--seed N] [--start HH:MM] [--report-ms N]',
        );
        console.log(
          'node apps/simulator/src/cli.ts --backfill <days> [--target goal|sparse] [--server URL] [--api-key KEY]  # 向后端回填历史',
        );
        process.exit(0);
    }
  }
  return a;
}

/**
 * 回填模式 —— 生成 N 天历史事件,按**旧 → 新**逐天 POST 到后端 `/cups/:id/ingest`。
 * 与实时跑一天不同:这里是**离线补历史**(ts 回填到过去),后端既有的 ingest 端点照单全收。
 */
function runBackfillMode(args: Args): void {
  const days = Math.max(1, Math.floor(args.backfill ?? 1));
  // 用引擎的默认设备 id(与实时模式一致;回填的目标就是同一只杯)
  const cupId = 'cup-A1B2C3';
  const baseId = 'base-A1B2C3';
  console.log('─'.repeat(64));
  console.log(`回填 | 天数=${days} 档位=${args.backfillTarget} 目标后端=${args.server}`);
  console.log(`     设备 base=${baseId} cup=${cupId} seed=${args.seed}`);
  console.log(`     鉴权: ${args.apiKey ? '带 x-api-key' : '不带(后端须 --allow-unauth 或免鉴权)'}`);
  console.log('─'.repeat(64));
  void runBackfill({
    server: args.server,
    cupId,
    baseId,
    days,
    tier: args.backfillTarget,
    seed: args.seed,
    apiKey: args.apiKey,
  })
    .then((r) => {
      console.log('─'.repeat(64));
      console.log(`✅ 回填完成 | ${r.days} 天 → 收 ${r.accepted} / 去重 ${r.deduped} / 拒 ${r.rejected}`);
      console.log('   (连击/成长指标的最终值由后端日聚合给出;重复跑同一后端会被去重)');
      console.log('─'.repeat(64));
    })
    .catch((e: unknown) => {
      console.error(`❌ 回填失败:${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  // 回填模式:不实时跑,只把历史事件灌进后端(详见 scenarios/backfill.ts)。
  if (args.backfill !== null) {
    runBackfillMode(args);
    return;
  }

  let startMs = dayStartMs(Date.now());
  if (args.start) {
    const [h, m] = args.start.split(':').map(Number);
    startMs += ((h ?? 0) * 60 + (m ?? 0)) * 60 * 1000;
  }

  const baseSteps = args.scenario === 'smoke' ? smoke() : typicalDay();
  const steps = args.days > 1 ? repeatDays(baseSteps, args.days) : baseSteps;

  const stats = { lid: 0, base: 0, events: {} as Record<string, number> };

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

  // 手动控制:WS 客户端发来的 {"type":...} 作用到 world(pause/resume 改主循环)。
  const onControl = (msg: unknown): void => {
    const parsed = parseControl(msg);
    if (!parsed.ok) {
      console.log(`[控制] 忽略:${parsed.error}`);
      return;
    }
    const outcome = applyControl(
      {
        world: engine.world,
        scheduler: engine.scheduler,
        clock: engine.clock,
        log: (m) => console.log(m),
        config: engine.config,
      },
      parsed.cmd,
    );
    if (outcome.loop === 'pause') engine.setPaused(true);
    if (outcome.loop === 'resume') engine.setPaused(false);
    console.log(`[控制] ${parsed.cmd.type} → ${outcome.detail}`);
  };

  // 可信绑定的设备半:造一枚与固件同算法的一次性 claim code + 真机形状的 hello 帧。
  // 两个出口共用**同一枚** hello(同一设备对前后端报同一枚码,否则后端去重会看到两枚而困惑)。
  const claim = generateClaim(deriveSeed64(args.seed, 1));
  const hello: HelloFrame = buildHello(engine.config.lidId, engine.config.cupId, claim, Date.now());

  const ws = args.wsPort !== null ? startWsServer(args.wsPort, { onControl, hello: () => hello }) : null;
  const mqtt =
    args.mqttUrl !== null
      ? startMqttOutput({ url: args.mqttUrl, log: (m) => console.log(m), hello })
      : null;

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
  console.log(`设备绑定码(可信绑定用,一次性): ${claim}  ← 在 App 里输入以绑定这只杯`);
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
    // 实时模式:数据流式发出,供前端订阅 / 后端消费。脚本跑完后出口**保持存活**(不再闪退),
    // Ctrl-C 结束 → 打印汇总并关出口。用 once 防连按两次触发重复收尾。
    console.log('实时模式(Ctrl-C 结束;跑完脚本后仍保持连接)…');
    let closing = false;
    const shutdown = (): void => {
      if (closing) return;
      closing = true;
      engine.stopRealtime?.();
      finish(0);
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    void engine.runRealtime().then(() => { if (!closing) shutdown(); });
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
