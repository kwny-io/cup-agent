# 固件线(cup-agent firmware)

杯盖 / 底座固件的源码。**故意放在仓库顶层 `firmware/`**,不进 npm workspace
(根 `package.json` 只 glob `apps/*` 与 `packages/*`)—— 于是固件与软件线目录**零重叠**,
不碰根 `package.json` / 根 `tsconfig` / `packages/contract`。

当前进度:

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M5 · 杯盖最小 bring-up | `lid/` —— 真盖子数据"后端一行不改就能收" | 源码就绪,待真板编译烧录 |
| M6 · 底座 | `base/` —— 称重底座,drink/refill/off_base 端侧判定 + 温漂补偿 | 源码就绪,待真板编译烧录 |
| M7 · 下行指令真执行 | `config` 改上报间隔(落 NVS 续存)/ `sync_time` 对时 / `remind` 记日志 | 源码就绪,待真板编译烧录 |
| M10 · remind 点灯 | `remind.led` 名 → 灯效(亮/闪/呼吸)→ 板载 LEDC 驱动输出 | 源码就绪,待真板编译烧录 |
| M8 · 端侧信号质量 + 配网 | ToF 液位滤波 / 实时档(40Hz IMU)决策 / 断网上行缓存 / BLE 配网 | 源码就绪,待真板编译烧录 |
| M11 · 可信绑定(设备端半) | 一次性 claim code:NVS 出码(Crockford Base32,24h 时效,用过即废) | 源码就绪,待真板编译烧录;服务端校验归窗口 A |

盖与底座**共用** `components/cup_common/`(契约层、下行解析、Wi-Fi、MQTT)—— 设备无关的东西
只此一份,避免两边契约漂移。

---

## 目录

```
firmware/
├── components/cup_common/        ← 盖与底座共用(设备无关)
│   ├── Kconfig.projbuild         menuconfig:Wi-Fi / broker / 设备身份 / 上报节奏
│   ├── contract_dev.{h,c}        契约对齐层:手写 JSON,字段名逐字对齐 schemas.ts
│   │                              (含 SCALE 常量镜像、lid/base 两种遥测信封、事件信封)
│   ├── command_parse.{h,c}       下行指令解析:target 过滤 / 过期 / cmd_id 去重(纯 C)
│   ├── cmd_payload.{h,c}         按 cmd_id 定位后取 payload 字段(i64/str,纯 C)
│   ├── cmd_exec.{h,c}            下行生效值裁定:report_ms 夹紧(纯 C)
│   ├── cmd_store.{h,c}           config 持久化:NVS 存/取 report_ms(ESP-IDF)
│   ├── uplink_buffer.{h,c}       上行缓存:断网暂存有界 FIFO,连上后补发(纯 C)
│   ├── led_pattern.{h,c}         remind 灯效决策:led 名 → 效果序列(纯 C)
│   ├── led_driver.{h,c}          板载 LED 驱动:LEDC/PWM,亮/灭/闪/呼吸(ESP-IDF)
│   ├── ota_manifest.{h,c}        ota manifest 解析与校验:url/sha256/size(纯 C;下载归 IDF 半)
│   ├── claim_code.{h,c}          设备绑定码:Crockford Base32 生成/规范化/常量时间比对/时效(纯 C)
│   ├── claim_store.{h,c}         绑定码持久化:NVS 存/取 + "已用"标志,一次性(ESP-IDF)
│   ├── eye_state.{h,c}           硬件脸眼睛状态机:十二态词汇表 + 交接闭眼 + 水烫叠加(纯 C)
│   ├── eye_render.{h,c}          硬件脸点阵渲染:128×128 单色 + 1bpp 打包 + 脏行/脏段(纯 C)
│   ├── wifi_sta.{h,c}            Wi-Fi STA + wifi_bringup() 联网上线总入口(ESP-IDF)
│   ├── prov.{h,c}                BLE 配网(wifi_prov_mgr 薄壳,首次拿 Wi-Fi 凭据)
│   └── mqtt_uplink.{h,c}         esp-mqtt 上行/下行(ESP-IDF)
│
├── lid/                          杯盖(M5)
│   ├── CMakeLists.txt            ESP-IDF 工程定义(project = cup_lid)
│   ├── sdkconfig.defaults        ESP32-S3 / 4MB flash 默认配置
│   ├── main/
│   │   ├── CMakeLists.txt        组件源清单 + 依赖(REQUIRES cup_common)
│   │   ├── lid_logic.{h,c}       端侧判定:shake/tilt/lifted/温度/电量 阈值与滞回(纯 C)
│   │   ├── level_filter.{h,c}    ToF 液位 α-β 滤波:晃动时重平滑,静止跟得住(纯 C)
│   │   ├── realtime.{h,c}        实时档决策:晃动/App 请求 → 40Hz 带 IMU,窗过回落(纯 C)
│   │   ├── sensor_source.{h,c}   传感源:默认合成源(纯 C),真驱动按需接
│   │   ├── sensor_convert.{h,c}  传感器换算:芯片字节 → 物理量(BMI160/DS18B20/VL53L0X/INA219,纯 C)
│   │   ├── face_display.{h,c}     硬件脸显示薄壳:眼睛点阵按**脏行**推 Memory LCD(局部刷新省电;IDF 壳)
│   │   └── lid_main.c            app_main + 主循环 + 脸任务(ESP-IDF)
│   └── host_test/                宿主单测(PC 上跑,不需要 ESP-IDF)
│       ├── test_*.c              (含 cup_common 纯 C 层的测试:cmd_payload/cmd_exec/led_pattern 等)
│       └── run_all.sh            总入口(从 firmware/ 根编译,覆盖盖 + 底座的所有纯 C 层)
│
└── base/                         底座(M6)
    ├── CMakeLists.txt            ESP-IDF 工程定义(project = cup_base)
    ├── sdkconfig.defaults        ESP32-S3 + device_id 覆盖为 base- 前缀
    ├── main/
    │   ├── CMakeLists.txt        REQUIRES cup_common
    │   ├── base_weight.{h,c}     端侧称重判定:OFF/SETTLING/RESTING 状态机(纯 C)
    │   ├── weight_comp.{h,c}     称重温漂补偿:自标定两点法(纯 C)
    │   ├── weight_source.{h,c}   称重源:默认合成源(纯 C,带温漂 + 空座场景),真驱动按需接
    │   ├── weight_convert.{h,c}  称重换算:HX711 24 位计数 → 克(纯 C)
    │   └── base_main.c           app_main + 主循环(ESP-IDF)
    └── host_test/
        ├── test_base_weight.c
        ├── test_weight_comp.c
        ├── test_weight_source.c
        ├── test_weight_convert.c
        ├── test_chain.c         整链:单元 → 温补 → 判定 → 量值误差(M6 验收 #1)
        └── run_all.sh → 复用 ../lid/host_test/run_all.sh
```

> 下行指令执行的宿主单测(`test_cmd_payload.c` / `test_cmd_exec.c` / `test_led_pattern.c` / `test_ota_manifest.c`)在 `lid/host_test/`
> —— 它们测的是 `cup_common/` 里的纯 C 模块,盖与底座共用同一份,故不重复。`lid/host_test/`
> 的 `run_all.sh` 是**整条固件线**的唯一入口,一次编译覆盖 `cup_common` + `lid` + `base`。

**分层的意义**:判定与契约这两层是纯 C、零 IDF 依赖,既能在 PC 上跑单测,
又能原样搬上真板 —— 真板上跑的与单测里跑的**是同一份 `.c`**。

---

## 一、宿主单测(不需要 ESP-IDF / 不需要真板)

固件里最容易错、最难查的两类东西 —— **契约字段名/数值区间**、**下行指令的过滤与去重** ——
全被抽进了零依赖的纯 C 层。于是提交前就能在 PC 上跑一遍:

```bash
CC=/c/mingw64/mingw64/bin/gcc.exe bash lid/host_test/run_all.sh
```

(Linux/macOS 或已把 gcc 放进 PATH:直接 `bash lid/host_test/run_all.sh`。)

当前**二十组、共 548 条**断言全绿:

- `contract_dev` 71 条 —— 枚举字符串逐字(含手势 `tap`/`long_press`)、换算对齐 `constants.ts`、盖/底座两种信封字段、
  `ts` 13 位不回绕、`amount_ml` 仅 drink/refill、`duration_ms` 仅 tap/long_press、**base 无 imu/rssi 字段**、缓冲不足不越界
- `lid_logic` 37 条 —— shake 能量/连续帧/400ms hold、tilt 35°&2s、**lifted(低模长 <0.8g 持续 200ms)**、温度与电量滞回、优先级 shake>tilt>lifted>idle
- `command_parse` 19 条 —— 非本机/未知 type/过期/无 id 过滤、cmd_id 去重、嵌套 payload 跳过
- `sensor_source` 9 条 —— 合成源长时间扫描恒在契约合法区间、静止不误触 shake
- `base_weight` 30 条 —— present/stable 窗口、drink/refill 阈值、**首次稳定只建基准不发事件**
  (但空杯→斟满放回照发 refill)、off_base 120s 延迟、短暂拿起不误判、低电量滞回、窗口标准差
- `weight_source` 7 条 —— 合成源长时间扫描恒在契约区间、相位内噪声小于 settle 阈值、在座/拿起两相位
- `weight_comp` 19 条 —— 两点法自标定(反解 k、补偿回真值)、锚点门(重/吵/温差不够/系数越界)、
  未标定恒等、**E2E:合成源真实温漂 → 补偿后残差 < 5g**(M6 验收 #2)
- `chain` 10 条 —— **整链**「合成单元(温漂+噪声)→ 温补 → 判定」的**量值误差 < 5g**
  (M6 验收 #1:喝 100ml 报 99.8、续 150ml 报 150.0,含"基准 30℃ / 喝时 42℃"的温度变化,
  使温补真成量值精度的关键;对照断言证明不补偿会偏 6g)、连续两次喝各自成事件不累加、Δ20g 不误报
- `cmd_payload` 25 条 —— 下行原文按 cmd_id 定位后取 `payload.<key>`:命中/错 cmd_id/无该 key/
  值非整数/负数/13 位 Unix ms 不回绕/多指令只取匹配那条/嵌套对象与字符串括号内不误判;
  字符串值(remind.`text`)取中文、解转义、超长截断、值非字符串不取
- `cmd_exec` 11 条 —— config.`report_ms` 生效值裁定:区间内不变、低于 5s 钳到 MIN、高于 1h
  钳到 MAX、0/负 → 0(非法,调用方保持原值)
- `level_filter` 14 条 —— ToF 液位 α-β 滤波:静止平滑(σ 0.62→0.21)、跟得住匀速下降、
  单帧尖峰被门挡掉、真跳变经确认帧后接受、**晃动档输入 σ9 → 输出 σ1.35**(< 2mm)、越界夹紧
- `realtime` 12 条 —— 实时档决策:默认常规、晃动/App 请求触发、3s 保持窗、窗内再晃续窗、
  请求维持不掉档、常规/实时两档采样周期(1000ms / 25ms=40Hz)
- `uplink_buffer` 27 条 —— 断网上行缓存:入队计数、FIFO 顺序、**满则丢最旧**、超长截断、
  drain 全部补发、中途失败保留剩余、空队列 drain、空指针安全
- `sensor_convert` 43 条 —— 杯盖传感器换算(芯片字节 → 物理量,对 datasheet 算例):
  BMI160 加速度 16384LSB/g / 角速度 16.4LSB·s⁻¹ 灵敏度与补码符号、**倾角几何**(竖直 0°/平放 90°/
  倒置 180°/45° 斜、方位 atan2、全零不 NaN)、DS18B20 温度码(25.0625℃=0x0191 / −25.0625℃=0xFE6F
  / 125℃ / 全 0/全 1"没接"启发式)、VL53L0X 超量程哨兵(8190)、INA219 电压 4mV/LSB / 分流 10µV/LSB /
  电流 / 功率 / 单节锂电电量(3.0–4.2V → 0–100%)、空指针安全
- `weight_convert` 15 条 —— 底座称重换算:HX711 24 位补码符号扩展(正/负/最大最小/高位掩码)、
  上电 0x800000 / 掉电 0x7FFFFF 哨兵识别、零点 + 灵敏度 → 克、**未标定不猜**
- `led_pattern` 41 条 —— remind 灯效(led 名 → 效果序列):契约 §5 各效果名/颜色解析
  (`breath_blue` 等)、**后端 `push_device` 白名单 5 名逐个钉死效果 ∧ 颜色**
  (breath_blue/breath_green/blink_blue/blink_white/blink_red)、大小写与别名
  (on/solid、blink/flash、breath/pulse)、**led 缺席按有无文本
  给默认**(有文本→闪,无文本→灭)、未知效果名安全回落(**不点常亮**)、周期钳到 [100ms,5s]、
  闪烁次数钳到 [1,20]、空指针安全
- `ota_manifest` 27 条 —— 下行 `ota` 的 manifest 解析与校验(纯 C;下载/分区归 IDF 半):
  合法 `{url,sha256,size}` 取全、url 须 `http(s)://` 前缀且长度在 [8,512]、**sha256 恰 64 个 hex
  字符**(多/少一位都拒 —— 不被"截断到 cap"骗过)、size ∈ (0,4MB](契约占位 0 拒)、缺字段/错
  cmd_id 拒、乱序与嵌套 payload 仍取全、`ota_sha256_to_bytes` 解码成 32 字节(含非 hex 拒)
- `eye_state` 57 条 —— **硬件脸眼睛状态机**(双形体人格的硬件半边):十二态优先级
  (交接 > 受惊 > 强制表情 > 物理 > 低电 > 瞬时 > 环境 > 待机)、**交接闭眼包络**(§1.3 签名时刻:
  状态名当帧切、开度 0.4s 缓动)、**水烫是叠加态**(不改状态名,只叠眯眼 + 蒸汽相位)、
  **低电三次慢眨**(§3 #11)、一次性强制表情(§5.1 #1,不越交接)、眨眼瞬态、水低更耷拉;
  **钉死契约 motion 枚举序**(idle,tilt,shake,lifted —— 曾把本文件误写成 lifted 在前)
- `eye_render` 36 条 —— **硬件脸点阵渲染**(128×128 单色):睁眼有眼白、闭眼是矮横线、
  **瞳孔挖空**(眼窝中心灭)、弧眼(content 中段上拱)、倾斜整眼旋转、**水烫蒸汽带**(仅 hot 亮、
  随相位飘)、**1bpp 打包 2048 字节整屏**且逐位与像素一致、越界安全;
  **逐行脏标记**(`eye_render_dirty_rows`)+ **脏行合并成连续段**(`eye_render_dirty_spans` ——
  Memory LCD 局部刷新省电的核心决策,边界:首行脏/末行脏/隔行脏全在纯 C 里钉死,
  IDF 薄壳只循段推面板)
- `claim_code` 38 条 —— **设备一次性绑定码**(可信绑定的设备端半):**Crockford Base32**
  生成(8 位、去 I/L/O/U)、规范化容错(忽略空格/连字符/下划线、大小写无关、**O→0 与 I/L→1**
  纠正抄录歧义)、**常量时间比对**、时效(签发时刻 0 视为未知=过期、时钟倒挂=过期)、
  一站式校验(已用/过期/错码/形状非法 全拒),边界:恰在 TTL 上界有效(≤)、两空串相等

---

## 二、真机构建 / 烧录(需要 ESP-IDF v5.x)

前置:装好 ESP-IDF(建议 v5.1+),并 `source` 它的 `export.sh`(Windows 用 `export.bat`/IDF
PowerShell)。目标芯片 **ESP32-S3**。

```bash
cd lid      # 或 cd base
idf.py set-target esp32s3          # 用 sdkconfig.defaults 作初始配置
idf.py menuconfig                  # ← 必配下面几项(见下)
idf.py build
idf.py -p <串口> flash monitor     # Windows 串口形如 COM5;/dev/ttyUSB0 on Linux
```

### menuconfig 必配项(`Cup Device(杯子固件 · 盖与底座共用)` 菜单)

| 项 | 说明 | 默认 |
| --- | --- | --- |
| `CUP_WIFI_SSID` | 要连的 Wi-Fi | *(空 —— 留空则只告警不进网)* |
| `CUP_WIFI_PASSWORD` | Wi-Fi 密码(空 = 开放网) | *(空)* |
| `CUP_MQTT_URI` | broker 地址 | `mqtt://192.168.1.10:1883` |
| `CUP_USE_BLE_PROV` | 开 = 首次用手机 App 经 BLE 发 Wi-Fi 凭据(落 NVS);关 = 只用上面写死的 SSID | `n`(关) |
| `CUP_DEVICE_ID` | 本机 id,形如 `lid-XXXXXX` / `base-XXXXXX` | 盖 `lid-A1B2C3`;底座 `sdkconfig.defaults` 覆盖为 `base-` 前缀 |
| `CUP_CUP_ID` | 逻辑杯 id,形如 `cup-XXXXXX`(盖与底座须一致) | `cup-A1B2C3` |
| `CUP_REPORT_MS` | 常规档上报间隔(ms)—— **仅作默认值**;收到 `config` 指令后被运行时值覆盖并落 NVS | `300000`(契约 5 分钟) |
| `CUP_SAMPLE_MS` | 采样/判定周期(ms) | `1000` |

> **密钥不写进仓库** —— Wi-Fi 密码只经 menuconfig 进本地 `sdkconfig`(`sdkconfig` 不应提交)。

---

## 三、联调验收(M5 验收 #1:"后端一行不改就能收")

这一刀要证明的只有一件事:**真设备发上来的数据,现有后端原样就能收**。

三个进程(软件线已有的):

```bash
node apps/server/src/dev-broker-cli.ts
```

```bash
node apps/server/src/cli.ts --mqtt mqtt://localhost:1883
```

(第三个"进程"就是真设备 —— 下节把它指到这台 broker。)

把 `CUP_MQTT_URI` 指到跑 backend 的那台机器的 IP(与 broker 同机),烧录后看两处证据:

1. **设备串口**:启动打印 `传感源:synthetic`(底座为 `称重源:synthetic`)→ `已连接 broker`
   → `已订阅 dev/<id>/down 并握手` → 随后(`↑ lid seq=0 …` / `↑ base seq=0 …`,首帧立即发,
   不等 5 分钟)周期性上报
2. **后端进程**:`[mqtt-adapter] 收到 hello 握手`、接受帧数递增;
   并可 `curl http://localhost:8788/cups/cup-A1B2C3/today` 看到数据进库

下行回环(可选,证明双向通):用任意 MQTT 客户端往 `dev/<id>/down` 发一段
`Command[]`,设备串口打印 `↓ cmd <id> type=…`,即"指令送达"。后端本身的捎回(ADR T11)
会在设备下次上报时把它排队中的指令递回来。

### 3.1 下行指令**真执行**的手动验证(M7)

后端目前**只产** `config`(`POST /config`)与 `remind`(对话 `push_device`)两类;
`sync_time` 无生产者 —— 故对时链靠**手动发一条**验证。用任意 MQTT 客户端
(`mosquitto_pub` 或 `node apps/server/src/dev-broker-cli.ts` 的交互)往 down topic 发:

```bash
mosquitto_pub -h <broker> -t dev/lid-A1B2C3/down -q 1 -m '[{"v":1,"cmd_id":"t-cfg","target":"lid-A1B2C3","ts":0,"expires_at":0,"type":"config","payload":{"report_ms":60000}}]'
```

```bash
mosquitto_pub -h <broker> -t dev/lid-A1B2C3/down -q 1 -m '[{"v":1,"cmd_id":"t-time","target":"lid-A1B2C3","ts":0,"expires_at":0,"type":"sync_time","payload":{"server_ts":1759756800000}}]'
```

(down topic 里的 id 换成你 `CUP_DEVICE_ID` 的实际值;`expires_at:0` = 永不过期。)

**期望串口**:

- `config` → `config:report_ms=60000 生效(已存 NVS)`,此后遥测变密;**断电重启**仍打印
  `上报间隔续存自 NVS:60000 ms`(证明落盘)
- `sync_time` → `sync_time:已对时 → 1759756800000 ms`,此后 `↑ … seq=` 的 `ts` 变成真实墙钟
- `remind` → `remind:<文本> led=<名> → <效果>(color=<色>)`,同时板载 LED(GPIO10)按效果亮/闪/呼吸;
  `led` 缺席时按有无文本给默认(有文本→闪,无文本→灭)—— 见 `led_pattern` 单测
- 过密上报(`report_ms` 太小)会被钳到 5s 下限,串口打生效值 = 5000 —— 见 `cmd_exec` 单测

---

## 四、底座(M6)特有:称重判定在端侧闭环

底座的 `drink` / `refill` / `off_base` **不在后端判定**,而是固件 `base_weight.c` 里的
状态机产出(镜像 `apps/simulator/src/sensors/base.ts`)。阈值/窗口/延迟取自 `contract_dev.h`
里的 `SCALE_*` 宏(镜像 `constants.ts` 的 `SCALE`):

```
OFF        杯不在座上(present=false)
SETTLING   在座上但没稳(等 settle_window_ms 800ms + 窗口 std < settle_std_g 1.5)
RESTING(W) 已稳定,记住基准重量 W

RESTING(W1) ──重量→0──► OFF ──重量↑──► SETTLING ──稳定──► RESTING(W2)
  W2 < W1 − 30g → drink(amount_ml = |ΔW|)   derived_by='base' conf=0.95
  W2 > W1 + 30g → refill(amount_ml = |ΔW|)
```

**与模拟器的两点差异**(真固件必做、模拟器可省):

1. 稳定判定用**窗口内标准差 < `settle_std_g`**,而非只等 800ms;
2. `off_base` 带 **`off_base_delay_ms`(120s)延迟** —— 短暂拿起喝一口、再放回,不算"带走了"。

底座契约里**没有** imu/rssi 字段(`BaseTelemetrySchema` 就没有),故 `weight_source` 是窄接口,
不复用杯盖的 `sensor_source`。

M6 验收标准(见 `plan.md` §M6):①喝/倒的量称重值 vs 实际 < 5g;②热水注入后读数不因温漂
虚高虚低(温补,架构 §4.3);③拿起放下**不误判**为喝水(即上面第 2 点)。三条现均有**宿主单测**
形态的可复现证据:#1 `test_chain`(整链量值误差)、#2 `test_weight_comp` E2E(残差 < 5g)、
#3 `test_base_weight`(短暂拿起 60s 内放回不发 off_base、ΔW 未越阈值不误报)。

### 4.1 温漂补偿(`weight_comp.c`,M6 验收 #2)

应变片零点随整体升温缓慢偏移(架构 §4.3 / 风险 R1):热水烫热了底座,读数会跟着涨,
不补偿就会把"温度上升"误读成"水变多了"。**物理模型(零点漂移)**:

```
raw = 真实重量 + z(T)        z(T) = a + k·T   (k = 漂移系数 g/℃)
```

空座时真实重量=0,故 **raw = z(T)** —— 空座读数直接落在零点直线上。于是用**两个温度充分分离的
干净空座样本**即可反解 k(**自标定两点法**,免人工标定):

```
k = (r_hi − r_lo) / (T_hi − T_lo)     要求 T_hi − T_lo ≥ COMP_MIN_DT_C(5℃)
z(T) = r_lo + k·(T − T_lo)
corrected = clamp(raw − z(T), 0, 2000)
```

未标定(锚点不足或温差不够)时 **corrected = raw** —— 没有空座观测就不猜。参数在
`weight_comp.h`(`COMP_STD_WINDOW` 8 / `COMP_MIN_DT_C` 5 / `COMP_K_MAX` 2),**不进契约**:
漂移系数是设备内部实现(每批应变片不同),不属于设备间接口。

**锚点门(防污染)**—— 一个样本被采为空座锚点必须**同时**满足:① `raw < present_min_g(50g)`
(杯在座上=285g+,天然排除"没拿干净");② 窗口 std < `settle_std_g(1.5)`(静止,防晃动);
③ 窗口填满。锚点取窗口均值、k 反解后过 `K_MAX` 守卫(越界判污染丢弃)。

**合成源已带温漂 + 场景**(`weight_source.c`):`raw = 真值 + 0.5·(T−25)`;温度 25→50℃ 慢正弦
(30min);每 5min 一次"拿起 20s 再放回同重量"(20s < off_base 120s、ΔW=0,不误报事件,但给
温补喂**不同温度的空座锚点**)。于是**裸板也能演示 M6 #2**:烧 `base/`,温度爬升时日志里
`raw` 随之漂,出现锚点后 `k` 收敛、`corrected` 稳住(遥测日志并列打印 `raw` 与补偿后值)。

宿主单测 `test_weight_comp` 的 E2E 即 M6 #2 的可复现证明:**未补偿最大偏差 13.3g,
补偿后残差 0.9g**(< 5g)。

### 3.2 BLE 配网首次配置(M8)

杯子没有屏幕键盘,第一次得把 Wi-Fi 密码告诉它 —— 走 BLE。开 `CUP_USE_BLE_PROV=y` 后:

1. 烧录、上电,串口打印 `未配网 —— 起 BLE 配网,请用手机 App 连接设备 "cup-agent"`;
2. 手机用 **ESP BLE Provisioning** App(或 ESP-IDF 自带 `esp_prov.py`)连设备 `cup-agent`,
   Security 1(无 POP),输入家里 Wi-Fi 的 SSID/密码;
3. 串口打印 `收到 Wi-Fi 凭据,尝试连接…` → `Wi-Fi 凭据验证成功` → `BLE 配网完成,凭据已落 NVS`
   → 随后 `拿到 IP:…` 正常上线;
4. **断电重启**不再起 BLE(打印 `NVS 已有 Wi-Fi 凭据,跳过 BLE 配网`)—— 证明凭据落盘。

> Security 1(POP 空)仅够打通链路;生产须上 **Security 2(证书)+ POP**(风险 R13)——
> 属独立里程碑,见 `prov.h` 头注。

### 3.3 断网上行缓存(M8)

broker/网络断掉时的遥测不再丢:数据先入 `uplink_buffer`(有界 FIFO,16 条、单条 ≤512B,
满则丢**最旧**),esp-mqtt 重连 CONNECTED 后自动补发。串口可见
`未连 broker,暂存上行(队列 N)` 与连上后的 `补发 K 条(丢弃 D)`。这使"刚启动、broker 还没连上"
的过渡期不丢首帧,也让短暂断网不产生空洞。

### 3.4 可信绑定的设备端半:一次性 claim code(M11)

**为什么需要它**:后端的 `POST /social/cup`(绑定杯到账号)此前**只校验 `cup_id` 的形状**,
不验调用者是否真拥有那只杯 —— 于是 A 可以把 B 的杯绑到自己名下,再顺手删掉 B 的数据。
堵法是**要绑定方出示只可能来自真设备的一串码**:连上 SNTP 后固件发一枚一次性 claim code,
用户从串口(App 未接前)抄下来,绑定时一并提交;服务端校验它属于该 `cup_id` 且未用过。**服务端
半归窗口 A**;固件这半只负责"发码 + 存码 + 认用过"。

**码的形状**:8 位 **Crockford Base32**(`0-9 A-Z` 去掉易混的 **I/L/O/U**)。
抄录歧义由规范化兜掉 —— 忽略空格/连字符/下划线、大小写无关、并把 **`O`→`0`、`I`/`l`→`1`**
纠正过来;比对用常量时间(长度非秘密,但逐字比较不提前返回)。**24h 时效 + 一次性**。

**手动验证**(不需真传感器,合成源即可):

1. 烧录上电,串口在 SNTP 对时**之后**打印
   `设备绑定码(24h 内有效,一次性):XXXXXXXX —— 在 App 里输入以完成绑定`(8 位、无分隔符;WARN 级,醒目);
2. **断电重启** → 打印 `沿用已有设备绑定码(未用且未过期),不重发` —— 证明码落 NVS、且不因重启
   把用户刚抄下的码换掉;
3. 码被标记已用(服务端绑定成功通知,或过期)后,**下次上电重新发一枚新码**。

调用点在两个 `app_main` 里、SNTP 块之后:`claim_bringup(now_unix_ms())`(issued_at 要真墙钟,
否则服务端一算就过期)。**码怎么到服务端**:MQTT 连上后发的 hello 握手帧**顺带带上它** ——
`{"kind":"hello","v":1,"cup_id":"…","claim":"XXXXXXXX","issued_at":<ms>}`。hello 是设备→服务的
握手帧,后端在契约校验**之前**按 `kind==='hello'` 放行(`mqtt-adapter.ts`),故这几个字段
**不碰 `packages/contract`**。设备侧从 NVS 读当前生效码拼进 hello;取不到(还没配网/已用/过期)
则退化成旧形 `{kind,v}`,后端按"无 claim 不 upsert"处理 —— 缺码不阻断握手。持久化走 NVS
命名空间 `cup_claim`(键 `code`/`issued`/`used`)——
`used` 单独一个键而非删码,保留"这枚已作废"的事实便于排查。纯 C 层(`claim_code`)宿主单测 38 条。

---

## 五、硬件接口点(接真硬件时动这里)

软件线已把**所有真实硬件**隔离在少数几个文件里 —— 换上真芯片只动这些,判定的纯 C 层
(逻辑/滤波/补偿)一行不改,宿主单测继续有效。

### 5.1 杯盖(`lid/`)

| 传感器 | 实测对象 | 接口 | 落点 |
| --- | --- | --- | --- |
| **BMI160** 六轴 IMU | 加速度(shake)/角速度(实时档)/倾角 | **I2C** | `sensor_source.c` 真路径填 `has_imu`/`has_tilt` |
| **DS18B20** 水温 | 水温 → 高温告警 | **1-Wire** | 同上,填 `has_temp`/`temp_c` |
| **VL53L0X** ToF | 液位高度 mm | **I2C** | 同上,填 `has_level`/`level_mm`;滤波在 `level_filter.c` |
| **INA219** | 电量 / 充电态 | **I2C** | 同上,填 `has_battery`/`battery_pct`/`charging` |

开关:`sensor_source.c` 里 `CUP_SENSOR_USE_SYNTH`(默认 1 = 合成源)。置 0 时 `#error` 提醒
你先把真驱动填进 `sensor_real_*` 分支 —— 每颗传感器独立可选,没接的留 `has_* = false`,主循环照常。

**换算已写好,驱动只剩"读字节"**:芯片字节 → 物理量的算术(灵敏度、补码、倾角几何、
超量程哨兵、电量曲线)全在 `sensor_convert.{h,c}`(纯 C,已宿主单测)。真驱动只需用 I2C/1-Wire
读回原始寄存器值,交给这些函数即可 —— 不必再对着 datasheet 推换算(那正是最易错的一截)。
常量(如 BMI160 满量程档、INA219 分流电阻)须与驱动实际配置一致,已集中在 `sensor_convert.h`。

### 5.2 底座(`base/`)

| 传感器 | 实测对象 | 接口 | 落点 |
| --- | --- | --- | --- |
| **HX711** + 应变片 | 总重(含皮重)克 | **2 线 bit-bang**(SCK/DOUT) | `weight_source.c` 真路径填 `weight_g` |
| **NTC / DS18B20** | 底座温度(温补用) | **ADC / 1-Wire** | 同上,填 `has_temp`/`temp_c` |

温漂补偿在 `weight_comp.c`(自标定,不吃芯片型号);底座不需要 IMU/液位。

**换算已写好,驱动只剩"读计数"**:HX711 24 位补码符号扩展、上电/掉电哨兵、零点 + 灵敏度 →
克,全在 `weight_convert.{h,c}`(纯 C,已宿主单测)。`zero_count` / `counts_per_g` 是**这台底座的
标定值**(随机器不同),存 NVS / 标定后传入,本层只做算术。

### 5.3 板载 LED(盖 / 底座共用,`cup_common/`)

| 器件 | 用途 | 接口 | 落点 |
| --- | --- | --- | --- |
| **单色数字 LED** | `remind` 点灯(亮/闪/呼吸) | **GPIO(经 LEDC/PWM)** | `led_driver.c`(引脚 `CUP_LED_GPIO`,默认 10) |

`remind` 的 `led` 参数(契约 §5 的效果名字符串,如 `breath_blue`)**不被本层解析成颜色硬件** ——
板载是单色 LED,只驱动"亮/灭 + 占空比";`led_pattern.c`(纯 C,已宿主单测)把名字 → 效果
(off/solid/blink/breath),颜色分量解析出来仅日志用(换 RGB 时在 `led_driver.c` 扩)。换引脚改
`CUP_LED_GPIO` 一处;若板子没有 LED,`led_driver_init` 失败只记 warn,其余功能不受影响。

---

## 六、设计要点 / 边界

- **所有端侧判定都在固件里闭环**:后端只收遥测/事件,并用契约 `UpstreamFrameSchema`
  校验。所以 shake/tilt/温度/电量 与底座 drink/refill 的阈值与滞回**必须**按
  `packages/contract/src/constants.ts` 在固件里复刻 —— 镜像点集中在 `contract_dev.h` 的
  `IMU_*` / `ALERT_*` / `SCALE_*` 宏,改契约时只此一处。
- **手写 JSON,不引 cJSON**:字段少、形状固定,手写更短更可读、零依赖。代价是字段名必须
  一字不差 —— 故全部集中在 `contract_dev.c`,并用宿主单测钉住。
- **契约镜像有机器守卫**:`contract_dev.h` 那句"必须与 `EVENT_TYPES` 逐字一致"曾只是
  靠人守的承诺 —— 2026-10-14 契约加手势 `tap`/`long_press` 时镜像漏跟,承诺当场变假话。
  现由 `firmware/host_test/contract-mirror.test.ts`(随根 `npm test`/CI 跑)**机器守**:
  直接读固件的 `event_type_t` / `motion_state_t` / `derived_by_t` 与契约枚举对表,
  多一个/少一个/串拼错、或 `<enum>_str()` 漏 case,都红。
- **下行真执行分三层**(M7):`command_parse` 只挑"该不该执行"(cmd_id/type/expires),
  **刻意不碰 payload**;`cmd_payload` 拿到原文后按 cmd_id 定位、取 payload 整数字段;
  `cmd_exec` 裁定生效值(夹紧边界)。取值与裁定都是纯 C,故边界可在 PC 上钉死 ——
  最易错的"过密上报把链路打爆 / 上报被停掉 / 非法值"全在这层拦住。IDF 只用在 `cmd_store`
  这个 NVS 薄壳上(且自带幂等 `nvs_flash_init`,不依赖 Wi-Fi 是否已连)。
- **`ota` 拆两半**(同 M9 换算层思路):**manifest 的解析与校验**(url 前缀/sha256 恰 64 hex/
  size 范围)是纯 C(`ota_manifest`,已宿主单测);下载 + `esp_https_ota` + 分区切换是 IDF 半、
  待真板。两个 main 的 OTA 分支现在**先校验 manifest、不过就不下载**(整齐回落),过则记一条
  "manifest ok"。`ota_sha256_to_bytes` 把 64 hex 解成 32 字节,直接喂 `esp_https_ota` 的校验。
- **过期判断用真实时钟**:`mqtt_uplink` 收到下行时,时钟 sane(SNTP 已对时)才传 `now_ms`
  给 `cmd_parse_payload`,否则传 0(不做过期判断)—— 对时前不误杀指令,`sync_time` 落地后
  自动开始 honor `expires_at`。与两个 `main` 的 `now_unix_ms` 同一约定(阈值 1600000000)。
- **时间戳**:契约只要求 `ts` 非负、单调。联网后用 SNTP 取 Unix 毫秒(才能与软件线数据对齐);
  对时失败则退回"自启动毫秒"。`ts` 是 **64 位**(13 位 Unix 毫秒,`uint32` 会截断)。
- **合成源默认开启**:裸板(无任何传感器)也能先把"联网→上报→收指令"整条链路跑通;
  之后逐颗焊传感器,把对应 `has_*` 打开即可。这也是 M5/M6 能脱离硬件先验证的原因。
- **topic 键 == device_id**(ADR T17):上行 `dev/<device_id>/up`、下行 `dev/<device_id>/down`;
  topic 里的 id 必须等于报文里的 `device_id`,否则后端拒收。
- **底座 ↔ 杯盖配对**按 `cup_id` + `ts`;后端 `core/fusion.ts` 已按 cup 分实例做双源融合 ——
  **固件不做融合**,各发各的。
- **引脚不写死进仓库**:真驱动路径的引脚号只作示例注释,具体接线随你的板子定;改引脚只动
  `sensor_source.c` / `weight_source.c` 的真路径分支,不碰纯逻辑层。

### 尚未做(后续里程碑)

- 真传感器驱动,**仅剩"读字节"那半截**(盖:BMI160 / DS18B20 / VL53L0X / INA219;底座:HX711
  应变片)—— 现为合成源,接口点见 §五。**换算层(字节 → 物理量)已完成**(`sensor_convert` /
  `weight_convert`,纯 C + 宿主单测,对 datasheet 算例),真板到了只填 I2C/1-Wire 读寄存器 + 交给换算层
- 下行 `ota` 的**实际执行**(`esp_https_ota` + 分区表)—— **manifest 的解析与校验已完成**(`ota_manifest`,
  纯 C + 宿主单测:url 前缀/sha256 恰 64 hex/size 范围);真板只剩"下载 + 校验 + 分区切换"这层 IDF 壳
- RTC(掉电续时,现靠 SNTP + 开机回退) / 更长的断网缓存(现 16 条环形,断电即失)
- BLE 配网的 **Security 2 + POP**(现 Security 1,风险 R13)
- 安全(mqtts + 凭据,风险 R13)

> **M8 已完成**(端侧信号质量 + 配网):ToF 液位 α-β 滤波(晃动重平滑)、实时档 40Hz IMU
> 决策(晃动/App 触发 + 3s 保持窗)、断网上行缓存(有界 FIFO + 连上补发)、BLE 配网
> (`wifi_prov_mgr` 薄壳,凭据落 NVS)。四者纯逻辑层都有宿主单测;配网/缓存属 IDF 薄壳,
> 本机仅 shim 语法检查。**下行指令真执行(M7)亦已完成** —— 见 §三.1。
>
> **M9 已完成**(硬件接口换算层):把各芯片"字节 → 物理量"的换算(**最易错、又不依赖真板**的
> 一截)抽成纯 C —— `lid/sensor_convert`(BMI160/DS18B20/VL53L0X/INA219,对 datasheet 算例)、
> `base/weight_convert`(HX711 24 位补码 + 标定换算),宿主单测 43 + 15 条钉死。真板到了,
> 驱动只剩 I2C/1-Wire 读原始值 → 交给这两层。**契约零改动**。
>
> **M10 已完成**(remind 点灯):将 `remind.payload.led`(契约 §5 的效果名字符串,如
> `breath_blue`)→ 灯效序列的**决策层**抽成纯 C(`cup_common/led_pattern`,宿主单测 41 条:
> 名字解析、越界钳制、未知名安全回落、led 缺席按文本给默认),真板薄壳 `led_driver`(LEDC/PWM
> 驱动单色 GPIO10,亮/灭/闪/呼吸)。**顺带修一处真 bug**:两个主循环原用 `cmd_payload_i64`
> 读 `led`,而契约里 `led` 是**字符串**,故此前一直读不到、`led` 被静默丢弃 —— 改用
> `cmd_payload_str`。**契约零改动**。注:后端 `push_device`(2026-10-10 起)已发
> `{text, led}`,故 `led_pattern` 这条路径**现就是真机实际走的** —— `led` 走白名单枚举
> (`breath_blue`/`breath_green`/`blink_blue`/`blink_white`/`blink_red`)、缺席兜默认
> `breath_blue`;固件解析其 `<effect>_<color>`、未知 effect 安全回落(有文本→闪,否则灭)。
>
> **ota 已落"纯 C 半截"**(同 M9 思路,不依赖真板):把 `ota.payload`(契约 §5 `{url,sha256,size}`)
> 的**解析与校验**抽成纯 C(`cup_common/ota_manifest`,宿主单测 27 条:url `http(s)://` 前缀 +
> 长度、**sha256 恰 64 个 hex 字符**、size ∈ (0,4MB]、字段乱序/嵌套、`ota_sha256_to_bytes` 解码),
> 真板只剩"下载 + `esp_https_ota` + 分区切换"这层 IDF 壳。两个 main 的 OTA 分支现在**先校验、
> 不过不下载**。**契约零改动**。
