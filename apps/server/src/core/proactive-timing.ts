/**
 * 主动开口的「时机」模型(优先级 3)—— 决定"什么时候该它先说话"。
 *
 * 背景:此前开口是**一条硬规则**(下午 14–18 点 + 欠水 <50% + 固定 2h 冷却)。
 * 那条规则不会学:你说它啰嗦它照说,你三天不理它也不改。这里把"时机"抽成
 * **纯函数 + 可调常量**,核心两件事——
 *
 *   · **说多了会烦 → 自适应退避:** 连着几次主动开口都没被回应(用户在下面没有
 *     任何 user 轮),下次就等更久(`BASE + 每次无视 +1h`,封顶 6h)。一旦用户
 *     回过一次,立刻回到基准冷却。
 *   · **说少了会淡 → 不打扰但也不缺席:** 用户**刚刚**在说话(3 分钟内)时不插嘴
 *     (他正聊着,别叠话);**刚喝过**(30 分钟内)时也先按住,别"你才喝完又催"。
 *
 * 全函数(输入即决策,不碰 store / 不读时钟),常量集中便于调参 + 单测钉死。
 * 调度器(proactive.ts)只负责取输入、喂进来、按结果执行。
 */

/** 该喝水的本地时段(含端点) */
export const SPEAK_HOUR_FROM = 14;
export const SPEAK_HOUR_TO = 18;
/** 喝得不足目标这个比例就该提醒 */
export const THIRSTY_RATIO = 0.5;
/** 基准冷却:一次开口后至少隔这么久 */
export const BASE_COOLDOWN_MS = 2 * 3_600_000;
/** 每被连续无视一次,冷却延长这么多 */
export const BACKOFF_PER_IGNORE_MS = 3_600_000;
/** 冷却上限(再无视也不再拉长) */
export const MAX_COOLDOWN_MS = 6 * 3_600_000;

/** 用户开口后多久内触发算"被回应了"(engagement 判定窗) */
export const ENGAGE_WINDOW_MS = 10 * 60_000;
/** 用户刚说过话多久内不插嘴(别叠话) */
export const USER_NOTCH_MS = 3 * 60_000;
/** 刚喝过多久内先按住(别"才喝完又催") */
export const JUST_DRANK_QUIET_MS = 30 * 60_000;
/** 回溯多少次最近主动开口来算"连续被无视" */
export const LOOKBACK_PROACTIVE = 5;

/** 判定所需的一轮(只需 role + ts,不绑具体 ChatStore 实现) */
export interface TimingTurn {
  role: 'user' | 'assistant' | 'proactive';
  ts: number;
}

export interface TimingInput {
  nowMs: number;
  /** 本地小时(0–23),调用方按本地时区算好传进来 */
  hour: number;
  /** 今日喝水(ml)与目标(ml) */
  drankMl: number;
  goalMl: number;
  /** 今日事件数(没数据不硬找话) */
  eventCount: number;
  /** 最近对话轮(旧→新);用于"被无视"与"刚聊过" */
  recentTurns: TimingTurn[];
  /** 今天最近一次喝水事件的时刻;没有 → null */
  lastDrinkTs: number | null;
}

/** 开口与否 + 为什么(理由进日志,便于回看"它当时为什么没说") */
export interface TimingDecision {
  speak: boolean;
  reason: string;
  /** 本次开口后应等待多久(仅 speak 时有意义);不开口时给 0 */
  cooldownMs: number;
}

/**
 * 最近**连续多少次**主动开口没被回应(旧口径:一被回应就归零)。
 * 从最新一条 proactive 往回走,每一条看它之后 `ENGAGE_WINDOW_MS` 内有没有 user 轮;
 * 有 → 停(该次算被回应);无 → +1 继续看上一次。最多看 `LOOKBACK_PROACTIVE` 条。
 */
export function ignoredStreak(turns: TimingTurn[]): number {
  let streak = 0;
  for (let i = turns.length - 1; i >= 0 && streak < LOOKBACK_PROACTIVE; i--) {
    const t = turns[i]!;
    if (t.role !== 'proactive') continue;
    const engaged = turns.some(
      (u) => u.role === 'user' && u.ts > t.ts && u.ts <= t.ts + ENGAGE_WINDOW_MS,
    );
    if (engaged) break;
    streak++;
  }
  return streak;
}

/** 按"被无视次数"算自适应冷却:基准 + 每次无视 +1h,封顶 MAX */
export function cooldownMsFor(turns: TimingTurn[]): number {
  const ms = BASE_COOLDOWN_MS + ignoredStreak(turns) * BACKOFF_PER_IGNORE_MS;
  return Math.min(ms, MAX_COOLDOWN_MS);
}

/** 最近一条 proactive 的时刻;没有 → 0 */
function lastProactiveTs(turns: TimingTurn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.role === 'proactive') return turns[i]!.ts;
  }
  return 0;
}

/** 最近一条 user 轮的时刻;没有 → 0 */
function lastUserTs(turns: TimingTurn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.role === 'user') return turns[i]!.ts;
  }
  return 0;
}

/**
 * 决策:该不该主动开口,以及为什么。判定顺序即优先级 —— 前面的不满足直接短路,
 * `reason` 记第一个挡下的理由(便于日志回看)。
 */
export function decideSpeak(input: TimingInput): TimingDecision {
  const no = (reason: string): TimingDecision => ({ speak: false, reason, cooldownMs: 0 });

  if (input.hour < SPEAK_HOUR_FROM || input.hour > SPEAK_HOUR_TO) return no('out-of-window');
  if (input.eventCount === 0) return no('no-data');
  if (!(input.goalMl > 0)) return no('no-goal');
  if (!(input.drankMl < THIRSTY_RATIO * input.goalMl)) return no('not-thirsty');

  // 不打扰:用户刚在说话,别叠话
  const lu = lastUserTs(input.recentTurns);
  if (lu > 0 && input.nowMs - lu < USER_NOTCH_MS) return no('user-just-spoke');
  // 刚喝过:先按住,别"才喝完又催"
  if (input.lastDrinkTs !== null && input.nowMs - input.lastDrinkTs < JUST_DRANK_QUIET_MS) {
    return no('just-drank');
  }

  const cooldownMs = cooldownMsFor(input.recentTurns);
  const lp = lastProactiveTs(input.recentTurns);
  if (lp > 0 && input.nowMs - lp < cooldownMs) return no('cooldown');

  return { speak: true, reason: ignoredStreak(input.recentTurns) > 0 ? 'backoff-elapsed' : 'due', cooldownMs };
}
