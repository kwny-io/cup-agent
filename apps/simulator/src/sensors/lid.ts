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
  /** 盖顶压力(g);0 = 无接触。手势信号源 */
  pressG: number;
}

// ── 手势阈值(压力接触时长 → tap/long_press)─────────────────────────
// **不是契约常量**:契约只装结论(事件型 tap/long_press + 必须带 duration_ms),
// "多长算轻磕、多长算长按"归设备端。此四值镜像固件 contract_dev.h 的 GESTURE_* 宏,
// 两侧同源;跨语言守护见 firmware/host_test/contract-mirror.test.ts。
const GESTURE_PRESS_MIN_G = 50; // 压力超此 → 视为接触
const GESTURE_TAP_MIN_MS = 40; // 短于此视为抖动/噪声,忽略
const GESTURE_LONG_PRESS_MS = 600; // 达此 → long_press;介于两者 → tap

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
  /** 本段倾倒是否已报过 —— 与固件 lid_logic 的 tilt_alerted 同义:一段持续倾斜只报一次 */
  private tiltAlerted = false;
  // 手势状态机(镜像固件 lid_logic):接触上升沿记时,松手时按时长分类。
  private pressContact = false;
  private pressSinceMs = 0;

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

    // 倾倒:持续超 tilt_alert_ms 才报(瞬时倾斜不算)。
    // **一段持续倾斜只报一次** —— 与固件 lid_logic 的 tilt_alerted 同义:
    // 回正后复位,再倾斜才会重新计时/再报。若在报警后把 tiltSinceMs 清空,
    // 倾倒仍在持续的下一 tick 会重新计时,于是每 tilt_alert_ms 重发一次
    // (tilt_alert 是紧急事件,会立刻单独发帧 → 持续倾倒时每 2s 喷一帧)。
    if (w.tiltDeg >= IMU_THRESH.tilt_deg && w.motion === 'tilt') {
      if (this.tiltSinceMs === null) this.tiltSinceMs = nowMs;
      if (!this.tiltAlerted && nowMs - this.tiltSinceMs >= ALERT.tilt_alert_ms) {
        events.push(this.event(nowMs, 'tilt_alert', { confidence: 0.9 }));
        this.tiltAlerted = true;
      }
    } else {
      this.tiltSinceMs = null;
      this.tiltAlerted = false;
    }

    // 低电
    if (w.lidBatteryPct <= ALERT.battery_low_pct && !this.lowBattAlerted) {
      this.lowBattAlerted = true;
      events.push(this.event(nowMs, 'low_battery', { confidence: 1 }));
    }
    if (w.lidBatteryPct > ALERT.battery_low_pct + 5) this.lowBattAlerted = false;

    // 手势(盖内压力传感器):松手时按接触时长分 tap/long_press。
    // 与固件 lid_logic 同构 —— 接触上升沿记时,下降沿(松手)按时长发一次事件;
    // 接触时长只有到松手才知道,故不在"够久即发"而在"松手发",一次接触恰好一个事件。
    const contact = w.pressG >= GESTURE_PRESS_MIN_G;
    if (contact) {
      if (!this.pressContact) {
        this.pressContact = true;
        this.pressSinceMs = nowMs;
      }
    } else if (this.pressContact) {
      this.pressContact = false;
      const dur = Math.round(nowMs - this.pressSinceMs);
      if (dur >= GESTURE_TAP_MIN_MS) {
        const type = dur >= GESTURE_LONG_PRESS_MS ? 'long_press' : 'tap';
        events.push(this.event(nowMs, type, { duration_ms: dur, confidence: 0.9 }));
      }
    }

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
    extra: Partial<Pick<CupEvent, 'amount_ml' | 'temp_c' | 'duration_ms' | 'confidence'>>,
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
      ...(extra.duration_ms !== undefined ? { duration_ms: extra.duration_ms } : {}),
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
