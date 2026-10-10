/**
 * 饮水曲线 —— 纯 SVG 柱状图,24 小时分桶。
 *
 * 为什么手写 SVG 不引图表库:按需引入(P4)。M2 只需要一根柱图,
 * 引 echarts/recharts 是几十 KB 换三十行代码。等真需要缩放/多轴再议。
 */
import { Card } from '../ui.tsx';
import { hourlyIntake } from '../../lib/stats.ts';
import type { CupEvent } from '@cup/contract';

export function DrinkChart({ events }: { events: CupEvent[] }) {
  const buckets = hourlyIntake(events);
  const max = Math.max(60, ...buckets);

  return (
    <Card title="饮水曲线" hint="按小时 · 今日">
      <div className="flex h-32 items-end gap-0.5">
        {buckets.map((v, h) => (
          <div key={h} className="group relative flex-1" title={`${h}:00 · ${v}ml`}>
            <div
              className="w-full rounded-t bg-cup-aqua/70 transition-all group-hover:bg-cup-warm"
              style={{ height: `${(v / max) * 100}%`, minHeight: v > 0 ? 2 : 0 }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-cup-ink-soft">
        <span>0</span>
        <span>6</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
    </Card>
  );
}
