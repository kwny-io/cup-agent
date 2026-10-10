/** 打卡 / 成就 —— 连续达标天数 + 今日徽章。连续天数是跨天数据,由后端 /today 给。 */
import { Card, Chip } from '../ui.tsx';
import type { TodayStats } from '../../lib/stats.ts';
import { DAILY_GOAL_ML } from '../../lib/stats.ts';

export function Streak({
  stats,
  streak,
  goal = DAILY_GOAL_ML,
}: {
  stats: TodayStats;
  /** 后端连续达标天数;null = 未接后端(显示占位) */
  streak: number | null;
  goal?: number;
}) {
  const reached = stats.intakeMl >= goal;
  return (
    <Card title="打卡" hint={streak === null ? '占位:连续天数待后端' : '连续达标'}>
      <div className="flex items-center gap-3">
        <span className="text-4xl font-black tabular-nums text-cup-warm">
          {streak === null ? '—' : streak}
        </span>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-cup-ink-soft">连续达标天数</span>
          <div className="flex gap-1">
            <Chip tone={reached ? 'warm' : 'cool'}>
              {reached ? '今日已达标 ✓' : '今日进行中'}
            </Chip>
            {stats.shakeCount > 0 && <Chip>摇了 {stats.shakeCount} 次</Chip>}
          </div>
        </div>
      </div>
    </Card>
  );
}
