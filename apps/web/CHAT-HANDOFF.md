# 窗口 B 交接 —— 前端「和杯子对话」

> 这份文件是另一个窗口的**独立作业书**。它看不到后端那个会话的任何上下文,
> 所以这里把需要的都写全。**接口已冻结**(后端 P1 内核 + 测试已跑绿),双方不得单方改。

## 你的边界(硬性)

- 你**只改** `apps/web/src/**`。
- **不要碰** `apps/server/**` 和 `packages/contract/**` —— 它们由另一个窗口在改。
  本工作区**不是 git 仓库**(无 `.git`),两个窗口**直接改同一批文件**,没有分支隔离 ——
  所以分工必须**文件不重叠**。上面的切分正好做到:A 不碰 web,B 不碰 server。

## 要做的

1. `components/ui.tsx` —— 新增 `Button` / `TextField`(沿用现有 className token 风格,零新依赖)。
2. `components/ChatPanel.tsx`(新)—— 消息列表 + 输入框。把**纯格式化/守卫辅助**抽成
   可测的纯函数(web 无 DOM 测试环境,没法测渲染)。
3. `data/source.ts` —— `DataSourceEvents` 增 `proactive: (m: ProactiveMessage) => void`;
   导出下面两段类型。
4. `data/cloud.ts` —— 新增 `postJson<T>(path, body)`(镜像现有 `getJson`:`!r.ok` → 返回 null);
   公开 `ask(q)`;`absorb` 增 `'proactive'` 分支;`on` 的窄联合加上 `'proactive'`。
5. `data/useCupData.ts` —— 返回 `proactive` + `ask` 透传。
6. `App.tsx` —— `type Tab = 'cup'|'board'|'chat'` + nav 数组 + `<main>` 分支;窄屏一个 tab。
7. `BoardView.tsx` —— 宽屏加一张 `<ChatPanel/>` 卡。

## 冻结接口(双方不得单方改)

```ts
// POST /cups/:cupId/ask   body { q: string }  → 200 { cup_id: string, answer: ChatAnswer }
interface ChatAnswer { text: string; source: 'llm' | 'fallback'; tools_used: string[]; turns: number }

// WS /cups/:id/live 新增一帧
interface ProactiveMessage { text: string; ts: number; source: 'llm' | 'fallback'; facts: Record<string, unknown> }
{ kind: 'proactive'; cup_id: string; payload: ProactiveMessage }
```

> **以上已在后端被测试钉住**(不是口头约定):`apps/server/test/chat-http.test.ts`
> 真起 HTTP、真发 `fetch`、断言 `cup_id` + `answer.source`。照着接即可。

### `/ask` 的错误路径(接的时候会撞到)

| 情况 | 返回 |
|------|------|
| 非 POST(如 `GET`) | **405** |
| 空问句 / 只有空白 | **400** |
| 问句 `> 500` 字 | **400**(不进提示词) |
| 正常 | **200** `{ cup_id, answer }` |

**失败时 body 里没有 `answer`** —— 所以 `postJson` 要按"非 200 → 空"处理
(和现有 `getJson` 的 `!r.ok → null` 一样),别假设 body 一定有 `answer`;
拿到 `null` 时 ChatPanel 显示"没听清 / 稍后再问",不要崩。


## 起步方式

**先接 `MockSource`**(T7 的 `DataSource` 接口红利)把 ChatPanel 做完并跑通 UI —— **不必等后端**。

**后端 `/ask` 已经就绪**(P1–P5 全绿,119 根测试通过),所以 UI 一通就能直接切 `?cloud=1`
联调真数据,没有等待期。

## 注意

- 零新依赖(不要引 UI 库、不要引 markdown 渲染器、不要引 chart 库)—— 项目 P4 原则。
- `<main>` 里窄屏/宽屏的既有分支逻辑别破坏,只**追加** chat 一项。

---

# 第二轮(2026-10-09)—— 上面 7 项已全部落地,勿重做

> ✅ **B1/B2/B3 已于 2026-10-09 完成并经窗口 A 核实**(web 测试 36 → 37,双 typecheck 干净,
> 无新依赖,页面内测试 hack 未泄漏进 `src`)。**本节勿重做。** 唯一残留:主动开口的
> **真实 14–18 点触发窗口**未跑(只验了前端渲染链路);下次落在这个时段再补一次真跑即可。

> 已核对:`ui.tsx` Button/TextField、`ChatPanel.tsx`、`source.ts`(proactive/ChatAnswer/守卫)、
> `cloud.ts`(postJson/ask/absorb)、`useCupData`(透传)、`App.tsx`(chat tab)、`BoardView`(ChatPanel 卡)
> **全部就位**;web 测试 36 全绿(+14 chat),web typecheck 干净。以下只做**新增**。

## B1 ⭐ 浏览器 × 真后端联调 —— M5-对话 唯一没验的验收门

单测覆盖了守卫 / 格式化,但**"浏览器里发问 → 真 `/ask` → 答复数字对得上"从没跑过**。
做完这条,M5-对话(软件线)才算闭环。

### 起三个终端

```bash
node apps/simulator/src/cli.ts --ws 8787 --report-ms 10000
```

```bash
node apps/server/src/cli.ts --sim ws://localhost:8787
```

```bash
npm --workspace @cup/web dev
```

浏览器开 `http://localhost:5173/?cloud=1`(`?cloud=1` → 前端连默认后端 `http://localhost:8788`;
`?cloud=http://host:port` 可指定别处)。

### 逐条验收(对不上就报,别自己"圆过去")

1. **发问**:chat tab(窄屏)或看板里的 chat 卡(宽屏)问「今天喝了多少」→ 有答复。
2. **数字对得上**:答复里的 ml 数 == 看板"今日已喝" == `GET /cups/cup-A1B2C3/today` 的 `drank_ml`。
3. **模型缺席不空白**:不给 `CUP_CHAT_KEY`(当前环境就没有)→ `source` 应是 `'fallback'`,
   但**仍出确定性模板句、带真实数字**,不是空白 / 报错。
4. **错误路径不崩**:`/ask` 返回 400/405 时(如空问句)→ ChatPanel 显示"没听清 / 稍后再问",不崩。
5. **主动一句**:后端用**注入时钟**测过,真跑要实时落在**本地 14:00–18:00 且欠水**才会自己开口
   (见 `core/proactive.ts`)。真到点时前端应把 `kind:'proactive'` 追加进列表 + **chat tab 打未读点**。
   到不了那个钟点就只验**渲染**(列表能显示一条主动消息即可),并在汇报里写明"E2E 主动一句未在实时窗口验"。

> **别改后端去凑**(比如加个手动触发)。真需要触发,把需求写回本文件,让后端窗口加。

## B2 近 7 天趋势卡(数据后端早就有,纯前端)

- 后端 `/cups/:id/series?range=week` 已返回 **7 桶**(见 `api/http.ts:144`,复用 `recentAggs`)。
- **现状**:前端**没消费**过 `range=week` —— 要新增一次 fetch(照 `cloud.ts` 的 `getJson` 手法)
  + `useCupData` 透传,再画一张卡(手写 SVG,同 `DrinkChart`,**不引图表库**)。
- 卡片放 `BoardView`(`dashboard/` 下新建组件,沿用现有 Card 风格 + `--color-cup-*` token)。

## B3 观感打磨(顺手,别跑偏)

- **断线 / 空态**:现在只改顶部小圆点颜色 → 做得更明显一点(仍零依赖)。
- **ChatPanel 未读点**:主动消息到、而用户在别的 tab 时,chat tab 亮一个点。

## ⚠️ 要引工具的话先问

**组件级渲染测试**需要 jsdom —— 按 **P4**,引任何依赖前**先问产品方**,别擅自加。
现状是"纯逻辑抽成函数测 + 渲染手工验",这条继续。

