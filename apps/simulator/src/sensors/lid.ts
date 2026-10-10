/**
 * 假杯盖 —— 模拟杯盖固件的感知与事件判定。
 *
 * 不直接读世界真值,而是"测量 + 噪声",和真固件面对的一样:
 *  - ToF 液位噪声在摇晃时显著变大(水面在动)—— 对应架构 §4.2
 *  - 本地安全判定(过热/倾倒)在端上闭环 —— 对应原则 P3
 *
 * **采样与事件检测是分开的**(对应真固件):
 *   sample()       低频,打包一条上报遥测
 *   detectEvents() 每 tick 调用,持续判定事件 → 进队列 → 随下次上报发出
 * 若把事件检测绑在上报节奏上,5 分钟才检查一次过热,是错的。
 */
import {
  ALERT,
  IMU_THRESH,
  LidTelemetrySchema,
  clamp,
  mlToLevelMm,
  mlToLevelPct,
  type CupEvent,
  type LidTelemetry,
  type MotionState,
} from '@cup/contract';
import { gaussian } from '../util/rng.ts';

/** 事件检测所需的世界状态(引擎传入) */
export interface LidWorldState {
  tempC: number;
  volumeMl: number;
  motion: MotionState;
  tiltDeg: number;
  tiltDir: number;
  lidBatteryPct: number;
  lidCharging: boolean;
}

export class LidSensor {
  readonly deviceId: string;
  readonly cupId: string;
  private rng: () => number;
  private seq = 0;
  private hotAlerted = false;
  private coldAlerted = false;
  private lowBattAlerted = false;
  private lastShakeMs = -Infinity;
  private shaking = false;
  private tiltSinceMs: number | null = null;

  constructor(opts: { deviceId: string; cupId: string; rng: () => number }) {
    this.deviceId = opts.deviceId;
    this.cupId = opts.cupId;
    this.rng = opts.rng;
  }

  /**
   * 持续事件检测(每 tick 调用)。返回本 tick 新产生的事件。
   * 用带噪的瞬时读数判定,和真固件读到的信号一致。
   */
  detectEvents(w: LidWorldState, nowMs: number): CupEvent[] {
    const events: CupEvent[] = [];
    const tempC = w.tempC + gaussian(this.rng, 0, 0.25);

    // 摇晃:连续高速能量。真固件按帧累积;这里以 motion 状态代表。
    // 去抖:一整段摇晃只报一次 —— 用"是否已在摇晃中"边沿检测,
    // 而不是靠时间间隔(否则 1500ms 晃跨多个 tick 会重复报)。
    if (w.motion === 'shake') {
      if (!this.shaking) {
        this.shaking = true;
        this.lastShakeMs = nowMs;
        events.push(this.event(nowMs, 'shake', { confidence: 0.95 }));
      }
    } else if (nowMs - this.lastShakeMs > IMU_THRESH.shake_hold_ms) {
      this.shaking = false; // 停稳超过保持时间才允许再次触发
    }

    // 过热 / 过冷:带滞回,避免在阈值附近反复触发
    if (tempC >= ALERT.temp_hot_c && !this.hotAlerted) {
      this.hotAlerted = true;
      events.push(this.event(nowMs, 'temp_alert', { temp_c: round1(tempC), confidence: 0.99 }));
    } else if (tempC < ALERT.temp_hot_c - 3) {
      this.hotAlerted = false;
    }
    if (tempC <= ALERT.temp_cold_c && !this.coldAlerted) {
      this.coldAlerted = true;
      events.push(this.event(nowMs, 'temp_alert', { temp_c: round1(tempC), confidence: 0.99 }));
    } else if (tempC > ALERT.temp_cold_c + 3) {
      this.coldAlerted = false;
    }

    // 倾倒:持续超 tilt_alert_ms 才报(瞬时倾斜不算)
    if (w.tiltDeg >= IMU_THRESH.tilt_deg && w.motion === 'tilt') {
      if (this.tiltSinceMs === null) this.tiltSinceMs = nowMs;
      if (nowMs - this.tiltSinceMs >= ALERT.tilt_alert_ms) {
        events.push(this.event(nowMs, 'tilt_alert', { confidence: 0.9 }));
        this.tiltSinceMs = null; // 触发后重置,避免持续重发
      }
    } else {
      this.tiltSinceMs = null;
    }

    // 低电
    if (w.lidBatteryPct <= ALERT.battery_low_pct && !this.lowBattAlerted) {
      this.lowBattAlerted = true;
      events.push(this.event(nowMs, 'low_battery', { confidence: 1 }));
    }
    if (w.lidBatteryPct > ALERT.battery_low_pct + 5) this.lowBattAlerted = false;

    return events;
  }

  /** 低频采样:打包一条上报遥测 */
  sample(
    w: LidWorldState,
    nowMs: number,
    sampleMs: number,
    fast = false,
  ): LidTelemetry {
    const tempC = round1(w.tempC + gaussian(this.rng, 0, 0.25));
    // ToF:摇晃时水面波动大 → 噪声大(刻意为之,对应架构 §4.2)
    const levelNoiseStd = w.motion === 'shake' ? 9 : w.motion === 'lifted' ? 3 : 0.6;
    const levelMm = round1(
      clamp(mlToLevelMm(w.volumeMl) + gaussian(this.rng, 0, levelNoiseStd), 0, 999),
    );
    const levelPct = mlToLevelPct(w.volumeMl);
    const tiltDeg = round1(clamp(w.tiltDeg + gaussian(this.rng, 0, 0.4), 0, 180));
    const tiltDir = (((w.tiltDir + Math.round(gaussian(this.rng, 0, 2))) % 360) + 360) % 360;

    const telemetry: LidTelemetry = {
      v: 1,
      device_id: this.deviceId,
      cup_id: this.cupId,
      ts: Math.round(nowMs),
      seq: this.seq++,
      sample_ms: Math.round(sampleMs),
      temp_c: tempC,
      level_mm: levelMm,
      level_pct: levelPct,
      motion: w.motion,
      tilt_deg: tiltDeg,
      tilt_dir: tiltDir,
      battery_pct: Math.round(w.lidBatteryPct),
      charging: w.lidCharging,
      ...(fast ? { imu: this.makeImu(w) } : {}),
      rssi: Math.round(gaussian(this.rng, -58, 3)),
    };
    return telemetry;
  }

  /** 实时档 IMU:静止/倾斜时是重力矢量,摇晃时叠加高频抖动 */
  private makeImu(w: { motion: MotionState; tiltDeg: number; tiltDir: number }) {
    const g = 1;
    const tiltRad = (w.tiltDeg * Math.PI) / 180;
    const dirRad = (w.tiltDir * Math.PI) / 180;
    let ax = Math.sin(tiltRad) * Math.cos(dirRad) * g;
    let ay = Math.sin(tiltRad) * Math.sin(dirRad) * g;
    let az = Math.cos(tiltRad) * g;
    let gx = 0;
    let gy = 0;
    let gz = 0;
    if (w.motion === 'shake') {
      const amp = 1.6;
      ax += gaussian(this.rng, 0, amp);
      ay += gaussian(this.rng, 0, amp);
      az += gaussian(this.rng, 0, amp);
      gx = gaussian(this.rng, 0, 60);
      gy = gaussian(this.rng, 0, 60);
      gz = gaussian(this.rng, 0, 30);
    } else {
      ax += gaussian(this.rng, 0, 0.01);
      ay += gaussian(this.rng, 0, 0.01);
      az += gaussian(this.rng, 0, 0.01);
      gx = gaussian(this.rng, 0, 0.5);
      gy = gaussian(this.rng, 0, 0.5);
      gz = gaussian(this.rng, 0, 0.5);
    }
    return {
      ax: round3(ax),
      ay: round3(ay),
      az: round3(az),
      gx: round1(gx),
      gy: round1(gy),
      gz: round1(gz),
    };
  }

  private event(
    ts: number,
    type: CupEvent['type'],
    extra: Partial<Pick<CupEvent, 'amount_ml' | 'temp_c' | 'confidence'>>,
  ): CupEvent {
    return {
      v: 1,
      cup_id: this.cupId,
      device_id: this.deviceId,
      ts: Math.round(ts),
      type,
      confidence: extra.confidence ?? 0.9,
      derived_by: 'lid',
      ...(extra.amount_ml !== undefined ? { amount_ml: extra.amount_ml } : {}),
      ...(extra.temp_c !== undefined ? { temp_c: extra.temp_c } : {}),
    };
  }

  static validate(t: LidTelemetry): LidTelemetry {
    return LidTelemetrySchema.parse(t);
  }
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
