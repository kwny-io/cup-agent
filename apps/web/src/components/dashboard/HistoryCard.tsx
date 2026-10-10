/**
 * 历史战报 —— 逐日回看卡(消费后端 `GET /cups/:id/report/history`)。
 *
 * 与今日战报卡的分工:那张是**当下**一条(带长期性格、可被 LLM 润色);
 * 这张是**过去几天**的逐日清单 —— 后端只回**有数据的日子**(没喝的日子不占位),
 * 新→旧,每天一句模板 headline。前端**只展示不造句**:文案与数字都来自后端。
 *
 * 无后端源(直连模拟器 / mock)时 series/history 都是 null → 显示空态,
 * 不编一份假历史(与 WeekTrend 同策略)。
 */
import { Card } from '../ui.tsx';
import { dayLabel, dayProgress, isToday, summarize } from '../../lib/history.ts';
import type { ServerHistory } from '../../data/source.ts';

/** 本地日键(YYYY-MM-DD),与后端 dayKey 同一口径(浏览器本地时区) */
function todayKey(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function HistoryCard({ history }: { history: ServerHistory | null }) {
  const days = history?.days ?? [];
  const sum = summarize(history);
  const today = todayKey();

  return (
    <Card
      title="历史战报"
      hint={
        history
          ? history.count > 0
            ? `${sum.days} 天有记录 · 达标 ${sum.hitDays} 天 · 合计 ${sum.totalMl} ml`
            : '暂无记录'
          : '需连后端'
      }
    >
      {days.length === 0 ? (
        <p className="py-8 text-center text-xs text-cup-ink-soft">
          连上后端(?cloud=1)才有历史;没喝的日子不会出现在这里
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {days.map((d) => (
            <HistoryRow key={d.date} day={d} today={isToday(d.date, today)} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function HistoryRow({
  day,
  today,
}: {
  day: ServerHistory['days'][number];
  today: boolean;
}) {
  const pct = dayProgress(day);
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-cup-ink">
          {dayLabel(day.date)}
          {today && (
            <span className="rounded-full bg-cup-aqua/20 px-1.5 py-0.5 text-[10px] text-cup-deep">
              今天
            </span>
          )}
        </span>
        <span
          className={`text-xs tabular-nums ${
            day.reached_goal ? 'text-cup-ember' : 'text-cup-ink-soft'
          }`}
        >
          {day.drank_ml}/{day.goal_ml} ml
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-cup-foam">
        <div
          className={`h-full rounded-full ${day.reached_goal ? 'bg-cup-warm' : 'bg-cup-aqua/70'}`}
          style={{ width: `${Math.round(pct * 100)}%` }}
        />
      </div>
      <p className="text-xs leading-relaxed text-cup-ink-soft">{day.headline}</p>
    </li>
  );
}
