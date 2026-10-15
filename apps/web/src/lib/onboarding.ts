/**
 * 首启激活引导(优先级 3)—— 把"配对到啊哈时刻"的前几分钟说清楚。
 *
 * 问题:配对成功后新用户看到的是一整套卡片(战报/趋势/性格史/硬件脸…),但
 * **没有一样是为空的今天准备的** —— 全是空态,反而不知道该干嘛。留存命门在
 * 头 5 分钟:让他尽快看到"杯子对我有反应"这个啊哈时刻。
 *
 * 这里的"啊哈时刻"= **今天收到第一口水后的杯子反应**(水位变、表情变、后面
 * 还会解锁成长)。故引导只做三件事,按顺序推进,做到就自动退场:
 *   1. connect  —— 还没连上数据源(在连 / 断了)
 *   2. sip      —— 连上了但今天还没喝 → 请他喝一口看反应
 *   3. coach    —— 喝过了,给一句"看它反应"的收尾 + 指向看板/对话
 *
 * 纯函数:输入信号 → 该显示哪一步 + 文案;**不碰 DOM / 不读时钟**。是否已"退场"
 * (用户手动关过)由调用方持有(持久化留给组件层)。
 */

export type OnboardingStep = 'connect' | 'sip' | 'coach';

export interface OnboardingInput {
  /** 数据源状态(与 App 的 state 同义) */
  state: 'connecting' | 'open' | 'closed' | 'error' | string;
  /** 今天收到的事件数(>0 即"杯子上有动静了") */
  eventCountToday: number;
  /** 今天已喝(ml) */
  drankMl: number;
  /** 用户是否已手动关过引导(持久化在组件层) */
  dismissed: boolean;
}

export interface OnboardingView {
  /** 是否显示引导 */
  show: boolean;
  step: OnboardingStep | null;
  title: string;
  body: string;
  /** 主按钮文案;null = 无按钮(纯说明) */
  cta: string | null;
}

const HIDDEN: OnboardingView = { show: false, step: null, title: '', body: '', cta: null };

/**
 * 决策:显示哪一步。
 * - 关过 → 永不显示。
 * - 未连上 → connect(只说明,不给 CTA —— 连接是后台自己在做的)。
 * - 连上但今天没喝 → sip(主 CTA:去看杯子 / 喝一口)。
 * - 喝过了 → coach(收尾;出现一次,用户关掉即退场)。
 */
export function onboardingView(input: OnboardingInput): OnboardingView {
  if (input.dismissed) return HIDDEN;

  if (input.state !== 'open') {
    return {
      show: true,
      step: 'connect',
      title: '正在认识你的杯子',
      body: '先连上数据源 —— 连上后这里会有它的第一口记录。',
      cta: null,
    };
  }

  if (input.drankMl <= 0 && input.eventCountToday <= 0) {
    return {
      show: true,
      step: 'sip',
      title: '先喂它第一口水',
      body: '喝一口,杯子会立刻有反应:水波荡开、水位下降、眼神变化。这就是它活着的样子。',
      cta: '去看杯子',
    };
  }

  // 今天已经有动静了 —— 收尾一句,把注意力引到"它会记住"
  return {
    show: true,
    step: 'coach',
    title: '它记住了这一口',
    body: '今天的这一口已经写进它的记忆。坚持几天,它会解锁新的表情和一句话 —— 去「回忆」看看它攒下的日子。',
    cta: '知道了',
  };
}

// ── 退场持久化(与 lib/goal.ts 同款:存储不可用静默,不炸页面)──────

const LS_KEY = 'cup.onboarding.done';

/** 用户是否已关过引导。没存过 / 存储不可用 → false(仍显示)。 */
export function loadOnboardingDismissed(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === '1';
  } catch {
    return false;
  }
}

/** 记下"引导已退场"。存储不可用静默 —— 本次会话内组件仍会隐藏,只是刷新后又冒出来。 */
export function saveOnboardingDismissed(): void {
  try {
    localStorage.setItem(LS_KEY, '1');
  } catch {
    /* 隐私模式 / 配额满:忽略 */
  }
}
