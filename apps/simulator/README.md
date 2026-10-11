# @cup/simulator —— 假杯子

**硬件到货前,用软件顶替杯盖 + 底座**。它跑一份行为脚本(典型一天),产出与真机**同一份契约**(`@cup/contract` 的 `UpstreamFrame` / `CupEvent`)的帧,于是后端/前端不必等真板就能全链路开发。

三条出口,对应三种消费方式:

| 出口 | 命令 | 给谁用 |
|---|---|---|
| 直接推进 | `npm run sim` | 本地看行为(打印每步 / 事件) |
| WebSocket | `--ws 8787` | 后端 `--sim ws://…` 或前端直连 |
| MQTT | `--mqtt mqtt://…` | 后端 `--mqtt`,走**真机同款设备协议** |

时间可加速(默认 60×,`--scale 86400` 即 1 秒 = 1 天),故"跑一天"是秒级的。

## 快速开始

```bash
npm run sim                                          # 典型一天(60×)
node apps/simulator/src/cli.ts --scale 86400         # 1 秒跑完一天
node apps/simulator/src/cli.ts --scenario smoke      # 简短冒烟
node apps/simulator/src/cli.ts --days 3              # 连跑 3 天
node apps/simulator/src/cli.ts --ws 8787             # 同时起 WS 服务
node apps/simulator/src/cli.ts --mqtt mqtt://localhost:1883   # 经外部 broker 发
node apps/simulator/src/cli.ts --quiet               # 只看事件
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

## 手动触发(WS 控制通道)

起 `--ws` 后,向控制通道发 JSON,不必等脚本轮到那一刻:

```json
{"type":"drink","ml":60}
{"type":"refill","targetMl":300,"pourC":25}          倒水回杯(常温)
{"type":"hot_water","targetMl":300,"pourC":85}       倒热水(触发过热)
{"type":"shake","durationMs":1500}                   摇杯
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
  engine.ts     时间步进 + 帧产出(step / drinkStep / shakeStep / hotWaterStep …)
  world.ts      杯子状态(液位 / 水温 / 底座称重)
  clock.ts      虚拟时钟(VirtualClock / dayStartMs),驱动加速
  scheduler.ts  脚本调度
  control.ts    手动控制指令(parseControl / applyControl)
src/sensors/  假传感器
  lid.ts        杯盖:IMU / ToF 液位 / 温度
  base.ts       底座:称重(ΔW 判 drink/refill)
src/ws/       WebSocket 出口(toFrames:帧 → 契约 UpstreamFrame[])
src/mqtt/     MQTT 出口(设备协议)
src/scenarios/day.ts   行为脚本(typicalDay / smoke)
src/util/rng.ts        可复现随机(createRng / gaussian)
```

## 测试

```bash
npm test                                          # 根:契约 + 模拟器 + 后端
node --test --test-reporter=spec "apps/simulator/test/*.test.ts"   # 只跑模拟器
```

`test/behavior.test.ts`(行为)、`contract.test.ts`(帧过契约)、`control.test.ts`(手动控制钳制/拒绝)、`mqtt-output.test.ts`(MQTT 出口形状 + 真 broker)。
