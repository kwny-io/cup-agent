/**
 * 「成长」卡 —— 养成闭环(优先级 1)的可见出口,消费 `GET /cups/:id/growth`。
 *
 * 之前杯子只有"今天的脾气"(性格底色),用户看不到**跨天的成长反馈**。这张卡补的正是
 * 这个闭环:阶段在升、里程碑在解锁 —— 用户能"看见"自己和杯子一起走了多远。
 *
 * 与「回忆」卡的分工:回忆是**回头翻**(逐日 narrative);成长是**向前看进度**
 * (还差多少升阶 / 还差多少解锁)。数字全来自后端快照,前端只换算展示(见 lib/growth.ts)。
 *
 * 庆祝:后端 `celebrate` 只在**今天新跨一道坎**时非 null → 顶部出一条横幅(一次性反馈)。
 */
import { useEffect, useState } from 'react';
import { Card, Chip } from '../ui.tsx';
import {
  celebrateText,
  daysToNextStage,
  milestoneRemaining,
  STAGES,
  stageBadge,
  stageProgress,
} from '../../lib/growth.ts';
import type { Growth, Milestone, SocialApi } from '../../data/source.ts';

export function GrowthCard({ social, enabled }: { social: SocialApi | null; enabled: boolean }) {
  const [growth, setGrowth] = useState<Growth | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!enabled || !social) return;
    let alive = true;
    setLoading(true);
    void social.getGrowth().then((s) => {
      if (!alive) return;
      setGrowth(s?.growth ?? null);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [social, enabled]);

  if (!enabled || !social) {
    return (
      <Card title="成长" hint="需连后端">
        <p className="py-6 text-center text-xs text-cup-ink-soft">
          成长要看后端累积的多天数据(用 ?cloud=1 连上并登录)
        </p>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card title="成长">
        <p className="py-6 text-center text-xs text-cup-ink-soft">正在看它长到哪了…</p>
      </Card>
    );
  }

  if (!growth) {
    return (
      <Card title="成长" hint="暂无">
        <p className="py-6 text-center text-xs text-cup-ink-soft">
          还没连上后端或数据没到 —— 过会儿再试
        </p>
      </Card>
    );
  }

  const banner = celebrateText(growth);
  const nextDays = daysToNextStage(growth);

  return (
    <Card title="成长" hint={`一起第 ${growth.days_together} 天`}>
      <div className="flex flex-col gap-4">
        {/* 今天新解锁 → 一次性庆祝横幅 */}
        {banner && (
          <div
            className="rounded-2xl bg-cup-warm/20 px-3 py-2 text-center text-sm font-semibold text-cup-ember ring-1 ring-cup-warm/50"
            role="status"
          >
            🎉 {banner}
          </div>
        )}

        {/* 阶段徽标 + 升阶进度 */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Chip tone="warm">{stageBadge(growth)}</Chip>
            <span className="text-xs text-cup-ink-soft">
              {nextDays === null ? '已到顶级' : `还差 ${nextDays} 天升到「${growth.next_stage!.name}」`}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-cup-foam">
            <div
              className="h-full rounded-full bg-gradient-to-r from-cup-aqua to-cup-warm transition-[width] duration-500"
              style={{ width: `${Math.round(stageProgress(growth) * 100)}%` }}
            />
          </div>
          {/* 阶段阶梯:已达成的填色,当前的高亮 */}
          <div className="flex flex-wrap items-center gap-1">
            {STAGES.map((s) => {
              const reached = growth.days_together >= s.min_days;
              const current = s.key === growth.stage.key;
              return (
                <span
                  key={s.key}
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    current
                      ? 'bg-cup-deep text-cup-mist'
                      : reached
                        ? 'bg-cup-aqua/15 text-cup-deep'
                        : 'bg-cup-foam text-cup-ink-soft/70'
                  }`}
                >
                  {s.name}
                  {current && reached && ' ●'}
                </span>
              );
            })}
          </div>
        </div>

        {/* 里程碑阶梯 */}
        <div className="border-t border-cup-veil/60 pt-3">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-xs text-cup-ink-soft">里程碑</span>
            <span className="text-[10px] text-cup-ink-soft">
              已解锁 {growth.milestones.filter((m) => m.achieved).length} / {growth.milestones.length}
            </span>
          </div>
          <ul className="flex flex-col gap-1.5">
            {growth.milestones.map((m) => (
              <MilestoneRow key={m.id} m={m} highlight={m.id === growth.next_milestone?.id} />
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

function MilestoneRow({ m, highlight }: { m: Milestone; highlight: boolean }) {
  return (
    <li
      className={`flex items-center gap-2 rounded-xl px-2 py-1.5 ${
        m.achieved ? 'bg-cup-aqua/10' : highlight ? 'bg-white/70 ring-1 ring-cup-veil/50' : 'bg-white/40'
      }`}
    >
      <span className={`text-sm ${m.achieved ? '' : 'opacity-40 grayscale'}`} aria-hidden="true">
        {m.achieved ? '🏅' : '⬜'}
      </span>
      <span className={`flex-1 text-xs ${m.achieved ? 'text-cup-deep' : 'text-cup-ink-soft'}`}>
        {m.label}
      </span>
      {m.achieved ? (
        <span className="text-[10px] text-cup-aqua">{milestoneRemaining(m)}</span>
      ) : (
        <span className="flex items-center gap-2">
          <span className="text-[10px] text-cup-ink-soft">{milestoneRemaining(m)}</span>
          <span className="block h-1.5 w-14 overflow-hidden rounded-full bg-cup-foam">
            <span
              className="block h-full rounded-full bg-cup-warm"
              style={{ width: `${Math.round(m.progress * 100)}%` }}
            />
          </span>
        </span>
      )}
    </li>
  );
}
