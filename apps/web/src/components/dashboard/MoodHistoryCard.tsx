/**
 * 脾气变化史 —— 「杯子这几天心情怎么变的」时间线卡(消费后端 `GET /cups/:id/personality/history`)。
 *
 * 创意备忘 §5.1 #3「养成卡」的**只读半**:把"我养出了一只什么脾气的杯子"摆上屏。
 * 与历史战报卡的分工:那张看**喝水量**逐日;这张看**长期性格**逐日(蔫/平常/得意)。
 * 后端只回**有数据的日子**、旧→新;前端**只展示不造句** —— 心情是后端 computePersonality 逐日切出来的。
 *
 * 无后端源(直连模拟器 / mock)时 personality 为 null → 显示空态,不编一条假时间线。
 */
import { Card } from '../ui.tsx';
import {
  dispositionBlurb,
  dispositionDot,
  dispositionLabel,
  dispositionTone,
  dispositionWeight,
  moodTrend,
  summarizeMood,
  trendLabel,
} from '../../lib/mood-history.ts';
import { dayLabel } from '../../lib/history.ts';
import type { ServerPersonalityHistory } from '../../data/source.ts';

export function MoodHistoryCard({ personality }: { personality: ServerPersonalityHistory | null }) {
  const days = personality?.days ?? [];
  const sum = summarizeMood(personality);
  const trend = moodTrend(personality);

  return (
    <Card
      title="脾气变化史"
      hint={
        personality
          ? sum.days > 0
            ? `${sum.days} 天有记录 · 得意 ${sum.smug} / 平常 ${sum.normal} / 蔫 ${sum.sulky}`
            : '暂无记录'
          : '需连后端'
      }
    >
      {days.length === 0 ? (
        <p className="py-8 text-center text-xs text-cup-ink-soft">
          连上后端(?cloud=1)才有脾气变化史;没喝的日子不会在这里占位
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {/* 顶部:趋势 + 得意连击 —— 养成卡最想让用户看到的两个数 */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-cup-ink-soft">{trendLabel(trend)}</span>
            {sum.smugStreak > 0 && (
              <span className="rounded-full bg-cup-ember/15 px-2 py-0.5 text-[11px] font-medium text-cup-ember">
                连着得意 {sum.smugStreak} 天
              </span>
            )}
          </div>

          {/* 时间线:旧→新,左到右。柱高按心情权重,色按心情 */}
          <ol className="flex items-end gap-1.5" aria-label="逐日心情">
            {days.map((d) => (
              <li key={d.date} className="flex flex-1 flex-col items-center gap-1">
                <div className="flex h-12 w-full items-end justify-center">
                  <span
                    className={`w-full rounded-t ${dispositionDot(d.disposition)}`}
                    style={{ height: `${Math.round(dispositionWeight(d.disposition) * 100)}%` }}
                    title={dispositionBlurb(d.disposition)}
                  />
                </div>
                <span className={`text-[10px] leading-none ${dispositionTone(d.disposition)}`}>
                  {dispositionLabel(d.disposition)}
                </span>
              </li>
            ))}
          </ol>

          {/* 日期轴:只标首尾,免得天数多时糊成一片(与 WeekTrend 同策略) */}
          <div className="flex justify-between text-[10px] text-cup-ink-soft">
            <span>{dayLabel(days[0]!.date)}</span>
            {days.length > 1 && <span>{dayLabel(days[days.length - 1]!.date)}</span>}
          </div>
        </div>
      )}
    </Card>
  );
}
