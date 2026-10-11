# @cup/web —— 前端

卡通杯 + 数据看板 + 对话。React 19 + Vite + Tailwind v4。

**窄屏三 Tab,宽屏一屏**:`杯子`(英雄功能:Canvas 水波物理)/ `看板`(数据卡)/ `对话`。
宽度断点 768px(`App.tsx` 的 `useWide`),同一份组件两种排布 —— 窄屏 Tab 切换,宽屏卡片悬浮/分栏。

看板卡与对话分享同一份数据与同一份对话记录:消息流上提到 `App`,故切 Tab / 换布局不丢。

## 快速开始

```bash
npm run dev --workspace @cup/web      # 起 Vite(:5173)
```

打开 `http://localhost:5173`,按 URL 参数选数据源(见下)。

**接后端(推荐,完整看板)**:

```bash
node apps/simulator/src/cli.ts --ws 8787 --report-ms 10000   # 终端 1:模拟器
node apps/server/src/cli.ts --sim ws://localhost:8787        # 终端 2:后端
npm run dev --workspace @cup/web                             # 终端 3:前端
```

浏览器开 `http://localhost:5173/?cloud=1` —— 连**后端**,看板数字用后端日聚合,杯子动画用后端推送的遥测。

## URL 参数

数据源在 `App.tsx` 的 `makeSource()` 里按参数挑:

| 参数 | 说明 |
|---|---|
| `?cloud=<apiBase>` | 连后端 API(推荐)。`?cloud=1`/省协议均可,缺省基址 `http://localhost:8788` |
| `?key=<key>` | 写端点鉴权(`PUT /goal` 等默认要 `x-api-key`,R10-B);仅云模式有意义 |
| `?cup=<cup_id>` | 指定杯子 id(缺省 `cup-A1B2C3`) |
| `?mock=1` | 本地假数据,永远有数(模拟器/后端都没起时的兜底) |
| `?ws=ws://…` | 直连模拟器,不经后端(仅遥测 + 事件,无日聚合/战报/对话) |

不带参数 = 直连 `localhost:8787` 的模拟器。

## 三种数据源

| 源 | 文件 | 提供 |
|---|---|---|
| `CloudSource` | `data/cloud.ts` | 后端 REST + WS:今日 / 序列 / 战报 / 性格史 / 对话 / 改目标,全部能力 |
| `SimulatorSource` | `data/simulator.ts` | 直连模拟器 WS:遥测 + 事件(离线前端的降级) |
| `MockSource` | `data/mock.ts` | 本地假数据 + 本地目标持久化(纯前端演示) |

三者实现同一接口 `DataSource`(`data/source.ts`):`stats` / `events` / `report` / `setGoal`(可选)/
`ask`(可选)/ `on(evt, cb)`。组件只看接口,不关心数据从哪来 —— 换源不动视图。

## 看板卡片(`components/dashboard/`)

| 卡片 | 内容 |
|---|---|
| `TodayPanel` | 今日已喝 / 目标进度 / 次数 / 当前水位水温 |
| `Streak` | 连续达标天数(后端 streak 或占位) |
| `GoalCard` | 每日目标设置(真实表单,校验在 `lib/goal.ts`) |
| `DrinkBuckets` / `DrinkChart` | 杯量分档 + 日内饮水曲线 |
| `TempChart` | 水温曲线 |
| `WeekTrend` | 近 7 天趋势(后端周桶) |
| `HistoryCard` | 历史战报逐日 |
| `MoodHistoryCard` | 脾气变化史(养成卡只读半) |
| `ReportCard` | 当日战报文案 |

通用小组件在 `components/ui.tsx`(`Card` / `Stat` / `Chip` / `Bar` / `Button` / `TextField`)。

## 目录地图

```
src/components/       视图
  CupWidget.tsx        卡通杯(Canvas 2D + 一维水波物理,英雄功能)
  EyePreview.tsx       128×128 单色点阵预览(双形体:屏幕脸)
  ChatPanel.tsx        对话卡(纯展示,状态由 useChat 持有并上提)
  FloatingCup.tsx      宽屏悬浮杯
  PowerPanel.tsx       续航估算
  BoardView.tsx        看板布局
  dashboard/           看板卡片(见上表)
  ui.tsx               通用小组件
src/data/             数据层
  source.ts            DataSource 接口 + 契约归一类型 + 守卫
  cloud.ts / simulator.ts / mock.ts   三源实现
  useCupData.ts        主数据 hook(遥测 / 事件 / 目标 / 战报)
  useChat.ts           对话 hook(消息流 / 草稿 / 发送)
src/lib/              纯逻辑(全部可单测)
  water.ts            水波物理 + 固定步长
  color.ts            水温色阶
  mood.ts / sulk.ts   傲娇表情 / 蔫态低落度
  eyes.ts / eye-render.ts / gesture.ts   点阵眼 + 手势语法
  stats.ts / buckets.ts / history.ts / mood-history.ts   聚合与展示
  goal.ts / chat.ts / power.ts
src/App.tsx           入口:源选择 + Tab/布局 + 状态上提
src/main.tsx          React 挂载
```

## 测试

```bash
npm --workspace @cup/web test        # 168 个测试
```

两层:

- **纯逻辑单测** —— `src/lib/**` 的函数(水波物理、色彩、表情、统计、目标校验、对话构造等),
  直接 import 断言,无 DOM。这是主体。
- **组件级测试** —— `test/*.test.tsx`:在 **jsdom** 上真挂载 React 组件(非浅渲染),真点击 / 真输入 /
  真提交表单,验交互链路。环境见 `test/setup.mjs`(esbuild 即时转译 `.tsx` + jsdom 全局 + canvas 桩)
  与 `test/mount.tsx`(挂载 / click / type / submit / flush 工具)。

> 组件测试用 `node --test-isolation=none` 单进程跑(jsdom 只装一次,快约 17×);
> 纯逻辑测试与组件测试同一次 `npm test` 里跑完。

## 交接文档

`HANDOFF.md`(前端总交接)、`CHAT-HANDOFF.md`(对话线交接)是给接手的窗口看的详细现状,
本 README 是概览 —— 冲突时以交接文档为准(那是逐里程碑维护的)。

## 边界

- **不改 `packages/contract`**:契约是四方(契约 / 模拟器 / 后端 / 固件)唯一真相源,冻结。
- 需要新依赖(库 / 工具)先问,别默默引(P4)。
