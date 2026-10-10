/**
 * 契约常量 —— 对应《contract.md》§6。
 * 改动这里 = 改契约,见 contract.md §7 变更规则。
 */

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

// ── §6.1 杯体几何(以 400ml 杯为例,可配)──────────────────────────

const CAPACITY_ML = 400;
const INNER_MM = 130;

export const CUP = {
  capacity_ml: CAPACITY_ML,
  inner_mm: INNER_MM,
  tare_g: 285, // 空杯自重(底座皮重基准)
  g_per_ml: 1.0, // 水密度近似
  ml_per_mm: CAPACITY_ML / INNER_MM, // ≈3.077
} as const;

// ── §6.2 底座 · 称重判定 ──────────────────────────────────────────

export const SCALE = {
  settle_window_ms: 800,
  settle_std_g: 1.5, // 窗口内标准差 < 此值 → stable
  present_min_g: 50, // 重量低于此 → present=false(杯子拿走)
  drink_min_g: 30, // |ΔW| 超此值才算事件(≈30ml)
  drink_min_ml: 30,
  /** 离开底座超过此时间才发 off_base —— 短暂拿起(喝一口)不算"带走了" */
  off_base_delay_ms: 120_000,
} as const;

// ── §6.3 杯盖 · IMU 判定 ─────────────────────────────────────────

export const IMU_THRESH = {
  shake_energy_g: 0.35, // 加速度超出 1g 部分的模长阈值
  shake_frames: 8, // 连续超阈值帧数 → 判 shake
  shake_hold_ms: 400, // 判 shake 后维持 motion=shake 的时间
  tilt_deg: 35, // 倾角超此值 → motion=tilt
} as const;

// ── §6.4 报警 ────────────────────────────────────────────────────

export const ALERT = {
  temp_hot_c: 65, // 水温超此值 → temp_alert(端上本地触发)
  temp_cold_c: 5,
  tilt_alert_ms: 2000, // 持续倾倒超此时间 → tilt_alert
  battery_low_pct: 15,
  batt_overheat_c: 60, // 电池仓温度超此值 → 限流 + 报警
} as const;

// ── §6.5 采样 / 上报节奏 ─────────────────────────────────────────

export const RATE = {
  report_ms: 300_000, // 常规档上报间隔 5 min
  fast_hz: 40, // 实时档 IMU 采样率
} as const;

// ── §6.1 换算关系(固件/模拟器/后端共用)──────────────────────────
// 契约的一部分:三处换算必须一致,故集中在这里。

/** 总重 → 净水重(g) */
export function waterGrams(weight_g: number): number {
  return weight_g - CUP.tare_g;
}

/** 总重 → 净水体积(ml),下界截到 0 */
export function volumeMl(weight_g: number): number {
  return Math.max(0, waterGrams(weight_g)) / CUP.g_per_ml;
}

/** 总重 → 液位(mm),截到 [0, inner_mm] */
export function levelMmFromWeight(weight_g: number): number {
  return clamp(volumeMl(weight_g) / CUP.ml_per_mm, 0, CUP.inner_mm);
}

/** 总重 → 满杯百分比(整数) */
export function levelPctFromWeight(weight_g: number): number {
  return Math.round(clamp((volumeMl(weight_g) / CUP.capacity_ml) * 100, 0, 100));
}

/** 体积(ml) → 重量增量(g) */
export function mlToGrams(ml: number): number {
  return ml * CUP.g_per_ml;
}

/** 体积(ml) → 液位(mm) */
export function mlToLevelMm(ml: number): number {
  return clamp(ml / CUP.ml_per_mm, 0, CUP.inner_mm);
}

/** 体积(ml) → 满杯百分比(整数) */
export function mlToLevelPct(ml: number): number {
  return Math.round(clamp((ml / CUP.capacity_ml) * 100, 0, 100));
}
