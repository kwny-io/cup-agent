# 窗口 B 交接 —— 模拟器 MQTT 输出(驱动「三进程端到端联调」)

> ✅ **已完成(2026-10-10)—— 勿重做。** 窗口 B 的 M1–M4 全部落地并经窗口 A 核实:
> `apps/simulator/src/mqtt/server.ts` + `--mqtt` CLI + `test/mqtt-output.test.ts`(3 条);
> 根测试 119→122,双关全绿。三进程端到端联调(独立 broker + 模拟器当设备 + 独立后端)已跑通。
> 下方保留为**历史作业书**(记录分工与冻结接口),不再是待办。

> 这是**第二个窗口**的作业书。你看不到后端会话的上下文,所以需要的都写全。
> 上一份(`apps/web/CHAT-HANDOFF.md`)那条前端线已收口,勿回头。**本文件是当前唯一作业。**

## 背景(一句话)

到目前为止,模拟器**只有一个出口:WebSocket**(`src/ws/server.ts`)。MQTT 链路虽然后端已实现
(`apps/server/src/ingest/mqtt-adapter.ts`,ADR T17)且**在进程内验证过**(`apps/server/test/mqtt-broker.test.ts`
起真 aedes broker),但**"模拟器当成一台真设备、通过外部 broker、把数据发给独立进程的后端"从没跑过**。

这次就是补这一环:**给模拟器加一个 MQTT 出口**,让

```
模拟器(设备) ──MQTT──> 独立 broker ──MQTT──> 独立后端进程 ──> REST/WS
```

三个**真正独立的进程**能端到端跑通。

## 你的边界(硬性 —— 本工作区不是 git 仓库,靠目录不重叠分工)

- 你**只改** `apps/simulator/**`(含 `apps/simulator/package.json`)。**这是你唯一的地盘。**
- **不要碰** `apps/server/**`(后端线在改:A 会新建 `apps/server/src/dev-broker-cli.ts`,那个独立 broker 进程归 A)。
- **不要碰** `packages/contract/**`(设备协议,两窗口都不碰)。
- **不要碰**根 `package.json` / `tsconfig.json`(共享文件)。

> 上一条前端线(`apps/web/**`)已由你完成并核实,**别再动 `apps/web`**。

## 冻结接口(双方不得单方改)

### topic 方案(与后端 `mqtt-adapter.ts` 逐字对齐,不得改)

| 方向 | topic | 说明 |
|------|-------|------|
| 上行(设备→后端) | `dev/<device_id>/up` | 后端订阅 `dev/+/up` |
| 下行(后端→设备) | `dev/<device_id>/down` | 设备订阅自己的 |

- 键 = **`device_id`**(不是 `cup_id`)。本项目固定三个 id:`cup-A1B2C3` / `lid-A1B2C3` / `base-A1B2C3`。
  **上行 topic 里的 id 必须等于报文 `payload.device_id`** —— 后端会校验,**不符即拒收**(防固件发错 topic)。
- `device_id` 形如 `/^(lid|base)-[A-Z0-9]+$/`。
- QoS **1**,retain **false**。

### 出口 seam(与现有 WS 出口同形 —— 这是能插进 `engine` 的关键)

`apps/simulator/src/core/engine.ts:149` 已有:

```ts
wireWs(ws: { broadcast: (f: Frame) => void } | null): void
```

**它只认 `broadcast` 这一个方法**(结构化类型,不认类名)。所以你新写的 MQTT 出口**只要满足这个形状**,
就能原样 `engine.wireWs(mqttOut)` 接到同一根线上。**不要改 engine 的签名。**

### 你要产出的出口(建议形状,命名可微调但 `broadcast` 必须叫这个)

```ts
// apps/simulator/src/mqtt/server.ts(新)
export interface MqttOutput {
  broadcast: (f: Frame) => void;
  close: () => void;
}
export function startMqttOutput(opts: { url: string; log?: (m: string) => void }): MqttOutput;
```

## 要做的

### M1 · 加依赖

`apps/simulator/package.json` 的 `dependencies` 里加 `"mqtt": "^5.16.0"`(与 `apps/server` 同版本)。
`mqtt` **已经是本项目的运行时依赖之一**(第五个名字,ADR T17 已记账),**不是新依赖**。加完 `npm install`。

### M2 · MQTT 出口 `src/mqtt/server.ts`(新)

- 复用**已有的** `toFrames`(在 `src/ws/server.ts:58` **已导出**)把一帧 `Frame` 拆成契约信封数组。
  **不要重写这个函数** —— `toFrames` 里已经做了 `UpstreamFrameSchema.parse` 校验,出口数据合法性靠它。
- 用真 `mqtt` 客户端连 `opts.url`,clientId 例如 `sim-<lidId>`(`--mqtt` 只跑一个进程,id 唯一即可)。
- `broadcast(frame)`:
  - `toFrames(frame)` 得到一个 `UpstreamFrame[]`;
  - **每个信封单独一条 publish**(不要 `\n` 拼批 —— 一次一条才是真固件形状,且每个信封自带 `device_id`,
    便于按信封选 topic):取 `envelope.payload.device_id` → publish 到 `dev/<device_id>/up`,`{qos:1, retain:false}`;
  - 未连接时:丢弃或缓存(参考现有 WS 出口在 `clients.size===0` 时直接 return 的"无所谓"立场 ——
    模拟器是数据源,丢一帧不致命;**记一条 warn 日志**即可,别把进程搞崩)。
- 连上后:对 `lid-A1B2C3` / `base-A1B2C3` **各订阅** `dev/<id>/down`,收到 `Command[]` 就**打日志**
  (形如 `[mqtt] 收到下行 N 条: <types>`)。设备侧收到指令是联调的**可见证据**,不需要真的执行。
- 连上后**发一次握手**:publish `{"kind":"hello","v":1}` 到 `dev/<lidId>/up`,镜像 WS 出口的 hello
  (后端 `handleLine` 对 `kind:'hello'` 有 passthrough,**会在 schema 校验前放行**,不会因缺 `device_id` 被拒)。
- `close()`:`client.end(true)`。
- 事件日志:`connect` / `reconnect` / `error` / `close`,级别参考 `mqtt-node-transport.ts` 的写法
  (那个文件是**全项目唯一 `import 'mqtt'` 的运行时外壳** —— 你这里会是**第二处**,请在文件头注释里点明这个例外,
  并说明"理由同 T17:让 `mqtt` 依赖只在薄壳处落地,换 broker 只改薄壳")。

### M3 · CLI 接线 `src/cli.ts`

- 新增 `--mqtt URL` 参数(与现有 `--ws PORT` 对称)。
- 给了 `--mqtt` 就 `startMqttOutput({url, log})` 并 `engine.wireWs(mqttOut)`。**`--mqtt` 也必须走实时模式**
  (和 `--ws` 一样 —— 没有出口就没必要实时)。
- **`--ws` 与 `--mqtt` 同时给**是合理场景(前端看 WS、后端吃 MQTT):如顺手,加一个 3 行的 fan-out
  (`{ broadcast: f => { ws?.broadcast(f); mqtt?.broadcast(f); } }`);**做不动就退而求其次**:
  *两个都给我就报错退出*,别默默忽略一个。
- 补 `--help` 文本。

### M4 · 测试 `test/mqtt-output.test.ts`(新)

照 `apps/server/test/mqtt-broker.test.ts` 的手法(它已把"起真 aedes broker + 真 mqtt 客户端"的套路写完,
**读它,抄它的骨架**,别另起炉灶):

1. 起真 broker(`aedes` 是**根 devDependency**,`apps/simulator/test/` 里 `import { Aedes } from 'aedes'` 能解析到)。
2. `startMqttOutput({url})`,用 `engine` 或直接造一个 `Frame` 喂 `broadcast`。
3. 断言:broker 侧收到 `dev/<device_id>/up` 的消息,**topic 的 id == 报文的 `device_id`**,且报文能过
   `UpstreamFrameSchema`(可 `import { UpstreamFrameSchema } from '@cup/contract'` 再 parse 一次)。
4. 断言:`engine.wireWs(mqttOut)` 之后,`engine.step()` 产出的帧确实上了 broker(即**真的被 engine 接进去了**,
   不是只测了出口函数本身)。
5. 断言:向 `dev/<lidId>/down` 发一条 `Command[]`,出口**不崩**(收到了就行;日志可断言也可不断言)。
6. 真 server + `try/finally` 清理,与现有测试风格一致。

## 验收(你必须自己跑绿再报)

```bash
npm run typecheck
```

```bash
npm test
```

- 根 `npm test` 会跑 `apps/simulator/test/*.test.ts` + `apps/server/test/*.test.ts` —— **你的新测试要在里面全绿**,
  且**不得让既有的根测试(当前 119)变红**。
- **strip-only 关**:新类**一律显式字段声明**(`private readonly cfg: X;`),**不用 enum / namespace / 参数属性**。
  `tsc` 过不代表 Node 能 strip;`npm test`(真跑)是**必要第二道关**。

## 报告时请写清

- 新增/改动**文件清单**;
- 根测试**前后数字**(119 → ?);
- `--mqtt` 的**确切用法**(A 要拿它写进三进程联调命令);
- fan-out 做了还是选了"两个都给就报错";
- 任何你**改了冻结接口/绕路**的地方(**不许默默绕**,写出来)。

## ⚠️ 别做的事

- 别改 `engine.wireWs` 签名、别改 `toFrames`、别改 topic 方案 —— 这些是 A 侧和后端对齐的锚点。
- 别 `\n` 拼批上行。
- 别新增除 `mqtt` 外的依赖。
- 别碰 `apps/server/**`、`packages/contract/**`、根 `package.json`。

---

*窗口 A 会拿你的 `--mqtt` 驱三个真进程跑端到端(独立 broker `apps/server/src/dev-broker-cli.ts` ← A 写),
并同步桌面文档。*
