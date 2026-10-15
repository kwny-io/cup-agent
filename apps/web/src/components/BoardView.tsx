/** 看板容器 —— 把各卡片拼起来。数据从 props 进,不自己取数。 */
import { TodayPanel } from './dashboard/TodayPanel.tsx';
import { DrinkChart } from './dashboard/DrinkChart.tsx';
import { TempChart } from './dashboard/TempChart.tsx';
import { Streak } from './dashboard/Streak.tsx';
import { ReportCard } from './dashboard/ReportCard.tsx';
import { WeekTrend } from './dashboard/WeekTrend.tsx';
import { HistoryCard } from './dashboard/HistoryCard.tsx';
import { MoodHistoryCard } from './dashboard/MoodHistoryCard.tsx';
import { GoalCard } from './dashboard/GoalCard.tsx';
import { DrinkBuckets } from './dashboard/DrinkBuckets.tsx';
import { GetStartedCard } from './dashboard/GetStartedCard.tsx';
import { ChatPanel } from './ChatPanel.tsx';
import { EyePreview } from './EyePreview.tsx';
import { PowerPanel } from './PowerPanel.tsx';
import { DAILY_GOAL_ML, todayStats, snapshot, isToday } from '../lib/stats.ts';
import type { TodayStats } from '../lib/stats.ts';
import type { ChatController } from '../data/useChat.ts';
import type {
  ConnectionState,
  GoalResult,
  LiveFrame,
  PersonaPack,
  ServerHistory,
  ServerPersonalityHistory,
  ServerReport,
  ServerSeries,
  ServerToday,
} from '../data/source.ts';
import type { CupEvent } from '@cup/contract';

export function Dashboard({
  frame,
  events,
  state = 'open',
  server,
  report,
  series,
  history,
  personality,
  daySeries = null,
  goal,
  setGoal,
  chat,
  showChat = false,
  disposition = 'normal',
  pack = null,
  onGoCup,
}: {
  frame: LiveFrame | null;
  events: CupEvent[];
  /** 连接状态;喂给首启引导(未连上时它先教"等连上") */
  state?: ConnectionState;
  /** 后端今日快照;有则用它当"官方数字",否则回退前端现算(M2 行为) */
  server: ServerToday | null;
  /** 后端每日战报;有则战报卡显示后端文案 + 长期性格 */
  report: ServerReport | null;
  /** 后端近 7 天趋势;null(无后端源)= 卡片显示空态 */
  series?: ServerSeries | null;
  /** 后端今日 24 小时分桶(饮水曲线用);null(无后端源)= 曲线回退前端现算 */
  daySeries?: ServerSeries | null;
  /** 后端历史战报(逐日回看);null(无后端源)= 卡片显示空态 */
  history?: ServerHistory | null;
  /** 后端脾气变化史(逐日长期性格);null(无后端源)= 卡片显示空态 */
  personality?: ServerPersonalityHistory | null;
  /** 当前每日目标(由 App 统一持有,改一次所有卡联动);缺省回落约定默认 */
  goal?: number;
  /** 改目标;null = 该源不支持(纯模拟器) */
  setGoal?: ((goalMl: number) => Promise<GoalResult>) | null;
  /** 对话控制器(上提自 App);null 则不出对话卡 */
  chat?: ChatController | null;
  /** 宽屏看板才内嵌对话卡;窄屏对话走独立 Tab,避免重复 */
  showChat?: boolean;
  /** 长期性格底色(后端战报给),喂给盖眼预览 */
  disposition?: 'sulky' | 'normal' | 'smug';
  /** 当前生效人格包(P4.2);null → 出厂体质。透传给盖眼预览改表情阈值 */
  pack?: PersonaPack | null;
  /** 首启引导里"去看杯子"的落地(窄屏切 Tab);缺省则引导按钮不切视图 */
  onGoCup?: () => void;
}) {
  // 前端现算:够看交互量(续水/摇杯/报警),但"今日量 / 连续天数"以跨天聚合为准
  const fromEvents = todayStats(events);
  const stats: TodayStats = server
    ? {
        ...fromEvents,
        intakeMl: server.drank_ml,
        drinkCount: server.drink_count,
        tempMin: server.temp_min_c ?? fromEvents.tempMin,
        tempMax: server.temp_max_c ?? fromEvents.tempMax,
      }
    : fromEvents;
  const g = goal ?? server?.goal_ml ?? DAILY_GOAL_ML;
  const snap = snapshot(frame?.lid, frame?.base);
  // 首启引导的输入:今天有没有动静(以事件数为准,与统计口径一致)
  const now = Date.now();
  const eventCountToday = events.reduce((n, e) => (isToday(e.ts, now) ? n + 1 : n), 0);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4">
      <GetStartedCard
        state={state}
        drankMl={stats.intakeMl}
        eventCountToday={eventCountToday}
        onGoCup={onGoCup ?? (() => {})}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TodayPanel stats={stats} snap={snap} goal={g} />
        <Streak stats={stats} streak={server?.streak ?? null} goal={g} />
      </div>
      <GoalCard goal={g} onSave={setGoal ?? null} />
      <section className="rounded-2xl bg-white/70 p-4 ring-1 ring-cup-veil/50">
        <h2 className="mb-3 text-sm font-semibold text-cup-deep">杯盖双眼(硬件脸预览)</h2>
        <div className="flex justify-center">
          <EyePreview lid={frame?.lid} base={frame?.base} events={events} disposition={disposition} pack={pack} />
        </div>
      </section>
      <section className="rounded-2xl bg-white/70 p-4 ring-1 ring-cup-veil/50">
        <h2 className="mb-3 text-sm font-semibold text-cup-deep">硬件脸功耗估算(选型参考)</h2>
        <PowerPanel />
      </section>
      <DrinkBuckets events={events} />
      <DrinkChart events={events} daySeries={daySeries} />
      <TempChart events={events} />
      <WeekTrend series={series ?? null} goal={g} />
      <HistoryCard history={history ?? null} />
      <MoodHistoryCard personality={personality ?? null} />
      <ReportCard stats={stats} goal={g} report={report} />
      {showChat && chat && <ChatPanel chat={chat} />}
    </div>
  );
}
