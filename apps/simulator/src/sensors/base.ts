/**
 * 假底座 —— 模拟底座固件的称重与事件判定。
 * 对应《contract.md》§4 事件语义 与 架构 §4.3 称重状态机。
 *
 * 状态机:
 *   OFF_BASE   杯不在座上(present=false)
 *   SETTLING   杯在座上但还没稳(在等 SETTLE_WINDOW_MS)
 *   RESTING(W) 已稳定,记住基准重量 W
 *
 *   RESTING(W1) ──重量→0──► OFF_BASE ──重量↑──► SETTLING ──稳定──► RESTING(W2)
 *   RESTING(W2): W2 < W1−阈值 → drink ; W2 > W1+阈值 → refill ; 否则无事件
 *
 * 说明:真固件靠"窗口内标准差 < 阈值"判稳定;模拟器等价地建模为
 * "放下后等 SETTLE_WINDOW_MS 再读" —— 因为模拟的水不会真的在采样窗口里振荡。
 * 时间加速下这 800ms 虚拟时间会被瞬间跨过,不产生采样开销。
 */
import {
  ALERT,
  SCALE,
  type BaseTelemetry,
  type CupEvent,
} from '@cup/contract';
import { gaussian } from '../util/rng.ts';
import { Scheduler } from '../core/scheduler.ts';
import { fmt } from '../core/clock.ts';

export type BaseState = 'OFF_BASE' | 'SETTLING' | 'RESTING';

export interface BaseDeps {
  deviceId: string;
  cupId: string;
  rng: () => number;
  scheduler: Scheduler;
  /** 读当前世界总重(皮重 + 水重) */
  readWeightG: () => number;
  /** 读底座内部温度(温补用) */
  readBaseTempC: () => number;
  /** 读底座电量 */
  readBattery: () => { pct: number; charging: boolean };
  /** 事件出口 */
  emit: (e: CupEvent) => void;
  log: (msg: string) => void;
}

export class BaseSensor {
  private d: BaseDeps;
  private state: BaseState = 'OFF_BASE';
  /** 当前稳定基准重量(皮重 + 水重)。这是"上次稳定时"的记录,不是实时读值。 */
  private restingWeightG = 0;
  private settlingSinceMs: number | null = null;
  private seq = 0;
  private lowBattAlerted = false;

  constructor(deps: BaseDeps) {
    this.d = deps;
    // 初始若杯在座上,先走一次稳定流程
    const w = this.measuredWeight();
    if (w >= SCALE.present_min_g) {
      this.state = 'SETTLING';
      this.settlingSinceMs = null; // 由 tick 里的首次调用设置
      this.restingWeightG = w; // 占位,稳定后会被覆盖
    }
  }

  /** 带噪声的重量读数 */
  private measuredWeight(): number {
    const trueW = this.d.readWeightG();
    return Math.max(0, trueW + gaussian(this.d.rng, 0, 1.2));
  }

  /**
   * 每个采样周期调用一次。
   * @param present 世界真值:杯是否在座上
   */
  tick(nowMs: number, present: boolean): void {
    const w = present ? this.measuredWeight() : 0;

    switch (this.state) {
      case 'OFF_BASE': {
        if (w >= SCALE.present_min_g) {
          this.state = 'SETTLING';
          this.settlingSinceMs = nowMs;
          this.d.log(`[${fmt(nowMs)}] 底座: 杯子放上 (${w.toFixed(1)}g) → SETTLING`);
        }
        break;
      }
      case 'SETTLING': {
        if (w < SCALE.present_min_g) {
          // 刚放上又拿走
          this.state = 'OFF_BASE';
          this.settlingSinceMs = null;
          break;
        }
        if (this.settlingSinceMs === null) this.settlingSinceMs = nowMs;
        if (nowMs - this.settlingSinceMs >= SCALE.settle_window_ms) {
          this.settle(nowMs, w);
        }
        break;
      }
      case 'RESTING': {
        if (w < SCALE.present_min_g) {
          // 杯子被拿走 —— 状态机只负责记状态,off_base 事件的时机见 noteOffBase
          this.state = 'OFF_BASE';
          this.settlingSinceMs = null;
        }
        break;
      }
    }
  }

  /** 沉降完成 → 判定事件 */
  private settle(nowMs: number, w: number): void {
    const prev = this.restingWeightG;
    const delta = w - prev;
    this.state = 'RESTING';
    this.settlingSinceMs = null;
    this.restingWeightG = w;

    if (prev > 0 && Math.abs(delta) >= SCALE.drink_min_g) {
      const amountMl = Math.round(Math.abs(delta) / 1.0); // g_per_ml = 1
      if (delta < 0) {
        this.d.emit(this.event(nowMs, 'drink', { amount_ml: amountMl, confidence: 0.95 }));
        this.d.log(`[${fmt(nowMs)}] 🥤 drink ${amountMl}ml  (${prev.toFixed(1)}→${w.toFixed(1)}g)`);
      } else {
        this.d.emit(this.event(nowMs, 'refill', { amount_ml: amountMl, confidence: 0.95 }));
        this.d.log(`[${fmt(nowMs)}] 💧 refill ${amountMl}ml (${prev.toFixed(1)}→${w.toFixed(1)}g)`);
      }
    } else if (prev > 0) {
      this.d.log(`[${fmt(nowMs)}] 底座: 稳定 ${w.toFixed(1)}g(变化 ${delta.toFixed(1)}g,未越阈值,无事件)`);
    } else {
      this.d.log(`[${fmt(nowMs)}] 底座: 首次稳定 ${w.toFixed(1)}g(建立基准)`);
    }
  }

  /** 杯子离开底座时,记录/log off_base(事件由引擎决定是否随遥测发出) */
  noteOffBase(nowMs: number): void {
    this.d.log(`[${fmt(nowMs)}] 底座: off_base(基准 ${this.restingWeightG.toFixed(1)}g)`);
  }

  /** 生成一条底座遥测(常规档上报用) */
  sample(nowMs: number, present: boolean, sampleMs: number): BaseTelemetry {
    const w = present ? this.measuredWeight() : 0;
    const batt = this.d.readBattery();
    return {
      v: 1,
      device_id: this.d.deviceId,
      cup_id: this.d.cupId,
      ts: Math.round(nowMs),
      seq: this.seq++,
      weight_g: Math.round(w * 10) / 10,
      stable: this.state === 'RESTING',
      present,
      temp_c: Math.round(this.d.readBaseTempC() * 10) / 10,
      charging: batt.charging,
      battery_pct: Math.round(batt.pct),
    };
  }

  checkLowBattery(nowMs: number): CupEvent | null {
    const batt = this.d.readBattery();
    if (batt.pct <= ALERT.battery_low_pct && !this.lowBattAlerted) {
      this.lowBattAlerted = true;
      return this.event(nowMs, 'low_battery', { confidence: 1 });
    }
    if (batt.pct > ALERT.battery_low_pct + 5) this.lowBattAlerted = false;
    return null;
  }

  get currentState(): BaseState {
    return this.state;
  }

  private event(
    ts: number,
    type: CupEvent['type'],
    extra: Partial<Pick<CupEvent, 'amount_ml' | 'temp_c' | 'confidence'>>,
  ): CupEvent {
    return {
      v: 1,
      cup_id: this.d.cupId,
      device_id: this.d.deviceId,
      ts: Math.round(ts),
      type,
      confidence: extra.confidence ?? 0.9,
      derived_by: 'base',
      ...(extra.amount_ml !== undefined ? { amount_ml: extra.amount_ml } : {}),
      ...(extra.temp_c !== undefined ? { temp_c: extra.temp_c } : {}),
    };
  }
}
