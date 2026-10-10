# HANDOFF · apps/web 前端

> 给并行开工的 agent。**只碰 `apps/web/`**,不要动 `packages/contract/` 和
> `apps/simulator/` —— 那是另一边的工作面,改了会撞车(要改契约走下面的流程)。

---

## 0. 一句话现状

M2 骨架**已经搭好并跑通**:响应式外壳 + 看板五张卡 + Canvas 卡通杯(静态版)
+ 悬浮杯(可拖/可收)+ 数据源抽象。现在数据来自**模拟器 WS**;你的活是把它做**好看、做完整**,
并接 M3 的水波物理。

---

## 1. 跑起来

```bash
# 终端 A:起前端
npm --workspace @cup/web run dev        # → http://localhost:5173

# 终端 B:起模拟器(发数据)
node apps/simulator/src/cli.ts --ws 8787 --scale 1 --scenario smoke --report-ms 1000

# 不想起模拟器?浏览器打开:
#   http://localhost:5173/?mock=1       ← 本地假数据,永远有数
# 指定别的 WS 地址:
#   http://localhost:5173/?ws=ws://192.168.1.5:8787
```

`--scenario smoke` 会在第 5/30/60/90/120 秒各造一个事件,适合盯着看。
`--scenario day` 是完整一天,但起点是 00:00,实时模式下要等很久才出事件。

---

## 2. 目录与职责

```
apps/web/
  index.html
  vite.config.ts          Vite + React + Tailwind v4 插件
  tsconfig.json           独立 tsconfig(带 DOM lib)—— 根 tsconfig 已 exclude 本目录
  src/
    main.tsx              入口
    App.tsx               外壳:响应式分支 + 数据 hook 挂载点
    styles.css            主题 token(暖青)← 只改这里换色
    data/
      source.ts           ★ DataSource 接口:前端与数据源的唯一耦合点
      simulator.ts        SimulatorSource:连模拟器 WS(带断线重连)
      cloud.ts            CloudSource:连后端(M1 之后,推荐)WS 实时 + REST 聚合
      mock.ts             MockSource:本地假数据
      useCupData.ts       React hook:DataSource → {frame, events, state, server}
    lib/
      stats.ts            从事件流算今日概览 / 分桶(无后端时的回退)
    components/
      ui.tsx              卡片 / 数字 / 标签 / 进度条
      CupWidget.tsx       ★ 卡通杯 Canvas 2D(现在是静态版,见 §5)
      FloatingCup.tsx     宽屏悬浮杯:拖动 / 收成圆点
      BoardView.tsx       看板容器(把下面的卡片拼起来)
      dashboard/
        TodayPanel.tsx    今日概览
        DrinkChart.tsx    饮水曲线(SVG 柱状)
        TempChart.tsx     水温(SVG 折线)
        Streak.tsx        打卡(占位)
        ReportCard.tsx    战报(模板版)
```

---

## 3. 数据怎么来的(重要)

**所有部件只从 `useCupData()` 拿数据,绝不自己连 WS。** 换数据源不改组件。

```ts
const { frame, events, state, server } = useCupData();
frame?.lid    // LidTelemetry | undefined   ← 杯盖遥测:水位/水温/运动/电量
frame?.base   // BaseTelemetry | undefined  ← 底座遥测:重量/是否在座/充电
events        // CupEvent[]                 ← 滚动事件流(含历史,上限 500)
state         // 'connecting' | 'open' | 'closed' | 'error'
server        // ServerToday | null         ← 后端今日快照(仅 CloudSource 有)
```

**两种数据源,同一接口**:

| 源 | 连谁 | 何时用 |
|---|---|---|
| `SimulatorSource` | 模拟器 WS(直连) | 只调杯子 / 不要后端时 |
| `CloudSource` | **后端**(`?cloud=1`) | 推荐:数字以后端日聚合为准 |

`CloudSource` 是**混合**的:WS 推 `telemetry`(原始 lid/base → 还原 `LiveFrame`);
REST `/today`、`/events` 补 WS 给不了的跨天聚合(今日量 / 连续天数 / 当天历史)。
看板有 `server` 就用后端数字,没有就回退 `lib/stats.ts` 现算 —— 所以两种源都能跑。

WS 协议(模拟器 `apps/simulator/src/ws/server.ts`;后端 `apps/server/src/api/live.ts`):

- 连上先收 `{"kind":"hello",…}`,跳过。
- 模拟器每行:`{"kind":"lid"|"base"|"event","payload":{…}}`。
- 后端每行:`{"kind":"hello"|"telemetry"|"event"|"sample","cup_id","payload":{…}}`,
  其中 `telemetry.payload` 是 `{cup_id,device_id,kind,ts,seq,lid?|base?}` —— 取里面的
  `lid`/`base` 即还原成前端熟知的遥测对象。
- `payload` 的完整字段定义在 `packages/contract/src/schemas.ts`(真相源)。
- 同一批的 lid/base/event 会被源合并成**一个** `frame` 回调,
  所以 `frame.lid` 和 `frame.events` 是同批的。

字段速查(完整见 schema):

| 字段 | 含义 | 备注 |
|---|---|---|
| `lid.level_pct` | 水位百分比 0–100 | 直接可用 |
| `lid.level_mm` | 水位高度 mm | 换算见 contract 常量 |
| `lid.temp_c` | 水温 ℃ | |
| `lid.motion` | `idle\|tilt\|shake\|lifted` | 英雄功能靠它 |
| `lid.tilt_deg` / `tilt_dir` | 倾角 / 方向 | M3 液面 slope 用 |
| `lid.battery_pct` / `charging` | 电量 / 是否充电 | |
| `lid.imu` | 加速度/角速度 | **仅实时档携带**,可选 |
| `base.weight_g` | 重量 g | 含空杯皮重(`CUP.tare_g`) |
| `base.present` / `stable` | 在座 / 稳定 | |
| `event.type` | `drink\|refill\|shake\|temp_alert\|tilt_alert\|low_battery\|off_base` | |
| `event.amount_ml` | 喝/续的量 | **仅 drink/refill 有** |

`event.ts` 是 **epoch 毫秒**(虚拟时间)。注意模拟器跑的是"加速的虚拟一天",
事件时间戳可能是今天 07:00 那种;`stats.ts` 的 `isToday()` 已按本地日判断。

---

## 4. 已定的 UI 决策(别推翻)

- **窄屏(<768px)**:底部 Tab 切换 `[杯子] / [看板]`。杯子独占一屏。
- **宽屏(≥768px)**:看板常驻,杯子**悬浮**在右下角:
  - 可拖动(位置存 `localStorage`);拖动 >6px 才算拖,否则算点击
  - 点击(或没拖动)= 收/展成 **44px 小圆点**
  - 左下角有个"隐藏杯子"开关(临时,可改)
- **配色**:暖系青蓝,`styles.css` 里 `@theme` 的 `--color-cup-*`。
  **色板(D3)还没定稿**,现在是暂定值;定稿只改这一处。
- **不做 WebGL / 不引粒子库 / 不引图表库**(按需引入,P4)。现在是
  Canvas 2D + 手写 SVG。要做花哨动画前先问,别自己加依赖。

---

## 5. 你的主要活:M3 卡通杯 + 水波物理【英雄功能】

`CupWidget.tsx` 现在是**静态版**(水位 + 温度配色 + 一张脸,能跑但不是最终效果)。
要把它升级成:摇杯时画面**立即**同步晃,倾斜时液面流向低处。

物理已经设计好(见《架构文档》§6.2):

- 一维水波:32 个采样点,每个点 `h[i]`
- 每帧更新:`v[i] += k*(target - h[i]) + c*(h[i-1]+h[i+1]-2h[i])`,再 `h[i] += v[i]`
- 阻尼 ≈ 0.98;`target` 是静止液面(由 `level_pct` 定)
- **摇杯脉冲**:`lid.motion === 'shake'` 时,用 IMU 加速度给中间点打脉冲
- **倾斜 slope**:`lid.tilt_deg` / `tilt_dir` 决定液面整体倾斜方向
- 插值:输入 50Hz、渲染 60fps,别让物理步长跟着帧率漂(`用固定 dt 累加`)

验收(plan M3,产品的原话):
1. 模拟器一摇 → 画面**立即**跟着晃,感觉"同步"而非"播动画"
2. 倾斜 → 液面流向低处,静下来水平且带倾角
3. 凉/热水颜色差异肉眼可辨,且落在暖青体系内
4. **产品方点"好看"** ← 唯一真验收。预期要反复打磨造型/配色/缓动。

美术方向:卡通形象,不要冷冰冰/写实。`CupWidget.tsx` 的分层(`drawFace` / 水层)
已经留好接口,尽管重画。

---

## 6. 其余待办(按建议顺序)

1. **M3 水波物理**(上面,最高优先)
2. **Streak 连续天数**:需要跨天数据 —— 现在后端还没有,可以先本地算
   (把每日 intake 存 localStorage),或等 M1 后端
3. **战报卡片**:现在 `ReportCard.tsx` 是纯模板。M4 接 LLM 后从后端拿文案,
   断网回退到模板(别删模板逻辑)
4. **看板补齐**:现在只有 5 张卡。可加:本周对比、杯量分档、目标设置入口
5. **空态/断线观感**:现在断线只改顶部小圆点颜色,可以做得更明显

---

## 7. 边界(重要)

- ❌ **不要改 `packages/contract/`**:契约是四方共享的真相源,改动要走
  contract 的版本流程(加字段升 minor;改语义/单位/字段名升 `v`)。真需要加字段,
  先停下来问。
- ❌ **不要改 `apps/simulator/`**:那是 M0 的产物、已验证(19 测试全绿)。
  你要造新数据,用 `?mock=1` 的 `MockSource`,别动模拟器。
- ✅ **可以**:改 `apps/web/` 里任何东西、加 web 自己的依赖(先问)、
  改主题 token、重画杯子。
- 🔒 **桌面文档是私人的**:不要把桌面路径写进仓库里的任何文件(README/注释/PR)。

---

## 8. 已知的小坑(踩过了,别重踩)

- **Windows 大小写**:`components/dashboard/`(小写)和 `components/Dashboard.tsx`
  在 Windows 上会撞名报 `TS1261`。所以看板容器叫 **`BoardView.tsx`**,别再叫 Dashboard。
- **StrictMode 双挂载**:React 开发模式会挂载两次,`SimulatorSource` 里已用
  `current()` 过滤掉"被弃用的旧 socket",否则事件会收**两遍**(喝一次记两次)。
  改 `simulator.ts` 时别把这个过滤删了。
- **模拟器实时模式会哪天结束**:`cli.ts --ws` 是实时跑,场景跑完进程就退。
  前端已做断线重连(退避到 5s),所以重启模拟器不用刷页面。
- **根 tsconfig 已 exclude `apps/web`**:因为 web 要 DOM lib。web 有自己的
  `tsconfig.json`,类型检查用 `npx tsc -p apps/web/tsconfig.json`。

---

## 9. 命令速查

```bash
npm --workspace @cup/web run dev                          # 起前端
npm --workspace @cup/web run build                        # 生产构建
npx tsc -p apps/web/tsconfig.json --noEmit                # 前端类型检查
node apps/simulator/src/cli.ts --ws 8787 --scale 1 --scenario smoke --report-ms 1000
npm test                                                  # 模拟器/契约测试(别改坏)
```

---

*祝顺利。做完 M3 记得让产品方看一眼"好不好看"再往下走。*
