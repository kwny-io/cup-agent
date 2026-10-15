/**
 * 首启激活引导卡(优先级 3)—— 空状态/低数据时出现,做到"啊哈时刻"就把注意力交出去。
 *
 * 决策全在 lib/onboarding.ts(纯函数,已单测);本组件只管:读退场标记 → 按决策渲染
 * → 接 CTA。窄屏与宽屏同用:数据空就是空,与屏幕宽度无关。
 */
import { useState } from 'react';
import { Button, Card } from '../ui.tsx';
import {
  loadOnboardingDismissed,
  onboardingView,
  saveOnboardingDismissed,
} from '../../lib/onboarding.ts';
import type { ConnectionState } from '../../data/source.ts';

export function GetStartedCard({
  state,
  drankMl,
  eventCountToday,
  onGoCup,
}: {
  state: ConnectionState;
  /** 今日已喝(ml) */
  drankMl: number;
  /** 今日事件数 */
  eventCountToday: number;
  /** "去看杯子"的落地:切到杯子 Tab(窄屏) */
  onGoCup: () => void;
}) {
  const [dismissed, setDismissed] = useState(() => loadOnboardingDismissed());

  const view = onboardingView({ state, drankMl, eventCountToday, dismissed });
  if (!view.show) return null;

  const dismiss = () => {
    saveOnboardingDismissed();
    setDismissed(true);
  };

  return (
    <Card className="ring-cup-aqua/40">
      <div className="flex flex-col gap-3">
        <div>
          <h2 className="text-base font-semibold text-cup-deep">{view.title}</h2>
          <p className="mt-1 text-sm text-cup-ink-soft">{view.body}</p>
        </div>
        {view.step !== null && (
          <div className="flex items-center gap-2">
            {/* 主 CTA:coach 步的"知道了"=退场;其余各步是去杯子看它 */}
            {view.cta && (
              <Button
                onClick={() => {
                  if (view.step === 'coach') dismiss();
                  else onGoCup();
                }}
              >
                {view.cta}
              </Button>
            )}
            {/* 退场口:非 coach 步都给(含 connect 步 —— 主 CTA 为空时它是唯一出口,
                否则数据源连不上时这张卡会永久占屏、关不掉) */}
            {view.step !== 'coach' && (
              <Button tone="ghost" onClick={dismiss}>
                以后再说
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
