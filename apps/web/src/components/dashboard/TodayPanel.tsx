/** 今日概览:已喝 / 次数 / 水温 / 水位。数字优先取后端 /today,无则前端现算。 */
import { Bar, Card, Stat } from '../ui.tsx';
import { DAILY_GOAL_ML, progress } from '../../lib/stats.ts';
import type { TodayStats } from '../../lib/stats.ts';
import type { CupSnapshot } from '../../lib/stats.ts';

export function TodayPanel({
  stats,
  snap,
  goal = DAILY_GOAL_ML,
}: {
  stats: TodayStats;
  snap: CupSnapshot;
  goal?: number;
}) {
  const p = progress(stats.intakeMl, goal);
  return (
    <Card title="今日" hint={`目标 ${goal} ml`}>
      <div className="mb-3 flex items-end justify-between">
        <Stat label="已喝" value={stats.intakeMl} unit="ml" accent />
        <span className="text-sm text-cup-ink-soft">
          {Math.round(p * 100)}%
        </span>
      </div>
      <Bar value={p} />
      <div className="mt-4 grid grid-cols-3 gap-3">
        <Stat label="喝水" value={stats.drinkCount} unit="次" />
        <Stat label="续水" value={stats.refillCount} unit="次" />
        <Stat
          label="水温"
          value={snap.tempC === null ? '—' : Math.round(snap.tempC)}
          unit="°C"
        />
      </div>
    </Card>
  );
}
