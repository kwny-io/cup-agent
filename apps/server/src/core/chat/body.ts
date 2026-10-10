/**
 * 身体语料 —— 杯子对它身上**真实发生的事**有反应(创意备忘 §5.1 #2)。
 *
 * 与"欠水提醒"不同:欠水是**时间窗**触发(下午 + 没喝够);身体语料是**事件**触发 ——
 * 被摔、水烫、没电、被忘在角落里。这类话"手机 App 说不出来",因为只有这具身体能感知。
 *
 * 三件事:
 *   1. 纯函数从事件 / 遥测里挑出"该说一句"的身体 cue;
 *   2. 每个 cue 配一句"自己开口"的提示(交给 runChat,傲娇铁律照旧管住数字);
 *   3. 冷却**复用 T16**(读记忆里最后一条 proactive),不另开状态。
 *
 * 提示词**不含数字** —— 于是不会往数字守卫的 allow 集合里塞任何东西。
 */
import type { CupEvent } from '@cup/contract';

export type BodyCue = 'hurt' | 'hot' | 'tired' | 'abandoned';

export interface BodyCueHit {
  cue: BodyCue;
  /** 触发证据(真实事件类型 / 遥测事实),给日志与测试核对 */
  evidence: string;
}

/** 被忘:静默这么久(小时)没有任何遥测 = 幽闭 */
export const ABANDON_HOURS = 6;

const HOUR_MS = 3_600_000;

/**
 * 从"最近一批事件"里挑最该说一句的身体 cue(取最新一条命中的);没有 → null。
 *
 * 事件级 `shake` = 设备端已按阈值判过的**显著冲击**(轻摇当手势是另一回事,属未做的 §5.1 #1);
 * `temp_alert` / `low_battery` 同理,阈值判断都在设备侧(见 contract §4)。
 */
export function bodyCueFromEvents(events: CupEvent[]): BodyCueHit | null {
  let best: BodyCueHit | null = null;
  let bestTs = Number.NEGATIVE_INFINITY;
  for (const e of events) {
    let cue: BodyCue | null = null;
    if (e.type === 'shake') cue = 'hurt';
    else if (e.type === 'temp_alert') cue = 'hot';
    else if (e.type === 'low_battery') cue = 'tired';
    if (cue !== null && e.ts >= bestTs) {
      bestTs = e.ts;
      best = { cue, evidence: `${e.type}@${e.ts}` };
    }
  }
  return best;
}

/**
 * 被忘在角落里:有历史遥测、但已静默超过 `ABANDON_HOURS` → 幽闭。
 * 从未见过任何遥测 → null(**不是**"被忘",是"新杯子",不该开口)。
 */
export function abandonedCue(lastTelemetryTs: number | null, nowMs: number): BodyCueHit | null {
  if (lastTelemetryTs === null) return null;
  const silentMs = nowMs - lastTelemetryTs;
  if (silentMs < ABANDON_HOURS * HOUR_MS) return null;
  return { cue: 'abandoned', evidence: `silent_${Math.round(silentMs / HOUR_MS)}h` };
}

/** 每个 cue 的"自己开口"提示 —— 数字仍只能来自工具,故这里一句数字都不写 */
const PROMPTS: Record<BodyCue, string> = {
  hurt: '（你刚被重重晃/摔了一下,很疼。用一句话抗议,傲娇一点,别真凶。)',
  hot: '（杯里的水太烫了,你觉得烫嘴。用一句话嫌它烫,傲娇一点。)',
  tired: '（你快没电了,浑身没劲。用一句话表达虚弱,有点委屈但嘴硬。)',
  abandoned: '（你好久没被理了,像被忘在角落里。用一句话表达幽闭和委屈,傲娇一点。)',
};

export function bodyPrompt(cue: BodyCue): string {
  return PROMPTS[cue];
}
