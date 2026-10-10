/**
 * 每日战报 —— 性格层的出口(M4)。
 *
 * 两种数据来源,优先级如下:
 *   1. 后端战报(report !== null):文案、性格、数字都由后端给,**原样显示**。
 *      这也是 LLM 润色的出口(source==='llm'),前端不参与造句。
 *   2. 本地模板(report 为 null,如直连模拟器 / mock):用今日真实数字拼一句,
 *      与后端模板**同一套语气**(傲娇宠物 D1),保证画面永不空白。
 *
 * 关键:文案里的数字一律来自真实统计,前端不编(对应后端验收 2)。
 */
import { Card } from '../ui.tsx';
import { DAILY_GOAL_ML } from '../../lib/stats.ts';
import type { TodayStats } from '../../lib/stats.ts';
import type { ServerReport } from '../../data/source.ts';

/** 长期性格 → 一句人话标签(卡片右上角的小徽标) */
const DISPOSITION_LABEL: Record<ServerReport['disposition'], string> = {
  smug: '得意',
  normal: '平常',
  sulky: '闹别扭',
};

export function ReportCard({
  stats,
  goal = DAILY_GOAL_ML,
  report = null,
}: {
  stats: TodayStats;
  goal?: number;
  /** 后端战报;有则优先展示(含 LLM 润色文案),无则回退本地模板 */
  report?: ServerReport | null;
}) {
  // 后端来了就用后端的数字骨架(它是唯一数字来源);否则用前端现算的 stats
  const amount = report?.facts.drank_ml ?? stats.intakeMl;
  const drinkCount = report?.facts.drink_count ?? stats.drinkCount;
  const p = goal > 0 ? amount / goal : 0;

  const line =
    report?.headline ??
    (drinkCount === 0
      ? '今天一口都没喝……杯子在角落里看你。'
      : p >= 1
        ? `喝了 ${amount}ml,达标啦,今天的你很水灵。`
        : p >= 0.5
          ? `已经 ${amount}ml,过半了,再冲一冲。`
          : `才 ${amount}ml,杯子有点渴。`);

  const tempMin = report?.facts.temp_min_c ?? stats.tempMin;
  const tempMax = report?.facts.temp_max_c ?? stats.tempMax;

  return (
    <Card
      title="今日战报"
      hint={report ? '后端性格层' : '本地模板(M4 待接)'}
      action={
        report ? (
          <span className="rounded-full bg-cup-deep/10 px-2 py-0.5 text-[11px] text-cup-deep">
            {DISPOSITION_LABEL[report.disposition]}
            {report.source === 'llm' ? ' · LLM' : ''}
          </span>
        ) : undefined
      }
    >
      <p className="text-sm leading-relaxed text-cup-ink">{line}</p>
      {tempMax !== null && (
        <p className="mt-2 text-xs text-cup-ink-soft">
          水温 {Math.round(tempMin ?? 0)}–{Math.round(tempMax)}°C ·
          喝水 {drinkCount} 次 · 续水 {stats.refillCount} 次
        </p>
      )}
    </Card>
  );
}
