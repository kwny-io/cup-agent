/**
 * 模拟引擎 —— 把世界、虚拟时钟、调度器、两个传感器、上报节奏缝在一起。
 *
 * 每 tick(真实时间):
 *   1. clock.advance → 得到本 tick 覆盖的虚拟区间
 *   2. world.tick(到虚拟时刻) → 温度演化等
 *   3. base.tick(虚拟时刻) → 称重状态机(沉降检查)
 *   4. scheduler.runDue(虚拟时刻) → 执行到期的定时动作
 *   5. 若跨过上报时刻 → 采样杯盖/底座,产出遥测与事件 → 交给 sink
 */
import {
  RATE,
  SCALE,
  CUP,
  type BaseTelemetry,
  type CupEvent,
  type LidTelemetry,
} from '@cup/contract';
import { VirtualClock, dayStartMs, fmt } from './clock.ts';
import { World } from './world.ts';
import { Scheduler } from './scheduler.ts';
import { LidSensor } from '../sensors/lid.ts';
import { BaseSensor } from '../sensors/base.ts';
import { createRng } from '../util/rng.ts';

export interface SimConfig {
  seed: number;
  scale: number; // 时间加速倍率
  startMs: number; // 虚拟起点
  lidId: string;
  baseId: string;
  cupId: string;
  /** 初始注水量(ml)与水温 */
  initVolumeMl: number;
  initTempC: number;
  /** 常规档上报间隔(ms)。契约默认 5 分钟;演示/测试可调小 */
  reportMs: number;
  verbose: boolean;
}

export interface Frame {
  lid?: LidTelemetry;
  base?: BaseTelemetry;
  events: CupEvent[];
}

export type Sink = (frame: Frame) => void;

export interface ScriptStep {
  /** 虚拟时刻(相对起点的毫秒偏移) */
  atMs: number;
  action: (ctx: EngineContext) => void;
  label: string;
}

/** 行为脚本能操作的东西 */
export interface EngineContext {
  world: World;
  scheduler: Scheduler;
  clock: VirtualClock;
  log: (msg: string) => void;
  config: SimConfig;
}

/** 紧急事件:即时上报,不攒批(安全相关,见原则 P3) */
const URGENT_EVENTS = new Set(['temp_alert', 'tilt_alert', 'low_battery']);

const DEFAULT_CONFIG: SimConfig = {
  seed: 42,
  scale: 1,
  startMs: Date.now(),
  lidId: 'lid-A1B2C3',
  baseId: 'base-A1B2C3',
  cupId: 'cup-A1B2C3',
  initVolumeMl: 320,
  initTempC: 55,
  reportMs: RATE.report_ms,
  verbose: true,
};

export class Engine {
  readonly config: SimConfig;
  readonly clock: VirtualClock;
  readonly world: World;
  readonly scheduler: Scheduler;
  readonly lid: LidSensor;
  readonly base: BaseSensor;

  private sink: Sink;
  private ws: { broadcast: (f: Frame) => void } | null = null;
  /** 事件队列:持续检测产生,随下次上报捎带发出(对应真固件的攒批) */
  private eventQueue: CupEvent[] = [];
  private steps: ScriptStep[] = [];
  private nextReportMs: number;
  private lastBasePresent: boolean;
  /** 是否有待定的 off_base(离开底座但还没到延迟阈值) */
  private offBasePending = false;
  private rng: () => number;
  private running = false;
  /** 手动控制暂停:为真时 runRealtime 不推进引擎(脚本停摆,但连接仍在) */
  private paused = false;

  constructor(opts: {
    config?: Partial<SimConfig>;
    steps?: ScriptStep[];
    sink: Sink;
  }) {
    this.config = { ...DEFAULT_CONFIG, ...opts.config };
    this.sink = opts.sink;
    this.steps = (opts.steps ?? []).slice().sort((a, b) => a.atMs - b.atMs);

    this.clock = new VirtualClock(this.config.startMs, this.config.scale);
    this.rng = createRng(this.config.seed);
    this.world = new World({
      nowMs: this.config.startMs,
      volumeMl: this.config.initVolumeMl,
      tempC: this.config.initTempC,
      onBase: true,
    });
    this.scheduler = new Scheduler();

    this.lid = new LidSensor({
      deviceId: this.config.lidId,
      cupId: this.config.cupId,
      rng: this.rng,
    });
    this.base = new BaseSensor({
      deviceId: this.config.baseId,
      cupId: this.config.cupId,
      rng: this.rng,
      scheduler: this.scheduler,
      readWeightG: () => (this.world.snapshot(this.clock.nowMs).onBase ? this.world.weightG : 0),
      readBaseTempC: () => this.world.snapshot(this.clock.nowMs).battC,
      readBattery: () => {
        const s = this.world.snapshot(this.clock.nowMs);
        return { pct: s.baseBatteryPct, charging: s.lidCharging };
      },
      emit: (e) => this.enqueueEvent(e),
      log: (m) => this.log(m),
    });

    this.nextReportMs = this.config.startMs + this.config.reportMs;
    this.lastBasePresent = true;
    // 把行为脚本排进时间线
    this.scheduleSteps();
  }

  // ── 生命周期 ──────────────────────────────────────────────────

  /** 挂上 WebSocket 出口(在 sink 之外额外广播) */
  wireWs(ws: { broadcast: (f: Frame) => void } | null): void {
    this.ws = ws;
  }

  /** 手动控制:暂停/恢复脚本推进(runRealtime 每 tick 检查)。 */
  setPaused(p: boolean): void {
    this.paused = p;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** 按真实时间推进 dtMs 毫秒 */
  step(dtMs: number): void {
    const { toMs } = this.clock.advance(dtMs);
    this.world.tick(toMs);

    const snap = this.world.snapshot(toMs);

    // 底座状态机(每 tick 都跑,捕捉"放上/拿走"翻转)
    this.base.tick(toMs, snap.onBase);

    // 持续事件检测(每 tick)—— 这才能捕捉随时间增长才成立的判定
    // (持续倾倒、持续过热),而不是每 5 分钟才检查一次。
    const lidEvents = this.lid.detectEvents(
      {
        tempC: snap.tempC,
        volumeMl: snap.volumeMl,
        motion: snap.motion,
        tiltDeg: snap.tiltDeg,
        tiltDir: snap.tiltDir,
        lidBatteryPct: snap.lidBatteryPct,
        lidCharging: snap.lidCharging,
      },
      toMs,
    );
    for (const e of lidEvents) this.enqueueEvent(e);
    const lowBatt = this.base.checkLowBattery(toMs);
    if (lowBatt) this.enqueueEvent(lowBatt);

    // 离座事件:短暂拿起(喝一口)不算"带走",离开超过 off_base_delay_ms 才报。
    if (this.lastBasePresent && !snap.onBase) {
      this.base.noteOffBase(toMs);
      this.offBasePending = true;
      this.scheduler.at(
        toMs + SCALE.off_base_delay_ms,
        () => {
          if (this.offBasePending) {
            this.offBasePending = false;
            this.enqueueEvent({
              v: 1,
              cup_id: this.config.cupId,
              device_id: this.config.baseId,
              ts: Math.round(this.clock.nowMs),
              type: 'off_base',
              confidence: 1,
              derived_by: 'base',
            });
          }
        },
        'off_base 延迟判定',
      );
    } else if (!this.lastBasePresent && snap.onBase) {
      // 回来了 → 取消待定的 off_base
      this.offBasePending = false;
    }
    this.lastBasePresent = snap.onBase;

    // 到期定时动作
    this.scheduler.runDue(toMs);

    // 到上报时刻 → 采样 + 捎带发出积压事件
    while (toMs >= this.nextReportMs) {
      this.report(this.nextReportMs);
      this.nextReportMs += this.config.reportMs;
    }

    // 电量缓慢消耗(基于真实时间)
    this.world.drainBattery(dtMs, snap.lidCharging);
  }

  /**
   * 实时模式:按真实时间推进,直到脚本跑完。
   * 供 --ws 演示 / 前端联调用 —— 数据是"流"出来的,不是瞬间冲出来的。
   * @returns 结束后 resolve
   */
  runRealtime(onTickMs = 50): Promise<void> {
    const lastAt = this.steps.length > 0 ? this.steps[this.steps.length - 1]!.atMs : 0;
    const endVirtualMs = lastAt + 60_000;
    this.running = true;
    return new Promise((resolve) => {
      const done = (): void => {
        clearInterval(timer);
        this.running = false;
        resolve();
      };
      const timer = setInterval(() => {
        if (this.paused) return; // 手动暂停:不推进虚拟时间(连接与出口仍在)
        this.step(onTickMs);
        if (this.clock.virtualElapsedMs >= endVirtualMs) done();
      }, onTickMs);
      this.stopRealtime = done;
    });
  }

  /** 外部停止实时循环(测试收尾 / 优雅退出)。 */
  stopRealtime: (() => void) | null = null;

  /**
   * 跑完整个脚本:推进到最后一个动作之后 scoreMs 毫秒(虚拟时间)。
   *
   * 关键:**步长按虚拟时间定,不按真实时间**。
   * 若用固定真实步长,scale=600 时一个 tick 走 60 秒虚拟,5 分钟的
   * 上报周期会被整个跨过(0 帧),脚本动作也会被压在一起。
   * 改为固定虚拟步长后,加速倍率只影响"跑多快",不影响"行为分辨率"。
   */
  runToEnd(scoreMs = 60_000): { virtualMs: number; ticks: number } {
    const lastAt = this.steps.length > 0 ? this.steps[this.steps.length - 1]!.atMs : 0;
    const endVirtualMs = lastAt + scoreMs;
    const VIRTUAL_STEP_MS = 250; // 虚拟分辨率
    const remaining = endVirtualMs - this.clock.virtualElapsedMs;
    const ticks = Math.max(1, Math.ceil(remaining / VIRTUAL_STEP_MS));
    const realStepMs = VIRTUAL_STEP_MS / this.config.scale;
    this.running = true;
    for (let i = 0; i < ticks; i++) this.step(realStepMs);
    this.running = false;
    return { virtualMs: this.clock.virtualElapsedMs, ticks };
  }

  // ── 内部 ─────────────────────────────────────────────────────

  private report(nowMs: number): void {
    const snap = this.world.snapshot(nowMs);
    const w = {
      tempC: snap.tempC,
      volumeMl: snap.volumeMl,
      motion: snap.motion,
      tiltDeg: snap.tiltDeg,
      tiltDir: snap.tiltDir,
      lidBatteryPct: snap.lidBatteryPct,
      lidCharging: snap.lidCharging,
    };

    const lidT = this.lid.sample(w, nowMs, this.config.reportMs);
    const baseT = this.base.sample(nowMs, snap.onBase, this.config.reportMs);

    // 攒批:把本周期内检测到的事件随本次上报一起发出(契约 §2.1 常规档语义)
    const events = this.eventQueue;
    this.eventQueue = [];

    this.emit({ lid: lidT, base: baseT, events });
  }

  /**
   * 事件入队。
   * 紧急事件(安全相关,P3)**即时发出**,不等攒批;其余随下次上报捎带。
   * 依据:真固件里过热/倾倒不能等 5 分钟才上报。
   */
  private enqueueEvent(e: CupEvent): void {
    if (URGENT_EVENTS.has(e.type)) {
      this.emit({ events: [e] });
    } else {
      this.eventQueue.push(e);
    }
    if (this.config.verbose) {
      this.log(`      · 检测到 ${e.type} (ts=${fmt(e.ts)})`);
    }
  }

  private emit(frame: Frame): void {
    this.sink(frame);
    this.ws?.broadcast(frame);
  }

  private scheduleSteps(): void {
    for (const s of this.steps) {
      const atMs = this.config.startMs + s.atMs;
      this.scheduler.at(
        atMs,
        () => {
          this.log(`[${fmt(this.clock.nowMs)}] ▶ ${s.label}`);
          s.action({
            world: this.world,
            scheduler: this.scheduler,
            clock: this.clock,
            log: (m) => this.log(m),
            config: this.config,
          });
        },
        s.label,
      );
    }
  }

  private log(msg: string): void {
    if (this.config.verbose) console.log(msg);
  }
}

// ── 行为脚本助手(供 scenarios 使用)────────────────────────────

export interface StepDef {
  atMs: number;
  label: string;
  action: (ctx: EngineContext) => void;
}

export function step(atMs: number, label: string, action: StepDef['action']): ScriptStep {
  return { atMs, label, action };
}

/** 常用动作:喝水 ml */
export function drinkStep(atMs: number, ml: number): ScriptStep {
  return step(atMs, `喝 ${ml}ml`, (ctx) => {
    ctx.world.setOnBase(false);
    ctx.world.setMotion('lifted');
    ctx.world.drink(ml);
    // 放回底座
    ctx.scheduler.at(ctx.clock.nowMs + 3000, () => {
      ctx.world.setOnBase(true);
      ctx.world.setMotion('idle');
    }, '放回底座');
  });
}

/** 常用动作:续杯到指定量 */
export function refillStep(atMs: number, targetMl: number, pourC: number): ScriptStep {
  return step(atMs, `续杯到 ${targetMl}ml @ ${pourC}°C`, (ctx) => {
    ctx.world.setOnBase(false);
    ctx.world.setMotion('lifted');
    const { addedMl } = ctx.world.refill(targetMl, pourC);
    ctx.log(`   加了 ${addedMl}ml`);
    ctx.scheduler.at(ctx.clock.nowMs + 5000, () => {
      ctx.world.setOnBase(true);
      ctx.world.setMotion('idle');
    }, '放回底座');
  });
}

/** 常用动作:摇杯 */
export function shakeStep(atMs: number, durationMs: number): ScriptStep {
  return step(atMs, `摇杯 ${durationMs}ms`, (ctx) => {
    ctx.world.setOnBase(false);
    ctx.world.setMotion('shake', 12, 90);
    ctx.scheduler.at(ctx.clock.nowMs + durationMs, () => {
      ctx.world.setMotion('idle');
    }, '停止摇晃');
    ctx.scheduler.at(ctx.clock.nowMs + durationMs + 1000, () => {
      ctx.world.setOnBase(true);
    }, '放回底座');
  });
}

/**
 * 常用动作:倒热水(触发过热)。
 * "换一壶热水"= 倒空再注满,整杯温度变为 pourC;
 * 不是往凉水里兑一点热水(那样混合后到不了阈值)。
 */
export function hotWaterStep(atMs: number, targetMl: number, pourC: number): ScriptStep {
  return step(atMs, `倒热水 ${pourC}°C 到 ${targetMl}ml`, (ctx) => {
    ctx.world.setOnBase(false);
    ctx.world.setMotion('lifted');
    ctx.world.refillTo(targetMl, pourC); // 直接设为该体积与该温度
    ctx.scheduler.at(ctx.clock.nowMs + 4000, () => {
      ctx.world.setOnBase(true);
      ctx.world.setMotion('idle');
    }, '放回底座');
  });
}

export function hhmm(timeStr: string): number {
  const [h, m] = timeStr.split(':').map(Number);
  return ((h ?? 0) * 60 + (m ?? 0)) * 60 * 1000;
}

export { CUP, dayStartMs };
