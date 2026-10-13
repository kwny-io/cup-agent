# @cup/server —— 后端

杯子数据的**汇聚与出口**:把进来的帧(模拟器 WS / 真机 MQTT / HTTP 中转)经一条事件管线
融合成"每日状态",再经 REST + WS 吐给前端。产品线的所有"后端算好的东西"——今日概览、
战报、性格画像、对话答复——都在这里产出。

不接 IO 的纯逻辑(`topology` 之外的一切)都在 `core/`,故可零网络单测;`ingest/` 是适配层,
每种上游一个文件,换链路不动上层。

## 快速开始

```bash
node apps/server/src/cli.ts                                   # 起 API(:8788),等模拟器
node apps/server/src/cli.ts --sim ws://localhost:8787          # 连模拟器的 WS,收数据
node apps/server/src/cli.ts --mqtt mqtt://localhost:1883       # 连真机 broker
node apps/server/src/cli.ts --port 9000                        # 换端口
```

**典型联调**(两个终端):

```bash
node apps/simulator/src/cli.ts --ws 8787 --report-ms 10000   # 终端 1:模拟器流数据
node apps/server/src/cli.ts --sim ws://localhost:8787        # 终端 2:后端收 + 出 API
curl http://localhost:8788/cups/cup-A1B2C3/today            # 拉今日概览
```

## HTTP API

路由集中在 `api/http.ts` 的 `route()`;一对 `<cup_id>/<action>`,读走 GET、写走 PUT/POST。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 存活 + 管线统计 + 当前 WS 订阅数 |
| GET | `/cups/:id/today` | 今日概览:已喝 / 目标 / 次数 / streak / 当前水位水温 / 近 8 条事件 |
| GET | `/cups/:id/series?range=day\|week` | 分桶时间序列(日 / 周) |
| GET | `/cups/:id/events?from=&to=` | 区间原始事件 |
| GET | `/cups/:id/state` | 最新采样(杯盖 + 底座遥测快照) |
| PUT | `/cups/:id/goal` | 改每日目标,体 `{ goal_ml }`(**写端点,要鉴权**) |
| POST | `/cups/:id/config` | 下发设备配置,体原样透传为 `config` payload(**写端点**) |
| POST | `/cups/:id/ask` | 对话问答,体 `{ q }` → `{ cup_id, answer }`(**写端点**) |
| POST | `/cups/:id/ingest` | HTTP 中转:外部把 `UpstreamFrame` POST 进来(S9)(**写端点**) |
| GET | `/cups/:id/report/latest` | 最新每日战报(LLM 或模板) |
| GET | `/cups/:id/report/history?days=N` | 历史战报逐日 |
| GET | `/cups/:id/personality/history?days=N` | 脾气变化史(养成卡只读半) |
| GET | `/cups/:id/memory?day=YYYY-MM-DD` | 某天的记忆卡(`recent=N` 取最近 N 天,≤30、缺省 7;`build=1` 按需补建) |

**实时**:`ws://localhost:8788/cups/<cup_id>/live` —— 新帧 / 主动搭话(`{kind:'proactive'}`)推给订阅者。

## 端点鉴权(R10-B / S4)

**两条轴,默认都强制:**

- **写端点**(`PUT /goal`、`POST /config`、`POST /ask`、`POST /ingest`、`PUT /profile`)→ **设备钥** `x-api-key`。
- **读端点**(`GET /today`、`/series`、`/events`、`/state`、`/report/latest`、`/report/history`、`/personality/history`、`/profile`、`/memory`)→ **账号会话 + 杯子归属**(S4):未登录 `401`;登录了但杯不归你 `403`。

`/healthz` 与 `OPTIONS` 预检**永远开放**。

- `CUP_API_KEY=<key>` 指定写钥;不设则启动时**随机生成并打到启动横幅**(仅回显一次,不落盘)。
- `--allow-unauth` **显式豁免读+写**(仅本地开发,生产勿用)。
- 旧 `--read-auth` 占位旗**已退役** —— 读侧改由账号会话 + 归属闸接管。

**角色体系**(`user` / `admin` / `ops` / `reviewer`):注册时按邮箱名单发一次角色
(`CUP_ADMIN_EMAIL` / `CUP_OPS_EMAILS` / `CUP_REVIEWER_EMAILS`,优先级 admin > ops > reviewer)。
用于日志回看:读口 admin/ops/reviewer 都能用,**触发保留清理只有 admin/ops**(reviewer 只读)。

## 服务日志回看(落库 + 文件出口)

进程内每请求那行结构化日志,**默认只打控制台,进程一挂就没了**。开持久化后同时落两处:

- **DB**:`server_logs` 表(PG 月分区,保留 90 天)—— 供产品内页面查。
- **文件**:按行 JSONL(`CUP_LOG_DIR/server-YYYY-MM-DD.log`,UTC 日轮转)—— 供 filebeat/fluentd 之类外部采集器 `tail`。

**写入时脱敏**:落库/落文件**之前**就抹掉敏感值(`Authorization`/`cookie`/`token`/`password`/`claim_code`… 整值替 `[REDACTED]`;`Bearer <t>`/`token=…` 抹值留名;邮箱掩码 `a***@b.com`)。
同步 sink **只解析入队、不做 I/O**(绝不阻塞热路径),异步循环每秒/按批刷写;管线的任何失败走**裸 stderr**(绝不过 logger,免得 DB 挂了递归自打)。

| 端点 | 角色 | 说明 |
|---|---|---|
| `GET /admin/logs` | admin/ops/reviewer | 查一页;`level`(可重复/逗号)/`src`/`q`(msg 字面子串)/`from`/`to`/`limit`(≤500)/`cursor`(keyset 翻页) |
| `GET /admin/logs/partitions` | admin/ops/reviewer | 各月分区名 + 占用字节(只读) |
| `POST /admin/logs/retain` | **admin/ops** | 跑一次保留清理,返回删掉的分区名(幂等;删分区不可逆) |

无会话 `401`;有会话但角色不够 `403`。无 PG 时读口回 `200` 空表(服务照常,不报错)。

## 命令行参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--port` | `8788` | API 端口 |
| `--sim` | 关 | 连模拟器 WS(`ws://host:port`) |
| `--mqtt` | `$CUP_MQTT_URL` | 连真机 broker(`mqtt://…`) |
| `--cup` | 空 | 要照看的杯子 id(可重复;`--proactive` 用) |
| `--proactive` | 关 | 开主动开口 + 画像蒸馏巡检 |
| `--profile-min-turns` | 8 | 自上次蒸馏后新增多少轮才再蒸一次 |
| `--allow-unauth` | 关 | 豁免读+写端点鉴权(本地开发) |
| `--tz` | `$CUP_TZ` | 日界时区(IANA,如 `Asia/Shanghai`);缺省用服务器本地时区 |
| `--migrate` | 关 | 跑迁移建表后即退(不启服务) |
| `--quiet` | 关 | 不打启动日志 |

### 环境变量

| 变量 | 用途 |
|---|---|
| `CUP_LLM_URL` / `CUP_LLM_KEY` / `CUP_LLM_MODEL` | 战报语气润色(缺则恒用模板,数字仍真实) |
| `CUP_CHAT_KEY` / `CUP_CHAT_MODEL` / `CUP_CHAT_URL` | 对话 agent(Claude Messages API;缺则回退确定性模板句) |
| `CUP_MQTT_URL` / `CUP_MQTT_CLIENT_ID` | 真机 MQTT(多实例部署 client id 必须各不相同) |
| `CUP_API_KEY` | 写端点鉴权 key |
| `CUP_DATA_DIR` | 数据目录(目标 + 对话轮持久化);缺省 `./.data` |
| `CUP_PG_URL` | Postgres 连接串;设了则启用 `PgStore` 四件套,缺省仍走内存 |
| `CUP_TZ` | 日界时区 |
| `CUP_LOG_DIR` | 服务日志 JSONL 文件出口目录;不设 = 不落文件(有 `CUP_PG_URL` 仍落库) |
| `CUP_SERVER_LOGS_RETAIN_DAYS` | DB 日志保留天数;缺省 `90` |
| `CUP_OPS_EMAILS` | ops 邮箱名单(逗号分隔);注册即得 ops 角色 |
| `CUP_REVIEWER_EMAILS` | reviewer 邮箱名单(逗号分隔);注册即得只读角色 |

## 数据怎么流(pipeline)

```
ingest/          ── 上游适配层,每种一个文件
  sim-adapter      模拟器 WebSocket
  mqtt-adapter     真机 MQTT(dev/<id>/up),含下行捎回
  http-adapter     HTTP 中转(外部 POST 进来)
        │  UpstreamFrame
        ▼
core/pipeline     双源融合(杯盖扣重 + 底座称重)→ CupEvent
core/dedupe        事件去重
core/fusion        盖/座两路样本融合成一份状态
core/day-boundary  日界(可配时区)→ 每日聚合
core/report        每日战报(数字 + 文案)
core/personality   性格画像(长期脾气底色)
core/proactive     主动开口调度
core/chat/*        对话 agent(prompt / tools / distill / memory)
        ▼
store/store        MemoryStore(接口稳定,可换实现)
        ▼
api/http + api/live ── REST + WS 出口
```

**上游上报的是半成品,融合与聚合都在后端** —— 真机与模拟器吐同一份契约,后端一行不改就能收
(见 `firmware/README.md` §三"联调验收")。

## 存储层:内存默认,Postgres 可选

`store/store.ts` 的 `Store`/`ChatStore`/`AccountsStore`/`ProfileStore` 四个接口**全 `Promise` 化**,
`MemoryStore` 是零基建默认(现有测试照跑);设 `CUP_PG_URL` 即整体切到 `PgStore` 四件套
(`store/pg/*`),上层一行不改 —— 这就是"只换实现,不动上层"的缝。

```bash
node apps/server/src/cli.ts --migrate            # 建表后即退(需 CUP_PG_URL)
CUP_PG_URL=postgres://… node apps/server/src/cli.ts   # 起服务,自动跑迁移
```

- **迁移**:手写编号 `.sql`(`store/pg/migrations/`),`migrate.ts` 用 `schema_migrations` 表逐个应用,
  每个迁移各在自己的事务里;**无 ORM**。
- **分区 + 保留策略**:`telemetry`/`events`/`server_logs` 按 `ts` 月分区(`ensurePartitions(now, ahead=2)`);
  保留期靠**删整月分区**(不逐行删,十万用户下遥测约 58M 行/天,逐行删跑不动)。`applyRetention`
  默认遥测 90 天、事件 395 天(约 13 个月)、**服务日志 90 天**,cutoff 所在月**保留**、当前月**永不删**、
  非 `YYYYMM` 形状的分区不碰。**删分区不可逆 → 绝不隐式跑**,须 `--retain` / `CUP_RETENTION=1` / `POST /admin/logs/retain`:
  ```bash
  node apps/server/src/cli.ts --retain             # 跑迁移 + 删过期月分区后即退(定时任务用)
  CUP_RETENTION=1 CUP_PG_URL=… node apps/server/src/cli.ts   # 服务启动时顺带清一次
  # CUP_TELEMETRY_RETAIN_DAYS / CUP_EVENTS_RETAIN_DAYS / CUP_SERVER_LOGS_RETAIN_DAYS 可调天数
  ```
- **隔离纪律**:Pg 契约测试用一次性 schema(`CREATE SCHEMA c<rand>` + 连接串 `options=-c search_path=…`),
  与内存侧的 `mkdtemp` 临时目录同款。

## 记忆卡 + `recall`

"每天的点滴"落成**记忆卡**(`memory_cards.details` jsonb):`drank_ml / goal_ml / reached / streak /
refill_count / temp_range / notable_events / body_cues / turns_summary`。

- **写入时机 = 天翻页**,并入 `ProactiveScheduler.tick` 的 `maybeCloseDay`:`dayKey(now)` 一变,就用
  昨天那份 `daily_agg` + `events` + 当天 `chat_turns` 拼卡 `UPSERT`。幂等(迟/重 tick 都安全),
  且**不占热路径**;既无事件又无对话的天**不建空卡**。按需补建走 `GET /cups/:id/memory?day=…&build=1`。
- **`recall` 工具**(`isWrite:false`):`{ day? , recent? }`(recent ≤ 30),读卡喂回 agent。卡里的数字
  经 `agent.ts` 既有的 `collectNumbers` **自动进数字护栏** —— 模型复述记忆里的数不算凭空。
- **与 `profile()` 的关系**:并存相加。`profile()` 是**始终注入**的滚动身份;`recall` 是**按需拉取**的
  情景细节(用户提"上周""那天…"时调)。

## 三档删除(「被遗忘权」面)

硬删、无墓碑。三档各删**恰好**对应集合(带越权闸:会话 `user_id` 须拥有该杯,否则 403):

| 端点 | scope | 删什么 | agent 忘记 |
|---|---|---|---|
| `DELETE /cups/:id/memory?scope=conversation` | conversation | `chat_turns` + 长期画像 | 「聊过什么」 |
| `DELETE /cups/:id/memory?scope=memory` | memory | `memory_cards` + `cup_traits` | 「那些日子」 |
| `DELETE /cups/:id/memory?scope=all` | all | 以上**并** telemetry/events/daily_agg/goal/最新样本 | 一切归零 |
| `DELETE /account` | — | 账号 + 名下各杯 `all` + 会话 | 注销 |

- `scope` 缺失/非法 → 400(不默认、不猜测,免得手滑删光)。两个端点**走会话闸 + 归属校验**
  (Bearer 会话),不走设备共享的 `x-api-key` —— 后者防不了「A 登录后删 B 的杯」。
- 多表删除收在一个事务里(`PgStore.forget` / `deleteAccount` 用 `withTransaction`),半删不可接受。
- `MemoryStore.forget` 是同一语义的内存实现(memory 档**只**删卡,不碰遥测 —— 曾被测试咬出过此 bug)。
- **硬前置**:`POST /social/cup` 的归属校验靠设备一次性 claim code(可信绑定,**默认开**;
  仅 `CUP_REQUIRE_CLAIM=0|false` 显式关闭,退回"自证绑定"、仅供本地开发)。

## 目录地图

```
src/api/        HTTP 路由 + WS LiveHub
src/core/       纯逻辑:管线 / 融合 / 去重 / 日界 / 战报 / 性格 / 主动 / 对话 agent
src/core/chat/  对话子系统:prompt、tools、anthropic 客户端、记忆、画像蒸馏、guard
src/ingest/     上游适配层:sim(WS)/ mqtt / http
src/store/      事件 + 聚合 + 目标存储(MemoryStore 默认)
src/store/pg/   Postgres 实现:pool / 四件套 store / migrate + migrations/*.sql
src/cli.ts      入口
src/app.ts      组装(Store + Pipeline + LiveHub + API + 适配器)
src/dev-broker-cli.ts  本地开发用 broker(三进程端到端联调用)
```

## 测试

```bash
npm test                                          # 根:契约 + 模拟器 + 后端
node --test --test-reporter=spec "apps/server/test/*.test.ts"   # 只跑后端
# Postgres 契约(同一组断言跑 Memory 与 Pg 两个实现;不设 URL 则 Pg 侧 skip):
CUP_PG_URL=postgres://… node --test apps/server/test/store-contract.test.ts
```

覆盖:管线融合、日界时区、战报、性格史、对话(HTTP / 画像蒸馏 / guard)、主动开口、
MQTT 适配(含真 broker)、HTTP 中转、API 鉴权与错误、持久化、记忆卡 + `recall`、端到端验收。
`store-contract.test.ts` 把同一组 store 断言同时喂给 `MemoryStore` 与 `PgStore`,证明"只换实现、语义不变"。
