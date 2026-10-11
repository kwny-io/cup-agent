/**
 * 近 7 天趋势 —— 手写 SVG 柱图,消费后端 `/series?range=week` 的日聚合。
 *
 * 与 DrinkChart 的分工:那张是**今天**按小时的现算曲线,这张是**跨天**的
 * 后端日聚合。同样不引图表库(按需引入,P4),7 根柱子不值得拉进 echarts。
 */
import { Card } from '../ui.tsx';
import type { ServerSeries } from '../../data/source.ts';

/** 达标线参考:后端每桶没有独立 goal,用约定日目标(与 DAILY_GOAL_ML 一致) */
const GOAL_ML = 1500;

export function WeekTrend({ series, goal = GOAL_ML }: { series: ServerSeries | null; goal?: number }) {
  const buckets = series?.buckets ?? [];
  // 纵轴上限:至少到目标线,免得达标线跑出画布;再给 15% 余量
  const max = Math.max(goal, ...buckets.map((b) => b.drank_ml)) * 1.15 || 1;
  const total = buckets.reduce((s, b) => s + b.drank_ml, 0);
  const hitDays = buckets.filter((b) => b.drank_ml >= goal).length;

  return (
    <Card
      title="近 7 天趋势"
      hint={series ? `合计 ${total} ml · 达标 ${hitDays} 天` : '需连后端'}
    >
      {buckets.length === 0 ? (
        <p className="py-8 text-center text-xs text-cup-ink-soft">
          连上后端(?cloud=1)才有跨天趋势
        </p>
      ) : (
        <WeekBars buckets={buckets} max={max} goal={goal} />
      )}
    </Card>
  );
}

function WeekBars({
  buckets,
  max,
  goal,
}: {
  buckets: ServerSeries['buckets'];
  max: number;
  goal: number;
}) {
  // 用 viewBox 画,交给 CSS 定宽,天然自适应
  const W = 700;
  const H = 150;
  const padX = 8;
  const padTop = 8;
  const padBottom = 22;
  const plotH = H - padTop - padBottom;
  const bw = (W - padX * 2) / buckets.length;
  const y = (v: number) => padTop + plotH * (1 - v / max);
  const goalY = y(goal);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full" role="img" aria-label="近 7 天饮水趋势">
      {/* 达标参考线(虚线) */}
      <line
        x1={padX}
        x2={W - padX}
        y1={goalY}
        y2={goalY}
        className="stroke-cup-warm/50"
        strokeWidth={1}
        strokeDasharray="4 4"
      />
      <text x={W - padX} y={goalY - 3} textAnchor="end" className="fill-cup-ink-soft text-[10px]">
        目标 {goal}
      </text>

      {buckets.map((b, i) => {
        const x = padX + i * bw;
        const barW = bw * 0.56;
        const cx = x + bw / 2;
        const barH = Math.max(0, plotH * (b.drank_ml / max));
        const reached = b.drank_ml >= goal;
        return (
          <g key={b.ts}>
            <rect
              x={cx - barW / 2}
              y={padTop + plotH - barH}
              width={barW}
              height={barH}
              rx={3}
              className={reached ? 'fill-cup-warm' : 'fill-cup-aqua/70'}
            >
              <title>{`${b.label} · ${b.drank_ml}ml`}</title>
            </rect>
            <text
              x={cx}
              y={H - 8}
              textAnchor="middle"
              className="fill-cup-ink-soft text-[10px]"
            >
              {b.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
