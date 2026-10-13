# @cup/simulator —— 假杯子

**硬件到货前,用软件顶替杯盖 + 底座**。它跑一份行为脚本(典型一天),产出与真机**同一份契约**(`@cup/contract` 的 `UpstreamFrame` / `CupEvent`)的帧,于是后端/前端不必等真板就能全链路开发。

三条出口,对应三种消费方式:

| 出口 | 命令 | 给谁用 |
|---|---|---|
| 直接推进 | `npm run sim` | 本地看行为(打印每步 / 事件) |
| WebSocket | `--ws 8787` | 后端 `--sim ws://…` 或前端直连 |
| MQTT | `--mqtt mqtt://…` | 后端 `--mqtt`,走**真机同款设备协议** |

时间可加速(默认 60×,`--scale 86400` 即 1 秒 = 1 天),故"跑一天"是秒级的。

> ⚠️ **重跑回填前必读(头一撞的坑)**:后端事件去重是**进程内**的(`seenEvents` Set,键 `device_id|ts|type`),
> 而 PG 的 `appendEvent` 是**纯 INSERT 无 ON CONFLICT**;日聚合又是**加法**的。于是——
> **同一服务生命周期内重跑 `--backfill` 会被去重(无害);但重启后端后再跑会叠加,把 drank_ml/连击灌成假的**。
> 要重置:删杯 / 换 `cup_id` / 清库,三选一。见下方「多日回填」。

## 快速开始

```bash
npm run sim                                          # 典型一天(60×)
node apps/simulator/src/cli.ts --scale 86400         # 1 秒跑完一天
node apps/simulator/src/cli.ts --scenario smoke      # 简短冒烟
node apps/simulator/src/cli.ts --days 3              # 连跑 3 天
node apps/simulator/src/cli.ts --ws 8787             # 同时起 WS 服务
node apps/simulator/src/cli.ts --mqtt mqtt://localhost:1883   # 经外部 broker 发
node apps/simulator/src/cli.ts --quiet               # 只看事件
node apps/simulator/src/cli.ts --backfill 90         # 向后端回填 90 天历史(成长/连击)
```

## 命令行参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--scale` | `60` | 时间加速倍率(86400 = 1 秒一天) |
| `--scenario` | `day` | `day`(典型一天)/ `smoke`(冒烟) |
| `--days` | `1` | 连续跑几天 |
| `--ws` | 关 | 起 WebSocket 服务,端口自定(如 8787) |
| `--mqtt` | 关 | 经外部 broker 上报(设备协议) |
| `--seed` | `42` | 随机种子(可复现同一份行为) |
| `--start` | 脚本内定 | 起始墙钟(`HH:MM`) |
| `--report-ms` | `300000` | 上报间隔(模拟端侧节奏) |
| `--quiet` | 关 | 只输出事件,不打每步日志 |
| `--backfill` | 关 | **回填模式**:生成 N 天历史事件并 POST 到后端 `/cups/:id/ingest`(给成长/连击铺底) |
| `--target` | `goal` | 回填档位:`goal`(每天达标+隔天续杯)/ `sparse`(只铺时间跨度) |
| `--server` | `http://localhost:8788` | 回填目标后端(亦可 env `CUP_SERVER`) |
| `--api-key` | env `CUP_API_KEY` | 回填用的写端点设备钥(后端开了鉴权则必给) |

## 多日回填(给成长/连击铺底)

杯子的养成闭环(成长阶段、里程碑、连续达标)全靠 `daily_agg` 日聚合,而聚合要**真喝过才有数**。
`--backfill` 就是**离线补历史**的正式出口:生成 N 天 `drink`/`refill` 事件(ts 回填到过去),
按**旧→新**逐天 POST 到后端既有的 ingest 端点 —— 不碰 store、不改契约、后端一行不动。

```bash
# 后端先起(--allow-unauth 省去设备钥)
node apps/server/src/cli.ts --allow-unauth
# 90 天"每天达标"档 → 连击/累计达标/续杯 全阶梯解锁
node apps/simulator/src/cli.ts --backfill 90 --target goal
# 20 天"稀疏"档 → 只撑时间跨度(阶段升),连击/续杯基本不动
node apps/simulator/src/cli.ts --backfill 20 --target sparse
curl localhost:8788/cups/cup-A1B2C3/growth   # 看结果
```

- **只造事件,不造遥测**:成长/连击/续杯全部由事件驱动(`drank_ml`/`refill_ml`/`event_count`),
  合成 drink/refill 足矣;伪造温度/液位是假数据,不做。
- **固定 seed → 同输入同输出**;`--target` 选档见上。
- ⚠️ 重跑前先看**文首那条**警告:重启后端后重跑会叠加(日聚合累加)。要重置请删杯 / 换 cup_id / 清库。

## 手动触发(WS 控制通道)

起 `--ws` 后,向控制通道发 JSON,不必等脚本轮到那一刻:

```json
{"type":"drink","ml":60}
{"type":"refill","target_ml":300,"pour_c":25}       倒水回杯(常温)
{"type":"hot_water","target_ml":300,"pour_c":85}    倒热水(触发过热)
{"type":"shake","duration_ms":1500}                摇杯
{"type":"press","duration_ms":150}                  按压盖顶(→ tap/long_press 手势)
{"type":"tilt","deg":50,"dir":90} / {"type":"idle"}  倾倒 / 回正
{"type":"lift"} / {"type":"put_down"}                拿起 / 放下
{"type":"set_temp","c":70}                           直接设水温
{"type":"pause"} / {"type":"resume"}                 暂停 / 恢复脚本
```

解析与生效在 `src/core/control.ts`(`parseControl` / `applyControl`):**数值越界被钳制**(如 `ml` 钳到 `[1, capacity_ml]`)、合法域外**一律拒绝而不抛**,`pause`/`resume` 回传 `loop` 信号供主循环消费。手动控制落地走 **S1**(本窗口)。

## MQTT 出口(设备协议)

`--mqtt` 让模拟器伪装成**真设备**,直接对上后端的 `mqtt-adapter`:

- 上行 `dev/<device_id>/up` —— 与后端 `UPLINK_TOPIC`(`dev/+/up`)对齐;
- 下行 `dev/<device_id>/down` —— 与后端 `downTopic` 逐字一致;
- 连上先订下行 + 发 `{"kind":"hello"}` 握手(与真固件同一动作);
- 上报 QoS1,`retain:false`。

topic 名在 `src/mqtt/server.ts`(`upTopic` / `downTopic`)。**运行时源码里的第二处 `import 'mqtt'`**(第一处是后端 `mqtt-node-transport.ts`;另有两处测试文件),两处都是可替换的薄壳 —— 换链路不动上层。

> 三进程端到端联调:broker(`apps/server/src/dev-broker-cli.ts`)+ 模拟器 `--mqtt` + 后端 `--mqtt`,上行与捎回双向闭环。

## 目录地图

```
src/core/     引擎与虚拟世界
  engine.ts     时间步进 + 帧产出(step / drinkStep / shakeStep / gestureStep / hotWaterStep …)
  world.ts      杯子状态(液位 / 水温 / 底座称重 / 盖顶压力)
  clock.ts      虚拟时钟(VirtualClock / dayStartMs),驱动加速
  scheduler.ts  脚本调度
  control.ts    手动控制指令(parseControl / applyControl)
src/sensors/  假传感器
  lid.ts        杯盖:IMU / ToF 液位 / 温度
  base.ts       底座:称重(ΔW 判 drink/refill)
src/ws/       WebSocket 出口(toFrames:帧 → 契约 UpstreamFrame[])
src/mqtt/     MQTT 出口(设备协议)
src/scenarios/day.ts   行为脚本(typicalDay / smoke)
src/scenarios/backfill.ts  多日历史回填(buildBackfill / runBackfill,给成长/连击铺底)
src/util/rng.ts        可复现随机(createRng / gaussian)
src/util/claim.ts      设备一次性绑定码(generateClaim / buildHello,可信绑定设备半)
```

## 测试

```bash
npm test                                          # 根:契约 + 模拟器 + 后端
node --test --test-reporter=spec "apps/simulator/test/*.test.ts"   # 只跑模拟器
```

`test/behavior.test.ts`(行为)、`contract.test.ts`(帧过契约)、`control.test.ts`(手动控制钳制/拒绝)、`mqtt-output.test.ts`(MQTT 出口形状 + 真 broker)、`claim.test.ts`(一次性绑定码形状与确定性)、`backfill.test.ts`(多日回填:可复现/旧→新/契约合规/两档)。
