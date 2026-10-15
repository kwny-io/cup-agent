/**
 * 主动开口(P5)—— 杯子在特定时机自己找话说。
 *
 * **"时机"判定已抽成纯函数 `proactive-timing.ts`**(优先级 3):本调度器只负责取输入、
 * 喂进 `decideSpeak`、按结果执行,不再自己持有硬规则。模型那边要满足的关键条件是:
 *   1. 本地时间在该喝水的窗口(`SPEAK_HOUR_FROM..TO`)
 *   2. 今天喝得不足目标一半
 *   3. 今天至少有一条事件(没数据的杯子不硬找话)
 *   4. **自适应冷却**:基准 2h,连着被无视每次 +1h(封顶 6h),被回应即回基准
 *   5. **不打扰让位**:用户刚在说话(3min 内)/ 刚喝过(30min 内)都不插嘴
 *
 * 冷却怎么记:**读对话记忆里最后一条 role:'proactive',不另开状态** ——
 * 于是"重启存活"是免费的:FileChatStore 把 proactive 轮也落盘了,重启后冷却仍在。
 *
 * 说话走 runChat(带主动提示词);模型缺席 / 出错 / 守卫拦下 → runChat 内部
 * 已经回退成确定性模板句,所以这里拿到的永远是一句带真实数字的话,不空泡。
 *
 * 同一趟巡检里还顺带推进**画像蒸馏**(distill.ts):攒够新对话轮就把它们归纳成长期画像。
 * 无模型时蒸馏阈值不可达,这块自然休眠 —— 不白跑。
 */
import type { Store } from '../store/store.ts';
import { dayKey, dayStart } from '../store/store.ts';
import { cooldownMsFor, decideSpeak, type TimingTurn } from './proactive-timing.ts';
import type { CommandQueue } from './commands.ts';
import type { ChatLlm, ChatAnswer, LogFn } from './chat/types.ts';
import type { ChatStore } from './chat/memory.ts';
import { runChat } from './chat/agent.ts';
import { distillProfile } from './chat/distill.ts';
import { BODY_PROMPT_INTRO } from './chat/prompt.ts';
import { maybeCloseDay } from './memory-cards.ts';
import { abandonedCue, bodyCueFromEvents, bodyPrompt, type BodyCue, type BodyCueHit } from './chat/body.ts';
import { getTool, type ToolCtx } from './chat/tools.ts';
import type { LiveHub } from '../api/live.ts';

/** 夜间静默:身体语料是**事件**触发(不分时段),但半夜 3 点被碰一下不该吵醒主人 */
const QUIET_FROM = 22;
const QUIET_TO = 7;
/** 巡检间隔 */
const TICK_MS = 60_000;

/** 身体语料这一句的"用户轮"文本:身份前缀 + 具体身体感受(**两段都不含数字**) */
function bodyQuestion(cue: BodyCue): string {
  return `${BODY_PROMPT_INTRO}\n${bodyPrompt(cue)}`;
}

export interface ProactiveDeps {
  store: Store;
  commands: CommandQueue;
  chat: ChatLlm;
  memory: ChatStore;
  live: LiveHub;
  log: LogFn;
  /** 要照看的杯子(单机 MVP 通常一个) */
  cups: () => string[];
  now?: () => number;
  /** 画像蒸馏阈值(自上次蒸馏后新增多少轮才再蒸);缺省用 distill.ts 的默认值 */
  minNewTurns?: number;
}

export class ProactiveScheduler {
  private readonly deps: ProactiveDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 每杯最后一次"天翻页"已封到的日子 —— 免得同一张记忆卡被反复 UPSERT(见 memory-cards.ts) */
  private readonly lastClosedDay = new Map<string, string>();

  constructor(deps: ProactiveDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // 别忘了 unref —— 否则这个定时器会拖住进程退出
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 巡检一次。返回本轮**真的开口了**的回答(通常 0 或 1 条)。
   * 注入 nowMs 便于测试;生产走 setInterval。
   */
  async tick(nowMs = Date.now()): Promise<ChatAnswer[]> {
    const fired: ChatAnswer[] = [];
    for (const cupId of this.deps.cups()) {
      await this.maybeCloseDay(cupId, nowMs); // 天翻页 → 封存昨天那张记忆卡(幂等)
      await this.maybeDistill(cupId, nowMs); // 先推进长期画像(与"要不要开口"无关)
      // 优先级:身体语料(刚被摔/烫/没电/被忘)> 欠水提醒。
      // 两者**共用同一个冷却**(T16):一旦开口,最近 2h 内都不再说第二句。
      const cue = this.isQuiet(nowMs) ? null : await this.bodyCue(cupId, nowMs);
      if (cue && !(await this.inCooldown(cupId, nowMs))) {
        fired.push(await this.speakBody(cupId, nowMs, cue));
        continue;
      }
      if (!(await this.shouldSpeak(cupId, nowMs))) continue;
      fired.push(await this.speak(cupId, nowMs));
    }
    return fired;
  }

  /**
   * 身体 cue 检测(创意备忘 §5.1 #2):从**上次开口之后**的事件里挑一件"身上刚出的事"。
   * 只看上一次 proactive 之后的窗口 —— 否则一个早上的旧 shock 会在冷却走完后反复重提。
   * 有冲击/过热/低电事件 → 优先;否则看是否静默太久(被忘)。都没有 → null。
   */
  private async bodyCue(cupId: string, nowMs: number): Promise<BodyCueHit | null> {
    const t = this.deps.store;
    const last = await this.lastProactiveTs(cupId);
    const from = Math.max(dayStart(dayKey(nowMs)), last); // 上次开口之后(且不早于今天)
    const hit = bodyCueFromEvents(await t.events(cupId, from, nowMs + 1));
    if (hit) return hit;
    // 无显著事件 → 看"被忘"(静默判定基于遥测最新时刻,与开口无关,故用全天)
    const sample = await t.latestSample(cupId);
    return abandonedCue(sample ? sample.ts : null, nowMs);
  }

  /** 夜间静默:本地 22 点–次日 7 点之间,连身体语料也不开口 */
  private isQuiet(nowMs: number): boolean {
    const h = new Date(nowMs).getHours();
    return h >= QUIET_FROM || h < QUIET_TO;
  }

  /** 记忆里最后一条 proactive 的时刻;没有 → 0 */
  private async lastProactiveTs(cupId: string): Promise<number> {
    const recent = await this.deps.memory.recentTurns(cupId, 50);
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i]!.role === 'proactive') return recent[i]!.ts;
    }
    return 0;
  }

  /**
   * 天翻页:若"今天"已不是上次封存的日子,封存**昨天**那张记忆卡(幂等)。
   * 迟/重 tick 都安全(封的是一确定的日子)。出错 → 记日志不中断巡检。
   */
  private async maybeCloseDay(cupId: string, nowMs: number): Promise<void> {
    try {
      const closed = await maybeCloseDay(
        this.deps.store,
        this.deps.memory,
        cupId,
        nowMs,
        this.lastClosedDay.get(cupId) ?? null,
      );
      this.lastClosedDay.set(cupId, closed);
    } catch (err) {
      this.deps.log(`记忆卡封存失败[${cupId}]: ${(err as Error).message}`, 'warn');
    }
  }

  /** 攒够新轮 → 蒸一次长期画像。未攒够 → no-op;出错 → 记日志不中断巡检 */
  private async maybeDistill(cupId: string, nowMs: number): Promise<void> {
    try {
      const r = await distillProfile(
        {
          store: this.deps.store,
          memory: this.deps.memory,
          chat: this.deps.chat,
          log: this.deps.log,
          now: () => nowMs,
        },
        { cupId, nowMs, minNewTurns: this.deps.minNewTurns },
      );
      if (r) this.deps.log(`画像蒸馏[${cupId}]: ${r.source}`, 'info');
    } catch (err) {
      this.deps.log(`画像蒸馏失败[${cupId}]: ${(err as Error).message}`, 'warn');
    }
  }

  private async shouldSpeak(cupId: string, nowMs: number): Promise<boolean> {
    const t = this.deps.store;
    const date = dayKey(nowMs);
    const agg = await t.agg(cupId, date);
    const goal = agg && agg.goal_ml > 0 ? agg.goal_ml : await t.goal(cupId);
    const decision = decideSpeak({
      nowMs,
      hour: new Date(nowMs).getHours(),
      drankMl: agg?.drank_ml ?? 0,
      goalMl: goal,
      eventCount: agg?.event_count ?? 0,
      recentTurns: await this.recentTurns(cupId),
      lastDrinkTs: await this.lastDrinkTsToday(cupId, nowMs),
    });
    if (!decision.speak) {
      // 只记"够格但被让位挡下"的情形,避免刷屏(out-of-window/not-thirsty/no-data 是常态,不记)
      if (decision.reason === 'user-just-spoke' || decision.reason === 'just-drank' || decision.reason === 'cooldown') {
        this.deps.log(`主动开口让位[${cupId}]: ${decision.reason}`, 'info');
      }
      return false;
    }
    return true;
  }

  /** 冷却(欠水提醒与身体语料共用,T16):按"被无视次数"自适应,不再固定 2h */
  private async inCooldown(cupId: string, nowMs: number): Promise<boolean> {
    const recent = await this.recentTurns(cupId);
    const cooldown = cooldownMsFor(recent);
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i]!.role === 'proactive') return nowMs - recent[i]!.ts < cooldown;
    }
    return false;
  }

  /** 最近对话轮转成时机模型要的精简形状(role + ts),不绑 ChatStore 结构 */
  private async recentTurns(cupId: string): Promise<TimingTurn[]> {
    return (await this.deps.memory.recentTurns(cupId, 50)).map((r) => ({ role: r.role, ts: r.ts }));
  }

  /** 今天最近一次喝水事件时刻;没有 → null(用于"刚喝过先按住") */
  private async lastDrinkTsToday(cupId: string, nowMs: number): Promise<number | null> {
    const start = dayStart(dayKey(nowMs));
    const evs = await this.deps.store.events(cupId, start, nowMs + 1);
    let last: number | null = null;
    for (const e of evs) {
      if (e.type === 'drink' && (last === null || e.ts > last)) last = e.ts;
    }
    return last;
  }

  private async speak(cupId: string, nowMs: number): Promise<ChatAnswer> {
    const answer = await runChat(
      {
        store: this.deps.store,
        commands: this.deps.commands,
        chat: this.deps.chat,
        memory: this.deps.memory,
        log: this.deps.log,
        now: this.deps.now ?? (() => nowMs),
      },
      { cupId, question: '（自己开口提醒主人喝水）', proactive: true },
    );
    return await this.broadcast(cupId, nowMs, answer, `主动开口[${cupId}]: ${answer.text}`);
  }

  /**
   * 身体语料(§5.1 #2):把这具身体身上刚出的事交给 runChat 自己组织一句话。
   * 走的是同一条"主动开口"通道(记 role:'proactive' → 与欠水提醒共用冷却),
   * 失败/无模型 → runChat 内部回退成带真实数字的模板句,不空泡。
   */
  private async speakBody(cupId: string, nowMs: number, hit: BodyCueHit): Promise<ChatAnswer> {
    const answer = await runChat(
      {
        store: this.deps.store,
        commands: this.deps.commands,
        chat: this.deps.chat,
        memory: this.deps.memory,
        log: this.deps.log,
        now: this.deps.now ?? (() => nowMs),
      },
      { cupId, question: bodyQuestion(hit.cue), proactive: true },
    );
    this.deps.log(`身体语料[${cupId}](${hit.evidence}): ${answer.text}`, 'info');
    // 广播仍用 get_today 的事实(前端已有的 proactive 帧契约不动;body 细节在 text 里)
    return await this.broadcast(cupId, nowMs, answer);
  }

  /** 广播主动帧(前端既有契约:payload = {text,ts,source,facts});`logLine` 给了就顺带记一条 */
  private async broadcast(
    cupId: string,
    nowMs: number,
    answer: ChatAnswer,
    logLine?: string,
  ): Promise<ChatAnswer> {
    const ctx: ToolCtx = { store: this.deps.store, commands: this.deps.commands, now: () => nowMs };
    const facts = (await getTool('get_today')!.run(ctx, cupId, {})).output;
    this.deps.live.broadcast({
      kind: 'proactive',
      cup_id: cupId,
      payload: { text: answer.text, ts: nowMs, source: answer.source, facts },
    });
    if (logLine) this.deps.log(logLine, 'info');
    return answer;
  }
}

/** 今天从 0 点到现在的事件数(供外部调试/测试) */
export async function eventCountToday(store: Store, cupId: string, nowMs: number): Promise<number> {
  const date = dayKey(nowMs);
  const dayEnd = dayStart(date) + 86_400_000;
  return (await store.events(cupId, dayStart(date), dayEnd)).length;
}
