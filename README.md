# cup-agent

[![CI](https://github.com/kwny-io/cup-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/kwny-io/cup-agent/actions/workflows/ci.yml)

智能水杯的**软件侧**。硬件(杯盖 + 底座)另线推进,软件先用模拟器顶替。

```
packages/contract   四方共享的数据契约 —— 唯一真相源(zod schema + TS 类型)
apps/simulator      假杯子:假杯盖 + 假底座 + 行为脚本 + 时间加速(见 apps/simulator/README.md)
apps/server         后端:ingest 适配层 → 事件管线(双源融合)→ Store → REST/WS(见 apps/server/README.md)
apps/web            前端:卡通杯 + 数据看板 + 对话(见 apps/web/README.md)
```

上线:后端有 `Dockerfile` + `docker-compose.yml`,`docker compose up -d --build` 即起;
环境变量、TLS、密钥与暴露面见 [DEPLOY.md](DEPLOY.md)。

## 快速开始

```bash
npm install
npm test          # 314 个测试:契约 + 模拟器行为/手动控制 + 后端管线/验收/性格层/对话/画像蒸馏/MQTT/HTTP 中转/API/日界时区/记忆卡+recall/可信绑定(http 层含 PG 契约,无库自动 skip)
npm run typecheck # 类型检查(根 tsc + apps/web)—— CI 三闸之一
npm --workspace @cup/web test   # 前端 168 个测试:纯逻辑单测 + 组件级测试(jsdom 真挂载)
npm run sim       # 跑典型一天(默认 60× 加速)
npm run server    # 起后端 API(:8788)
```

**前后端联调**(两个终端):

```bash
node apps/simulator/src/cli.ts --ws 8787 --report-ms 10000   # 终端 1:模拟器流数据
node apps/server/src/cli.ts --sim ws://localhost:8787         # 终端 2:后端收 + 出 API
curl http://localhost:8788/cups/cup-A1B2C3/today             # 拉今日概览
```

**前端接后端**(第三个终端,`apps/web`):

```bash
npm run dev --workspace @cup/web
```

浏览器打开 `http://localhost:5173/?cloud=1` —— 前端连**后端**(而非直连模拟器),
看板的"今日已喝 / 次数 / 连续天数"用后端日聚合,杯子动画用后端推送的遥测。

> **写端点鉴权(R10-B)**:后端写端点(`PUT /goal`、`POST /config`、`POST /ask`)默认强制
> `x-api-key`。前端云模式可用 `?cloud=1&key=<key>` 把该头附到写请求上;不带 `key` 时不发该头
> (读正常、写会 401)。**本地开发给后端加 `--allow-unauth`** 即免 key;R10-B 只挡写、不挡读。

常用命令:

```bash
node apps/simulator/src/cli.ts --scale 86400            # 1 秒 = 1 天
node apps/simulator/src/cli.ts --scenario smoke         # 简短冒烟
node apps/simulator/src/cli.ts --days 3                 # 连续 3 天
node apps/simulator/src/cli.ts --ws 8787                # 起 WebSocket,供前端订阅
node apps/simulator/src/cli.ts --report-ms 10000        # 上报间隔改为 10 秒(演示用)
node apps/simulator/src/cli.ts --quiet                  # 只输出事件
```

**手动触发**(`--ws` 后,向控制通道发 JSON,不必等脚本轮到那一刻):

```bash
node apps/simulator/src/cli.ts --ws 8787               # 起 WS

# 另一终端(需 ws 客户端;演示可临时用 node 一行):
#   {"type":"drink","ml":60}                    喝一口
#   {"type":"shake","duration_ms":1500}         摇杯
#   {"type":"hot_water","target_ml":300,"pour_c":85}  倒热水(触发过热)
#   {"type":"tilt","deg":50,"dir":90} / {"type":"idle"}  倾倒 / 回正
#   {"type":"lift"} / {"type":"put_down"}       拿起 / 放下
#   {"type":"pause"} / {"type":"resume"}        暂停 / 恢复脚本
```

## 设计要点

- **契约先行**:`packages/contract` 是字段定义的唯一来源。改字段 → 前后端编译期就报错,不靠人记。
- **无需构建**:Node 24 原生跑 TypeScript,不引入打包工具。`node x.ts` 直接运行。
- **模拟器即真机替身**:模拟器走完全相同的契约,后端/前端不该分得出来。以后真硬件上线,只是换一个数据源。
- **事件检测与上报分离**:事件持续检测、入队,随上报捎带发出;安全类事件(过热/倾倒)即时上报。
- **时间加速不影响行为分辨率**:步长按虚拟时间定,加速只改变"跑多快",不改变结果。

## 后端做了什么(M1)

- **ingest 适配层**:`sim-adapter` 连模拟器 WS,逐条做契约校验,拒收脏数据并记日志。
  换链路(真机 MQTT)只加 adapter,下游不动 —— 这就是原则 P1。
  第三个适配器 **`http-adapter`** 走写端点 `POST /cups/:id/ingest`:一次 POST 一坨帧
  (真机弱网补传 / 网关中转用),归一 `{frame}` / `{frames:[...]}` / 裸数组,逐帧过同一套
  契约 §2 再灌进**同一条**管线(校验挡在最前,脏数据不进 Store)。
- **双源融合**(D2 核心,非可选):底座称重**精确但失明**,杯盖 ToF **在线但粗糙**。
  底座在座时做锚(conf 0.98),杯子被拿起时退到杯盖并用**偏置追踪**回锚。
  契约的 `derived_by` / `confidence` 字段就是为这层留的。
- **Store**:接口 + 内存实现。P4 —— 等真有"重启不丢 / 多设备"的理由再上 Postgres,
  换实现不动上层。
- **API**:REST(`/cups/:id/today` `/series` `/events` `/state` `/goal` `/config`)+
  WS `/cups/:id/live` 实时推送。`node:http` 裸写,不引框架。

## 前端怎么用后端

前端 `apps/web/src/data/cloud.ts` 的 **CloudSource** 实现同一套 `DataSource` 接口
(见 `source.ts`),所以换源**不改任何组件**。它连后端时是**混合**的:

- **WS** `/cups/:id/live` 推 `telemetry`(带原始 lid/base)→ 还原成 `LiveFrame` 喂杯子;
- **REST** `/today`、`/events` 补跨天聚合(今日量 / 连续天数 WS 给不了)。

有后端时看板用后端的官方数字,没有时自动回退到前端现算(`lib/stats.ts`)。
浏览器参数:`?cloud=1` 连默认后端 · `?cloud=http://host:port` 指定 · `?ws=` 直连模拟器 · `?mock=1` 纯本地。

## 契约

完整说明见桌面文档《contract.md》。代码侧对应 `packages/contract/src/`:

- `constants.ts` — 杯体几何、判定阈值、换算关系(契约 §6)
- `schemas.ts` — 四种报文(杯盖/底座遥测、事件、指令)的 zod schema(契约 §2–§5)

## 里程碑

见桌面文档《plan.md》。当前完成 **M0**(契约冻结 + 模拟器)、**M1**(后端骨架)、
**M2**(前端外壳 + 看板,已接后端)、**M3**(卡通杯 + 水波物理,英雄功能成型)、
**M4**(性格层 LLM + 战报)、**M5-对话**(软件线:问杯子 / 记忆 / 主动开口)。
**M5 真机 bring-up**(杯盖固件 `firmware/lid/`,源码就绪、宿主单测 20 组 536 条全绿,**待真板编译烧录**)
与 **M6 底座**属硬件线,按契约并行推进。

## 贡献

改代码前读 [CONTRIBUTING.md](CONTRIBUTING.md):目录分工、三道门禁(与 CI 一致)、固件的「纯 C 可测 / IDF 薄壳」分法、依赖与许可证约定。

## License

[Apache License 2.0](LICENSE) © 2026 kwny-io. 详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
