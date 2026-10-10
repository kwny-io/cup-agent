/**
 * 杯量分档 —— 把今天的单次喝水量按档展示(小口/小杯/中杯/大杯/豪饮)。
 *
 * 与其余卡的分工:TodayPanel 是"喝了多少",这张是"怎么喝的"(次数分布)。
 * 手写 SVG 横向柱,风格对齐 WeekTrend(同色板/token),不引图表库(按需引入,P4)。
 * 分档逻辑在 lib/buckets.ts,本卡只画。
 */
import { Card } from '../ui.tsx';
import { drinkBuckets } from '../../lib/buckets.ts';
import type { CupEvent } from '@cup/contract';

export function DrinkBuckets({ events }: { events: CupEvent[] }) {
  const { bands, totalCount, totalMl } = drinkBuckets(events);
  // 横向柱以"次数最多的一档"为满格;全空时给 1 防除零
  const peak = Math.max(1, ...bands.map((b) => b.count));

  return (
    <Card
      title="杯量分档"
      hint={totalCount > 0 ? `今日 ${totalCount} 次 · ${totalMl} ml` : '今日暂无喝水记录'}
    >
      <ul className="flex flex-col gap-2">
        {bands.map((b) => (
          <li key={b.key} className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-xs text-cup-ink-soft" title={`${b.label} ${b.range} ml`}>
              {b.label}
            </span>
            <span className="relative h-5 flex-1">
              <svg viewBox="0 0 100 10" preserveAspectRatio="none" className="h-full w-full" aria-hidden="true">
                <rect x={0} y={0} width={100} height={10} rx={2} className="fill-cup-foam" />
                <rect
                  x={0}
                  y={0}
                  width={(b.count / peak) * 100}
                  height={10}
                  rx={2}
                  className={b.count > 0 ? 'fill-cup-aqua' : 'fill-transparent'}
                />
              </svg>
              <span className="absolute inset-y-0 left-2 flex items-center text-[10px] font-medium text-cup-deep">
                {b.range}
              </span>
            </span>
            <span className="w-16 shrink-0 text-right text-xs tabular-nums text-cup-ink">
              {b.count} 次
            </span>
          </li>
        ))}
      </ul>
      {totalCount === 0 && (
        <p className="mt-2 text-center text-xs text-cup-ink-soft">喝一口就出现在这里</p>
      )}
    </Card>
  );
}
