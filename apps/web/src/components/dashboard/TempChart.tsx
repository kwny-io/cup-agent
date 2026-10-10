/** 水温变化 —— 手写 SVG 折线,取今日携带温度的事件点。 */
import { Card } from '../ui.tsx';
import { isToday } from '../../lib/stats.ts';
import type { CupEvent } from '@cup/contract';

interface Pt {
  ts: number;
  t: number;
}

export function TempChart({ events }: { events: CupEvent[] }) {
  const pts: Pt[] = events
    .filter((e) => e.temp_c !== undefined && isToday(e.ts))
    .map((e) => ({ ts: e.ts, t: e.temp_c as number }));

  if (pts.length < 2) {
    return (
      <Card title="水温" hint="今日">
        <p className="py-6 text-center text-sm text-cup-ink-soft">
          今天还没有足够的水温数据
        </p>
      </Card>
    );
  }

  const W = 300;
  const H = 90;
  const lo = Math.min(...pts.map((p) => p.t)) - 3;
  const hi = Math.max(...pts.map((p) => p.t)) + 3;
  const span = Math.max(1, hi - lo);
  const x = (i: number) => (i / (pts.length - 1)) * W;
  const y = (t: number) => H - ((t - lo) / span) * H;
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.t).toFixed(1)}`).join(' ');
  const tMin = Math.round(Math.min(...pts.map((p) => p.t)));
  const tMax = Math.round(Math.max(...pts.map((p) => p.t)));

  return (
    <Card title="水温" hint={`${tMin}–${tMax}°C`}>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-24 w-full overflow-visible">
        <defs>
          <linearGradient id="tempFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-cup-warm)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--color-cup-aqua)" stopOpacity="0.05" />
          </linearGradient>
        </defs>
        <path d={`${d} L${W},${H} L0,${H} Z`} fill="url(#tempFill)" />
        <path d={d} fill="none" stroke="var(--color-cup-aqua)" strokeWidth="2" strokeLinecap="round" />
        {pts.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.t)} r="2" fill="var(--color-cup-deep)" />
        ))}
      </svg>
    </Card>
  );
}
