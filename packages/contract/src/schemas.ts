/**
 * 契约 schema —— 对应《contract.md》§2–§5。
 *
 * 一处定义,zod 同时给出:
 *   1. 运行时校验(后端收包、模拟器自检)
 *   2. TS 类型(z.infer)—— 前后端共享,字段改了编译期就报错
 *
 * 字段名保持 snake_case:契约的全部价值是"字段名一字不差",
 * 转 camelCase 会多出一层映射,正是 bug 来源。
 */
import { z } from 'zod';

// ── 通用 ─────────────────────────────────────────────────────────

export const CONTRACT_VERSION = 1;

/** 当前契约版本字段。将来升 v 时,这里改,并保留旧 schema 供后端兼容。 */
const V = z.literal(CONTRACT_VERSION);

const Ts = z.int().nonnegative();
const Seq = z.int().nonnegative();
const CupId = z.string().regex(/^cup-[A-Z0-9]+$/);
const LidId = z.string().regex(/^lid-[A-Z0-9]+$/);
const BaseId = z.string().regex(/^base-[A-Z0-9]+$/);

// ── §2 上行 · 杯盖遥测 ───────────────────────────────────────────

export const MOTION_STATES = ['idle', 'tilt', 'shake', 'lifted'] as const;

export const ImuSchema = z.object({
  ax: z.number(), // g
  ay: z.number(),
  az: z.number(),
  gx: z.number(), // °/s
  gy: z.number(),
  gz: z.number(),
});

export const LidTelemetrySchema = z.object({
  v: V,
  device_id: LidId,
  cup_id: CupId,
  ts: Ts,
  seq: Seq,
  sample_ms: z.int().positive(),
  temp_c: z.number().min(-10).max(120),
  level_mm: z.number().min(0).max(999), // 上界实现侧再按 CUP.inner_mm 校
  level_pct: z.int().min(0).max(100),
  motion: z.enum(MOTION_STATES),
  tilt_deg: z.number().min(0).max(180),
  tilt_dir: z.int().min(0).max(359),
  battery_pct: z.int().min(0).max(100),
  charging: z.boolean(),
  imu: ImuSchema.optional(), // 仅实时档携带
  rssi: z.int().optional(), // dBm,负值
});

// ── §3 上行 · 底座遥测 ───────────────────────────────────────────

export const BaseTelemetrySchema = z.object({
  v: V,
  device_id: BaseId,
  cup_id: CupId,
  ts: Ts,
  seq: Seq,
  weight_g: z.number().min(0).max(2000),
  stable: z.boolean(),
  present: z.boolean(),
  temp_c: z.number().min(-10).max(120),
  charging: z.boolean(),
  battery_pct: z.int().min(0).max(100),
});

// ── §4 上行 · 事件 ───────────────────────────────────────────────

export const EVENT_TYPES = [
  'drink',
  'refill',
  'shake',
  'temp_alert',
  'tilt_alert',
  'low_battery',
  'off_base',
  // 手势(盖内压力传感器,创意备忘 §5.1 #1):轻磕 / 长按 → 确认。
  // tap=短促接触;long_press=持续按压。分类由固件按 duration_ms 阈值定,契约只装结论。
  'tap',
  'long_press',
] as const;

/** 需要携带 duration_ms 的手势事件类型(与下面 refine 同源,勿分开改)。 */
const GESTURE_TYPES = ['tap', 'long_press'] as const;

export const DERIVED_BY = ['base', 'lid', 'backend'] as const;

export const EventSchema = z
  .object({
    v: V,
    cup_id: CupId,
    device_id: z.string().regex(/^(lid|base)-[A-Z0-9]+$/),
    ts: Ts,
    type: z.enum(EVENT_TYPES),
    amount_ml: z.number().nonnegative().optional(),
    temp_c: z.number().optional(),
    // 手势接触/按压时长(ms);仅 tap/long_press 携带
    duration_ms: z.int().nonnegative().optional(),
    confidence: z.number().min(0).max(1),
    derived_by: z.enum(DERIVED_BY),
  })
  .refine(
    (e) =>
      (e.type === 'drink' || e.type === 'refill') === (e.amount_ml !== undefined),
    { message: 'amount_ml 必须且仅在 drink/refill 时携带' },
  )
  .refine(
    (e) =>
      (GESTURE_TYPES as readonly string[]).includes(e.type) ===
      (e.duration_ms !== undefined),
    { message: 'duration_ms 必须且仅在 tap/long_press 时携带' },
  );

// ── §2.1 上行信封(实时/常规两档共用的外层)──────────────────────
// 模拟器一次可发多条遥测/事件,统一用这个信封。

export const UpstreamFrameSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lid'), payload: LidTelemetrySchema }),
  z.object({ kind: z.literal('base'), payload: BaseTelemetrySchema }),
  z.object({ kind: z.literal('event'), payload: EventSchema }),
]);

// ── §5 下行 · 指令 ───────────────────────────────────────────────

export const COMMAND_TYPES = ['remind', 'config', 'ota', 'sync_time'] as const;

export const CommandSchema = z.object({
  v: V,
  cmd_id: z.string().min(1),
  target: z.string().regex(/^(lid|base)-[A-Z0-9]+$/),
  ts: Ts,
  expires_at: Ts,
  type: z.enum(COMMAND_TYPES),
  payload: z.record(z.string(), z.unknown()),
});

// ── 类型导出(代码侧使用)────────────────────────────────────────

export type Imu = z.infer<typeof ImuSchema>;
export type LidTelemetry = z.infer<typeof LidTelemetrySchema>;
export type BaseTelemetry = z.infer<typeof BaseTelemetrySchema>;
export type CupEvent = z.infer<typeof EventSchema>;
export type UpstreamFrame = z.infer<typeof UpstreamFrameSchema>;
export type Command = z.infer<typeof CommandSchema>;
export type MotionState = (typeof MOTION_STATES)[number];
export type EventType = (typeof EVENT_TYPES)[number];
export type DerivedBy = (typeof DERIVED_BY)[number];
export type CommandType = (typeof COMMAND_TYPES)[number];
