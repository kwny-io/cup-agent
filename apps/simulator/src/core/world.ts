/**
 * 物理世界 —— 模拟器的地面真值(ground truth)。
 *
 * 杯盖和底座都不直接"看到"这些值,而是各自带噪声去测量(见 sensors/)。
 * 这样事件判定逻辑(在 sensors 里)才和真实固件一样,面对的是噪声而非理想值。
 *
 * 内部只用虚拟时间;温度按牛顿冷却演化。
 */
import { CUP, clamp } from '@cup/contract';

export type MotionState = 'idle' | 'tilt' | 'shake' | 'lifted';

export interface WorldSnapshot {
  nowMs: number;
  volumeMl: number; // 净水体积
  tempC: number; // 水温
  onBase: boolean; // 杯是否在底座上
  motion: MotionState;
  tiltDeg: number;
  tiltDir: number;
  lidBatteryPct: number;
  baseBatteryPct: number;
  lidCharging: boolean;
  /** 电池仓温度(用于超温保护)—— 比水温低,但有热耦合 */
  battC: number;
}

const AMBIENT_C = 24; // 室温
const K_COOL_PER_MS = 1 / (55 * 60 * 1000); // 时间常数 55 分钟(带盖保温)
/** 杯在底座上时,底座线圈发热,电池仓温度抬升 */
const CHARGING_BATT_RISE_C = 6;
/** 电池仓与水温的热耦合系数:水越热,电池仓越热 */
const BATT_COUPLING = 0.12;

export class World {
  private volumeMl: number;
  private tempC: number;
  private onBase: boolean;
  private motion: MotionState = 'idle';
  private tiltDeg = 0;
  private tiltDir = 0;
  private lidBatteryPct = 100;
  private baseBatteryPct = 100;
  private battCValue = AMBIENT_C;
  private lastMs: number;

  constructor(init: {
    nowMs: number;
    volumeMl: number;
    tempC: number;
    onBase?: boolean;
    lidBatteryPct?: number;
    baseBatteryPct?: number;
  }) {
    this.volumeMl = clamp(init.volumeMl, 0, CUP.capacity_ml);
    this.tempC = clamp(init.tempC, -10, 120);
    this.onBase = init.onBase ?? true;
    this.lidBatteryPct = init.lidBatteryPct ?? 100;
    this.baseBatteryPct = init.baseBatteryPct ?? 100;
    this.lastMs = init.nowMs;
  }

  // ── 时间推进:温度按牛顿冷却演化 ──────────────────────────────

  tick(nowMs: number): void {
    const dtMs = nowMs - this.lastMs;
    if (dtMs <= 0) {
      this.lastMs = Math.max(this.lastMs, nowMs);
      return;
    }
    this.lastMs = nowMs;

    // 水温 → 室温(指数衰减)
    const towardAmbient = this.tempC - AMBIENT_C;
    this.tempC -= towardAmbient * (1 - Math.exp(-K_COOL_PER_MS * dtMs));
    this.tempC = clamp(this.tempC, -10, 120);

    // 电池仓温度:受水温耦合 + 充电发热,趋向某个平衡
    const battTarget =
      AMBIENT_C +
      (this.tempC - AMBIENT_C) * BATT_COUPLING +
      (this.onBase ? CHARGING_BATT_RISE_C : 0);
    this.battCValue += (battTarget - this.battCValue) * 0.02;
    this.battCValue = clamp(this.battCValue, -10, 120);
  }

  // ── 动作:由行为脚本调用 ──────────────────────────────────────

  /** 喝掉 ml(不能喝超过现有的) */
  drink(ml: number): number {
    const actual = Math.min(ml, this.volumeMl);
    this.volumeMl -= actual;
    return actual;
  }

  /** 加水/续杯:补到 targetVolumeMl,水温重置为 pourTempC(混合后) */
  refill(targetVolumeMl: number, pourTempC: number): { addedMl: number } {
    const added = Math.max(0, targetVolumeMl - this.volumeMl);
    if (added <= 0) return { addedMl: 0 };
    // 简单混合:新旧按体积加权
    const total = this.volumeMl + added;
    if (total > 0) {
      this.tempC = (this.tempC * this.volumeMl + pourTempC * added) / total;
    }
    this.volumeMl = clamp(total, 0, CUP.capacity_ml);
    return { addedMl: added };
  }

  /** 直接设定水温(如倒掉重来、加冷水) */
  setTemp(c: number): void {
    this.tempC = clamp(c, -10, 120);
  }

  /**
   * 换一壶水:体积与温度都直接设为给定值。
   * 语义是"倒空再注满新水",不同于 refill(往旧水里兑)。
   */
  refillTo(targetVolumeMl: number, pourTempC: number): void {
    this.volumeMl = clamp(targetVolumeMl, 0, CUP.capacity_ml);
    this.tempC = clamp(pourTempC, -10, 120);
  }

  setOnBase(b: boolean): void {
    this.onBase = b;
    if (!b) this.motion = 'lifted';
  }

  setMotion(m: MotionState, tiltDeg = 0, tiltDir = 0): void {
    this.motion = m;
    this.tiltDeg = clamp(tiltDeg, 0, 180);
    this.tiltDir = ((Math.round(tiltDir) % 360) + 360) % 360;
  }

  setLidBattery(pct: number): void {
    this.lidBatteryPct = clamp(pct, 0, 100);
  }

  drainBattery(realDeltaMs: number, charging: boolean): void {
    // 极慢的实时消耗;时间加速下会等比放大(这不是物理模拟,只为展示低电场景)
    const drainPerMs = charging ? 0 : -0.00002 / 1000;
    const rate = charging ? 0.00005 / 1000 : drainPerMs;
    this.lidBatteryPct = clamp(this.lidBatteryPct + rate * realDeltaMs, 0, 100);
    if (charging) this.baseBatteryPct = clamp(this.baseBatteryPct, 0, 100);
    else this.baseBatteryPct = clamp(this.baseBatteryPct - 0.00001 * realDeltaMs, 0, 100);
  }

  // ── 读取 ─────────────────────────────────────────────────────

  snapshot(nowMs: number): WorldSnapshot {
    return {
      nowMs,
      volumeMl: this.volumeMl,
      tempC: this.tempC,
      onBase: this.onBase,
      motion: this.motion,
      tiltDeg: this.tiltDeg,
      tiltDir: this.tiltDir,
      lidBatteryPct: this.lidBatteryPct,
      baseBatteryPct: this.baseBatteryPct,
      lidCharging: this.onBase,
      battC: this.battCValue,
    };
  }

  /** 总重量(g)= 皮重 + 水重 */
  get weightG(): number {
    return CUP.tare_g + this.volumeMl * CUP.g_per_ml;
  }
}
