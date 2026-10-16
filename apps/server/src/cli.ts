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
import { createPgPool } from './store/pg/pool.ts';
import {
  migrate,
  applyRetention,
  retainDaysFromEnv,
  DEFAULT_TELEMETRY_RETAIN_DAYS,
  DEFAULT_EVENTS_RETAIN_DAYS,
  DEFAULT_SERVER_LOGS_RETAIN_DAYS,
  type RetentionOptions,
} from './store/pg/migrate.ts';
import { createLogger, parseLogLevel, parseLogFormat, type LogLevel } from './core/logger.ts';
import { seedOfficialPacks } from './core/social/official-packs.ts';

interface Args {
  port: number;
  simUrl: string | null;
  mqttUrl: string | null;
  quiet: boolean;
  proactive: boolean;
  cups: string[];
  /** --allow-unauth:显式豁免读+写端点鉴权(仅本地开发) */
  allowUnauth: boolean;
  /** --require-claim:绑定杯子须出示设备一次性 claim code(可信绑定;**默认开**,CUP_REQUIRE_CLAIM=0|false 关) */
  requireClaim: boolean;
  /** 人格市场开放开关(D3 灰度;**默认关**,CUP_MARKET_OPEN=1|true 开) */
  marketOpen: boolean;
  /** 画像蒸馏阈值(自上次蒸馏后新增多少轮才再蒸);null = 用 distill.ts 默认值 */
  profileMinTurns: number | null;
  /** 日界时区(IANA,如 Asia/Shanghai);null = 服务器本地时区 */
  tz: string | null;
  /** 日志最低级别(debug/info/warn/error);--log-level / CUP_LOG_LEVEL */
  logLevel: LogLevel;
  /** 日志格式:text(默认) / json;--log-format / CUP_LOG_FORMAT */
  logFormat: 'text' | 'json';
  /** 持久化日志的 JSONL 文件出口目录;CUP_LOG_DIR,不设 = 不落文件 */
  logDir: string | null;
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
    // 可信绑定默认开(绑定须出示设备一次性码);仅显式 `CUP_REQUIRE_CLAIM=0/false` 才关。
    requireClaim: !(process.env.CUP_REQUIRE_CLAIM === '0' || process.env.CUP_REQUIRE_CLAIM === 'false'),
    // 人格市场灰度默认**关**(未设=关);仅显式 `CUP_MARKET_OPEN=1/true` 才开。
    marketOpen: process.env.CUP_MARKET_OPEN === '1' || process.env.CUP_MARKET_OPEN === 'true',
    profileMinTurns: null,
    tz: process.env.CUP_TZ ?? null,
    logLevel: parseLogLevel(process.env.CUP_LOG_LEVEL),
    logFormat: parseLogFormat(process.env.CUP_LOG_FORMAT),
    logDir: process.env.CUP_LOG_DIR ?? null,
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
      case '--require-claim':
        a.requireClaim = true;
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
      case '--log-level':
        a.logLevel = parseLogLevel(v, a.logLevel);
        i++;
        break;
      case '--log-format':
        a.logFormat = parseLogFormat(v);
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
        console.log('  --allow-unauth         显式豁免读+写(仅本地开发);生产勿用。');
        console.log('  读端点(今日/趋势/事件/状态/战报/性格史/档案)须登录会话 + 杯子归属(S4)。');
        console.log('');
        console.log('账号 / 会话(多用户地基;POST /auth/register|login|logout,GET /auth/me):');
        console.log('  CUP_ADMIN_EMAIL=<邮箱>  该邮箱注册即得管理员(市场审核后台);不设则无管理员。');
        console.log('');
        console.log('人格市场灰度(D3;**默认关**):');
        console.log('  CUP_MARKET_OPEN=1|true  开放市场(货架可读、可投稿);');
        console.log('  不设 / =0|false         关:GET /market/packs 回空、投稿 503、前端显示「暂未开放」。');
        console.log('  管理员带 ?status= 的审读口不受开关影响;GET /market/status 回当前开关。');
        console.log('');
        console.log('可信绑定(风险 R18;绑定杯子须出示设备一次性 claim code):');
        console.log('  --require-claim / CUP_REQUIRE_CLAIM=1  开启(**默认已开**)。');
        console.log('  CUP_REQUIRE_CLAIM=0|false  显式关闭(退回"自证绑定",仅本地开发);生产勿关。');
        console.log('  CUP_CLAIM_PEPPER=<base64>  码哈希的 pepper;不设则由 dataDir/claim-pepper 落盘。');
        console.log('');
        console.log('每杯模型配置(BYOK:登录后给自己那只杯配模型 + 填自己的 key):');
        console.log('  GET|PUT|DELETE /cups/:id/llm   读写该杯模型(须登录会话 + 拥有该杯;key 密文落库、不回显)');
        console.log('  CUP_LLM_ENC_KEY=<base64 32B>   key 的加密密钥;不设则由 dataDir/llm-enc-key 落盘。');
        console.log('  配了自选模型的杯:/ask 改走账户鉴权(登录 + 拥有该杯)并用该杯模型;未配 → 旧路径不变。');
        console.log('');
        console.log('人格档案 / 市场 / 社交(需登录会话:Authorization: Bearer <token>):');
        console.log('  GET|PUT /cups/:id/profile       人格档案(昵称 + 派生性格快照;#72)');
        console.log('  GET|POST /market/packs          浏览已上架 / 投稿人格包(#73)');
        console.log('  POST /market/packs/:id/subscribe 订阅已上架包');
        console.log('  GET /market/subscriptions       我订过的包(只回已上架的)');
        console.log('  GET /admin/users · POST /admin/users/:id/disable · GET /admin/packs?status= ·');
        console.log('    POST /admin/packs/:id/(approve|reject)  管理后台(须 role=admin)');
        console.log('  GET|POST /social/friends        好友列表 / 按邮箱加好友(#74)');
        console.log('  POST|DELETE /social/cup         绑定 / 解绑我的杯子(好友互见的口子)');
        console.log('  GET /social/team                组队 streak(共同连续达标天数)');
        console.log('');
        console.log('画像蒸馏(把攒下的对话轮归纳成长期画像;随 --proactive 巡检触发):');
        console.log('  --profile-min-turns <n>  自上次蒸馏后新增多少轮才再蒸一次(默认 8)。');
        console.log('  不配对话模型(CUP_CHAT_KEY)时阈值不可达 → 自然休眠,不白跑也不写空。');
        console.log('');
        console.log('日志:');
        console.log('  --log-level <debug|info|warn|error>  最低级别(默认 info);或 CUP_LOG_LEVEL。');
        console.log('  --log-format <text|json>             输出格式(默认 text);或 CUP_LOG_FORMAT=json。');
        console.log('');
        console.log('服务日志落库 / 外部采集(供 admin/ops/reviewer 回看;写入时脱敏):');
        console.log('  CUP_LOG_DIR=<目录>   结构化日志按行落 JSONL(server-YYYY-MM-DD.log);不设 = 不落文件。');
        console.log('                       filebeat/fluentd 等采集器可直接 tail;有 CUP_PG_URL 时同时落 server_logs 表。');
        console.log('  --quiet              控制台静音,**不影响落库/落文件**(安静跑但仍可回看)。');
        console.log('  CUP_OPS_EMAILS=<邮箱,逗号分隔>       该邮箱注册即得运维(日志读 + 触发保留清理)。');
        console.log('  CUP_REVIEWER_EMAILS=<邮箱,逗号分隔>  该邮箱注册即得审核(日志只读:查 + 导出)。');
        console.log('  看/查: GET /admin/logs?level=&src=&q=&from=&to=&limit=&cursor=(须 admin/ops/reviewer)');
        console.log('         GET /admin/logs/partitions(分区占用)· POST /admin/logs/retain(清过期分区,不可逆)');
        console.log('');
        console.log('Postgres 存储 / 保留策略(第 5 阶段;仅在 CUP_PG_URL 存在时):');
        console.log('  CUP_PG_URL=postgres://…  选了它才走 PG(启动前自动迁移);不设 → 内存/文件。');
        console.log('  --migrate               跑完迁移即退(部署用)。');
        console.log('  --retain                跑完迁移 + 删过期月分区即退(**不可逆**,定时任务用)。');
        console.log('  CUP_RETENTION=1         服务启动时顺带清一次过期分区。');
        console.log('  CUP_TELEMETRY_RETAIN_DAYS=<n>  遥测保留天数(默认 90)。');
        console.log('  CUP_EVENTS_RETAIN_DAYS=<n>     事件保留天数(默认 395,约 13 个月)。');
        console.log('  CUP_SERVER_LOGS_RETAIN_DAYS=<n> 服务日志保留天数(默认 90)。');
        console.log('  保留策略按**整月分区**删(不逐行删);cutoff 所在月保留、当前月永不删。');
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

/** 保留期(第 5 阶段):从环境变量读天数,缺省用默认。**删整分区不可逆 → 须显式开启**。 */
function retentionOptions(): RetentionOptions {
  return {
    telemetryDays: retainDaysFromEnv('CUP_TELEMETRY_RETAIN_DAYS', DEFAULT_TELEMETRY_RETAIN_DAYS),
    eventsDays: retainDaysFromEnv('CUP_EVENTS_RETAIN_DAYS', DEFAULT_EVENTS_RETAIN_DAYS),
    serverLogsDays: retainDaysFromEnv('CUP_SERVER_LOGS_RETAIN_DAYS', DEFAULT_SERVER_LOGS_RETAIN_DAYS),
  };
}

/** 对话 agent 的模型;缺 KEY → NullChatLlm(聊天仍出确定性模板句,不空白) */
function makeChatLlm(): ChatLlm {
  const key = process.env.CUP_CHAT_KEY;
  const model = process.env.CUP_CHAT_MODEL ?? 'claude-sonnet-4-6';
  const url = process.env.CUP_CHAT_URL;
  if (!key) return new NullChatLlm();
  return new FetchChatLlm({ apiKey: key, model, url });
}

/** 逗号分隔的邮箱名单(去空、去重前的原样);未设/空 → undefined(不授予该角色)。 */
function emailList(raw: string | undefined): readonly string[] | undefined {
  if (!raw) return undefined;
  const list = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return list.length > 0 ? list : undefined;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // **引导 logger**:只用于 createApp 之前的消息(迁移/启动自检)。持久化日志管线由
  // createApp 内部拥有(见 app.ts)—— 故这里**不**把 log 传给它,否则会走"注入 log"分支、
  // 绕过落库/落文件。--quiet 在此处也静音引导消息。
  const log = args.quiet
    ? () => {}
    : createLogger({ level: args.logLevel, format: args.logFormat });

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
  const pgUrl = process.env.CUP_PG_URL;

  // --migrate:跑完迁移即退(CI / 部署用)。须先于 createApp —— 表没建好别起服务。
  if (process.argv.includes('--migrate')) {
    if (!pgUrl) {
      console.error('[fatal] --migrate 需要 CUP_PG_URL(未设 → 无库可迁)');
      process.exit(2);
    }
    const pool = createPgPool(pgUrl);
    try {
      const ran = await migrate(pool);
      console.log(ran.length ? `迁移完成:${ran.join(', ')}` : '迁移完成:已是最新');
      await pool.end();
      process.exit(0);
    } catch (err) {
      console.error(`[fatal] 迁移失败:${(err as Error).message}`);
      await pool.end();
      process.exit(2);
    }
  }

  // --retain:跑完迁移 + 保留策略(删过期月分区)即退(CI / 定时任务用)。
  // **删整分区不可逆** → 只在此处与 CUP_RETENTION=1 启动时执行,绝不隐式跑。
  if (process.argv.includes('--retain')) {
    if (!pgUrl) {
      console.error('[fatal] --retain 需要 CUP_PG_URL(未设 → 无库可清)');
      process.exit(2);
    }
    const pool = createPgPool(pgUrl);
    try {
      await migrate(pool); // 分区得先存在才谈得上删
      const opt = retentionOptions();
      const dropped = await applyRetention(pool, opt, (m) => console.log(m));
      console.log(
        dropped.length
          ? `保留策略完成:删除 ${dropped.length} 个过期分区(${dropped.join(', ')})`
          : '保留策略完成:无过期分区',
      );
      await pool.end();
      process.exit(0);
    } catch (err) {
      console.error(`[fatal] 保留策略失败:${(err as Error).message}`);
      await pool.end();
      process.exit(2);
    }
  }

  // 选了 Postgres:启动前先跑迁移(失败即带清晰 fatal 中止,别起一个半死不活的服务)
  if (pgUrl) {
    const pool = createPgPool(pgUrl);
    try {
      const ran = await migrate(pool);
      if (ran.length) log(`已跑迁移:${ran.join(', ')}`);
      // CUP_RETENTION=1:启动时顺带清一次过期分区(定时的便捷替代;不设则只在 --retain 时跑)
      if (process.env.CUP_RETENTION === '1' || process.env.CUP_RETENTION === 'true') {
        const dropped = await applyRetention(pool, retentionOptions(), log);
        if (dropped.length) log(`保留策略:删除过期分区 ${dropped.join(', ')}`);
      }
    } catch (err) {
      console.error(`[fatal] 迁移失败:${(err as Error).message}`);
      await pool.end();
      process.exit(2);
    }
    await pool.end(); // 迁移用的池关掉;createApp 会按 pgUrl 自建它自己的池
  }

  const app = createApp({
    simUrl: args.simUrl ?? undefined,
    mqttUrl: args.mqttUrl ?? undefined,
    mqttClientId: process.env.CUP_MQTT_CLIENT_ID,
    logLevel: args.logLevel,
    logFormat: args.logFormat,
    logDir: args.logDir,
    logQuiet: args.quiet,
    llm,
    chatLlm,
    dataDir,
    pgUrl,
    proactive: args.proactive,
    cups: args.cups,
    profileMinNewTurns: args.profileMinTurns ?? undefined,
    apiKey,
    allowUnauth: args.allowUnauth,
    adminEmail: process.env.CUP_ADMIN_EMAIL,
    opsEmails: emailList(process.env.CUP_OPS_EMAILS),
    reviewerEmails: emailList(process.env.CUP_REVIEWER_EMAILS),
    retention: retentionOptions(),
    requireClaim: args.requireClaim,
    marketOpen: args.marketOpen,
  });

  // 官方人格包种子(P4-D3 冷启动):幂等,已存在则跳过。放这里而非 createApp 内 ——
  // createApp 是同步的、且测试里数包数(市场空着是断言前提),种子只该在真启动时跑。
  const seeded = await seedOfficialPacks(app.accounts, Date.now());
  if (seeded) log(`人格市场种子:新种入 ${seeded} 个官方包`);

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
  {
    // 持久日志出口:文件(CUP_LOG_DIR)+ DB(有 PG 即落 server_logs)。两者皆无 = 只打控制台。
    const filePart = args.logDir ?? '关';
    const dbPart = pgUrl ? 'on' : 'off(无 CUP_PG_URL)';
    console.log(
      `  持久日志: 文件=${filePart} · DB=${dbPart}${args.quiet ? ' · 控制台静音(--quiet,持久化照常)' : ''}(看/查:GET /admin/logs)`,
    );
  }
  if (args.allowUnauth) {
    console.log('  端点鉴权: 关(--allow-unauth 显式豁免,仅本地开发;生产勿用)');
  } else if (app.apiKeyGenerated) {
    // 随机生成的 key 只在此处回显一次(供本地 curl 用);不落盘、不入日志文件。
    console.log(`  端点鉴权: 写=设备钥(随机 key,须带 x-api-key: ${app.apiKey});读=登录会话+归属`);
  } else {
    console.log('  端点鉴权: 写=设备钥(CUP_API_KEY,须带 x-api-key);读=登录会话+归属');
  }
  console.log(
    `  主动开口: ${args.proactive ? `开(照看 ${args.cups.join(', ') || '无 —— 加 --cup <id>'})` : '关(--proactive 开启)'}`,
  );
  console.log(`  可信绑定: ${args.requireClaim ? '开(默认;绑定须设备一次性 claim code)' : '关(CUP_REQUIRE_CLAIM=0|false 显式关闭,仅本地开发)'}`);
  console.log(`  人格市场: ${args.marketOpen ? '开(CUP_MARKET_OPEN=1|true)' : '关(默认;CUP_MARKET_OPEN=1|true 开启;关时货架空、投稿 503,前端显示「暂未开放」)'}`);
  if (pgUrl) {
    const opt = retentionOptions();
    const onBoot = process.env.CUP_RETENTION === '1' || process.env.CUP_RETENTION === 'true';
    console.log(
      `  保留策略: 遥测 ${opt.telemetryDays} 天 / 事件 ${opt.eventsDays} 天 / 服务日志 ${opt.serverLogsDays} 天(${onBoot ? '启动时清;' : ''}--retain 可手动清过期月分区)`,
    );
  }
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
