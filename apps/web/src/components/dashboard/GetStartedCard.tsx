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
        {view.cta && (
          <div className="flex items-center gap-2">
            <Button
              onClick={() => {
                // coach 步的"知道了"=退场;此前各步的主 CTA 是去杯子看它
                if (view.step === 'coach') dismiss();
                else onGoCup();
              }}
            >
              {view.cta}
            </Button>
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
