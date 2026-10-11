/**
 * 后端入口 —— M1 的交付物。
 *
 * 用法:
 *   node apps/server/src/cli.ts                          # 起 API(:8788),等模拟器
 *   node apps/server/src/cli.ts --sim ws://localhost:8787 # 连模拟器的 WS,收数据
 *   node apps/server/src/cli.ts --port 9000
 *
 * 典型联调(两个终端):
 *   # 终端 1:模拟器流出数据
 *   node apps/simulator/src/cli.ts --ws 8787 --report-ms 10000
 *   # 终端 2:后端收 + 出 API
 *   node apps/server/src/cli.ts --sim ws://localhost:8787
 *   # 浏览器 / curl:
 *   curl http://localhost:8788/cups/cup-A1B2C3/today
 */
import { createApp } from './app.ts';
import { FetchLlm, NullLlm, type Llm } from './core/llm.ts';
import { FetchChatLlm } from './core/chat/anthropic.ts';
import { NullChatLlm } from './core/chat/mock.ts';
import type { ChatLlm } from './core/chat/types.ts';
import { setDayTimeZone, getDayTimeZone } from './core/day-boundary.ts';

interface Args {
  port: number;
  simUrl: string | null;
  mqttUrl: string | null;
  quiet: boolean;
  proactive: boolean;
  cups: string[];
  /** --allow-unauth:显式豁免写端点鉴权(仅本地开发) */
  allowUnauth: boolean;
  /** --read-auth:读端点也要 x-api-key(可选层,默认读开放) */
  readAuth: boolean;
  /** 画像蒸馏阈值(自上次蒸馏后新增多少轮才再蒸);null = 用 distill.ts 默认值 */
  profileMinTurns: number | null;
  /** 日界时区(IANA,如 Asia/Shanghai);null = 服务器本地时区 */
  tz: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    port: 8788,
    simUrl: null,
    mqttUrl: process.env.CUP_MQTT_URL ?? null,
    quiet: false,
    proactive: false,
    cups: [],
    allowUnauth: false,
    readAuth: false,
    profileMinTurns: null,
    tz: process.env.CUP_TZ ?? null,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--port':
        a.port = Number(v);
        i++;
        break;
      case '--sim':
        a.simUrl = v ?? null;
        i++;
        break;
      case '--mqtt':
        a.mqttUrl = v ?? process.env.CUP_MQTT_URL ?? null;
        i++;
        break;
      case '--quiet':
        a.quiet = true;
        break;
      case '--proactive':
        a.proactive = true;
        break;
      case '--cup':
        if (v) a.cups.push(v);
        i++;
        break;
      case '--allow-unauth':
        a.allowUnauth = true;
        break;
      case '--read-auth':
        a.readAuth = true;
        break;
      case '--profile-min-turns': {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) a.profileMinTurns = Math.floor(n);
        i++;
        break;
      }
      case '--tz':
        a.tz = v ?? null;
        i++;
        break;
      case '--help':
        console.log(
          'node apps/server/src/cli.ts [--port 8788] [--sim ws://localhost:8787] [--mqtt mqtt://localhost:1883] [--quiet] [--proactive --cup cup-A1B2C3] [--profile-min-turns 8] [--allow-unauth] [--tz Asia/Shanghai]',
        );
        console.log('');
        console.log('LLM(可选,用于战报语气润色;不配则恒用模板):');
        console.log('  CUP_LLM_URL=<chat/completions 端点>');
        console.log('  CUP_LLM_KEY=<api key>');
        console.log('  CUP_LLM_MODEL=<模型名>');
        console.log('');
        console.log('对话 agent 的模型(可选,Claude Messages API;不配则回退确定性模板句):');
        console.log('  CUP_CHAT_KEY=<anthropic api key>');
        console.log('  CUP_CHAT_MODEL=<模型名,默认 claude-sonnet-4-6>');
        console.log('  CUP_CHAT_URL=<覆盖端点,默认 https://api.anthropic.com/v1/messages>');
        console.log('');
        console.log('真机 MQTT(P1 的第二个 ingest 适配器;不配则只吃模拟器 WS):');
        console.log('  CUP_MQTT_URL=<broker url,如 mqtt://localhost:1883>');
        console.log('  CUP_MQTT_CLIENT_ID=<客户端 id,默认 cup-server;多实例必须各不同>');
        console.log('');
        console.log('写端点鉴权(风险台账 R10-B;写端点**默认强制**):');
        console.log('  PUT /goal、POST /config、POST /ask 须带 x-api-key。');
        console.log('  CUP_API_KEY=<key>      指定 key;不设则启动时随机生成并打到启动横幅。');
        console.log('  --allow-unauth         显式豁免(仅本地开发);生产勿用。');
        console.log('  --read-auth            读端点也要 x-api-key(默认读开放);完整读鉴权需账号体系。');
        console.log('');
        console.log('账号 / 会话(多用户地基;POST /auth/register|login|logout,GET /auth/me):');
        console.log('  CUP_ADMIN_EMAIL=<邮箱>  该邮箱注册即得管理员(市场审核后台);不设则无管理员。');
        console.log('');
        console.log('人格档案 / 市场 / 社交(需登录会话:Authorization: Bearer <token>):');
        console.log('  GET|PUT /cups/:id/profile       人格档案(昵称 + 派生性格快照;#72)');
        console.log('  GET|POST /market/packs          浏览已上架 / 投稿人格包(#73)');
        console.log('  POST /market/packs/:id/subscribe 订阅已上架包');
        console.log('  GET /admin/users · POST /admin/users/:id/disable · GET /admin/packs?status= ·');
        console.log('    POST /admin/packs/:id/(approve|reject)  管理后台(须 role=admin)');
        console.log('  GET|POST /social/friends        好友列表 / 按邮箱加好友(#74)');
        console.log('  POST|DELETE /social/cup         绑定 / 解绑我的杯子(好友互见的口子)');
        console.log('  GET /social/team                组队 streak(共同连续达标天数)');
        console.log('');
        console.log('画像蒸馏(把攒下的对话轮归纳成长期画像;随 --proactive 巡检触发):');
        console.log('  --profile-min-turns <n>  自上次蒸馏后新增多少轮才再蒸一次(默认 8)。');
        console.log('  不配对话模型(CUP_CHAT_KEY)时阈值不可达 → 自然休眠,不白跑也不写空。');
        process.exit(0);
    }
  }
  return a;
}

/** 从环境变量组装 LLM;缺 URL/KEY → NullLlm(模板主路径,见 ADR T12) */
function makeLlm(): Llm {
  const url = process.env.CUP_LLM_URL;
  const key = process.env.CUP_LLM_KEY;
  const model = process.env.CUP_LLM_MODEL ?? 'gpt-4o-mini';
  if (!url || !key) return new NullLlm();
  return new FetchLlm({ url, apiKey: key, model });
}

/** 对话 agent 的模型;缺 KEY → NullChatLlm(聊天仍出确定性模板句,不空白) */
function makeChatLlm(): ChatLlm {
  const key = process.env.CUP_CHAT_KEY;
  const model = process.env.CUP_CHAT_MODEL ?? 'claude-sonnet-4-6';
  const url = process.env.CUP_CHAT_URL;
  if (!key) return new NullChatLlm();
  return new FetchChatLlm({ apiKey: key, model, url });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = args.quiet
    ? () => {}
    : (m: string, l: 'info' | 'warn' | 'error' = 'info') => console[l](m);

  // 日界时区:启动时设一次(非法名早失败,别等运行到半夜才炸)
  if (args.tz !== null) {
    try {
      setDayTimeZone(args.tz);
    } catch {
      console.error(`[fatal] 非法时区 --tz/CUP_TZ: ${args.tz}(${args.tz ? '应为 IANA 名,如 Asia/Shanghai' : ''})`);
      process.exit(2);
    }
  }

  const llm = makeLlm();
  const chatLlm = makeChatLlm();
  const dataDir = process.env.CUP_DATA_DIR ?? './.data';
  const apiKey = process.env.CUP_API_KEY;
  const app = createApp({
    simUrl: args.simUrl ?? undefined,
    mqttUrl: args.mqttUrl ?? undefined,
    mqttClientId: process.env.CUP_MQTT_CLIENT_ID,
    log,
    llm,
    chatLlm,
    dataDir,
    proactive: args.proactive,
    cups: args.cups,
    profileMinNewTurns: args.profileMinTurns ?? undefined,
    apiKey,
    allowUnauth: args.allowUnauth,
    readAuth: args.readAuth,
    adminEmail: process.env.CUP_ADMIN_EMAIL,
  });
  const port = await app.listen(args.port);

  console.log('─'.repeat(64));
  console.log(`后端启动 | API http://localhost:${port}`);
  console.log(`  实时: ws://localhost:${port}/cups/<cup_id>/live`);
  console.log(`  战报: http://localhost:${port}/cups/<cup_id>/report/latest`);
  console.log(`  对话: POST http://localhost:${port}/cups/<cup_id>/ask  { q }`);
  console.log(`  模拟器: ${args.simUrl ?? '(未连接,仅起 API)'}`);
  console.log(`  MQTT: ${args.mqttUrl ?? '(未连接,不接真机)'}`);
  if (args.mqttUrl) {
    console.log('        上行 dev/<device_id>/up · 下行 dev/<device_id>/down(拉取式捎回)');
  }
  console.log(
    `  LLM: ${llm.name === 'null' ? '未配置 → 战报用模板(数字仍为真实值)' : llm.name}`,
  );
  console.log(
    `  对话模型: ${chatLlm.name === 'null' ? '未配置 → 恒回退确定性模板句' : chatLlm.name}`,
  );
  console.log(`  数据目录: ${dataDir}(目标 + 对话记忆持久化)`);
  console.log(`  日界时区: ${getDayTimeZone() ?? '(服务器本地时区;--tz/CUP_TZ 可设,如 Asia/Shanghai)'}`);
  const readScope = args.readAuth ? '读+写' : '仅写';
  if (args.allowUnauth) {
    console.log('  端点鉴权: 关(--allow-unauth 显式豁免,仅本地开发;生产勿用)');
  } else if (app.apiKeyGenerated) {
    // 随机生成的 key 只在此处回显一次(供本地 curl 用);不落盘、不入日志文件。
    console.log(`  端点鉴权: 开(${readScope};随机 key,须带 x-api-key: ${app.apiKey})`);
  } else {
    console.log(`  端点鉴权: 开(${readScope};用 CUP_API_KEY,须带 x-api-key)`);
  }
  console.log(
    `  主动开口: ${args.proactive ? `开(照看 ${args.cups.join(', ') || '无 —— 加 --cup <id>'})` : '关(--proactive 开启)'}`,
  );
  console.log(
    `  画像蒸馏: ${args.proactive ? `随主动开口巡检(${args.profileMinTurns ?? '默认'} 新轮起蒸)` : '关(随 --proactive 开启)'}`,
  );
  console.log('─'.repeat(64));

  const shutdown = (): void => {
    void app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
