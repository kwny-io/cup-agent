/** 今日概览:已喝 / 次数 / 水温 / 水位。数字优先取后端 /today,无则前端现算。 */
import { Bar, Card, Stat } from '../ui.tsx';
import { DAILY_GOAL_ML, progress } from '../../lib/stats.ts';
import type { TodayStats } from '../../lib/stats.ts';
import type { CupSnapshot } from '../../lib/stats.ts';
import {
  TEMP_ZONE_EDGES,
  TEMP_ZONE_LABEL,
  tempColor,
  tempZone,
  type TempZone,
} from '../../lib/color.ts';

/** 分区条的显示上限:再烫也压在同一个位置,不让 100℃ 把条子撑歪 */
const ZONE_MAX_C = 80;
const ZONE_ORDER: TempZone[] = ['cold', 'cool', 'comfort', 'hot', 'scalding'];

function zoneBounds(z: TempZone): [number, number] {
  const e = TEMP_ZONE_EDGES;
  if (z === 'cold') return [0, e.cool];
  if (z === 'cool') return [e.cool, e.comfort];
  if (z === 'comfort') return [e.comfort, e.hot];
  if (z === 'hot') return [e.hot, e.scalding];
  return [e.scalding, ZONE_MAX_C];
}

/**
 * 水温分区条 —— 把 tempZone 的切分直接画出来,当前温度钉在它所属的那一段上。
 * 表情/水色/腮红都认同一份 TEMP_ZONE_EDGES,这条只是让它可见。
 */
function TempZoneBar({ tempC }: { tempC: number | null }) {
  const zone = tempC === null ? null : tempZone(tempC);
  const at = tempC === null ? null : Math.min(1, Math.max(0, tempC / ZONE_MAX_C));
  return (
    <div className="mt-4">
      <div className="relative flex h-2.5 overflow-hidden rounded-full">
        {ZONE_ORDER.map((z) => {
          const [lo, hi] = zoneBounds(z);
          return (
            <div
              key={z}
              style={{
                width: `${((hi - lo) / ZONE_MAX_C) * 100}%`,
                background: tempColor((lo + hi) / 2).fill,
              }}
            />
          );
        })}
        {at !== null && (
          <span
            className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-cup-deep shadow"
            style={{ left: `${at * 100}%` }}
          />
        )}
      </div>
      {/* 标签钉在各自区段的中点 —— 区段并不等宽,用 justify-between 会错位 */}
      <div className="relative mt-1 h-4 text-[10px] text-cup-ink-soft">
        {ZONE_ORDER.map((z) => {
          const [lo, hi] = zoneBounds(z);
          const mid = ((lo + hi) / 2 / ZONE_MAX_C) * 100;
          return (
            <span
              key={z}
              className={`absolute -translate-x-1/2 whitespace-nowrap ${
                z === zone ? 'font-semibold text-cup-deep' : ''
              }`}
              style={{ left: `${mid}%` }}
            >
              {TEMP_ZONE_LABEL[z]}
            </span>
          );
        })}
      </div>
    </div>
  );
}

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
      <TempZoneBar tempC={snap.tempC} />
    </Card>
  );
}
