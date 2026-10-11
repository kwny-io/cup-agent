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

**实时**:`ws://localhost:8788/cups/<cup_id>/live` —— 新帧 / 主动搭话(`{kind:'proactive'}`)推给订阅者。

## 写端点鉴权(R10-B)

`PUT /goal`、`POST /config`、`POST /ask`、`POST /ingest` **默认强制** `x-api-key`。读端点默认开放。

- `CUP_API_KEY=<key>` 指定 key;不设则启动时**随机生成并打到启动横幅**(仅回显一次,不落盘)。
- `--allow-unauth` 显式豁免(仅本地开发,生产勿用)。
- `--read-auth` 把读端点也纳入鉴权(完整读鉴权需账号体系,此层为可选)。

## 命令行参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--port` | `8788` | API 端口 |
| `--sim` | 关 | 连模拟器 WS(`ws://host:port`) |
| `--mqtt` | `$CUP_MQTT_URL` | 连真机 broker(`mqtt://…`) |
| `--cup` | 空 | 要照看的杯子 id(可重复;`--proactive` 用) |
| `--proactive` | 关 | 开主动开口 + 画像蒸馏巡检 |
| `--profile-min-turns` | 8 | 自上次蒸馏后新增多少轮才再蒸一次 |
| `--allow-unauth` | 关 | 豁免写端点鉴权(本地开发) |
| `--read-auth` | 关 | 读端点也要 key |
| `--tz` | `$CUP_TZ` | 日界时区(IANA,如 `Asia/Shanghai`);缺省用服务器本地时区 |
| `--quiet` | 关 | 不打启动日志 |

### 环境变量

| 变量 | 用途 |
|---|---|
| `CUP_LLM_URL` / `CUP_LLM_KEY` / `CUP_LLM_MODEL` | 战报语气润色(缺则恒用模板,数字仍真实) |
| `CUP_CHAT_KEY` / `CUP_CHAT_MODEL` / `CUP_CHAT_URL` | 对话 agent(Claude Messages API;缺则回退确定性模板句) |
| `CUP_MQTT_URL` / `CUP_MQTT_CLIENT_ID` | 真机 MQTT(多实例部署 client id 必须各不相同) |
| `CUP_API_KEY` | 写端点鉴权 key |
| `CUP_DATA_DIR` | 数据目录(目标 + 对话轮持久化);缺省 `./.data` |
| `CUP_TZ` | 日界时区 |

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

## 目录地图

```
src/api/        HTTP 路由 + WS LiveHub
src/core/       纯逻辑:管线 / 融合 / 去重 / 日界 / 战报 / 性格 / 主动 / 对话 agent
src/core/chat/  对话子系统:prompt、tools、anthropic 客户端、记忆、画像蒸馏、guard
src/ingest/     上游适配层:sim(WS)/ mqtt / http
src/store/      事件 + 聚合 + 目标存储
src/cli.ts      入口
src/app.ts      组装(Store + Pipeline + LiveHub + API + 适配器)
src/dev-broker-cli.ts  本地开发用 broker(三进程端到端联调用)
```

## 测试

```bash
npm test                                          # 根:契约 + 模拟器 + 后端
node --test --test-reporter=spec "apps/server/test/*.test.ts"   # 只跑后端
```

覆盖:管线融合、日界时区、战报、性格史、对话(HTTP / 画像蒸馏 / guard)、主动开口、
MQTT 适配(含真 broker)、HTTP 中转、API 鉴权与错误、持久化、端到端验收。
