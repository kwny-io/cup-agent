/**
 * 对话 agent 的工具集 —— 只读 + 写(读数据 / 改目标 / 给设备排队指令)。
 *
 * **安全模型**:模型给的参数是**不可信输入**(系统边界)。所有校验收口在
 * `agent.ts` 的分发器里(按 name 白名单 + `parse` + 写预算),工具实现只管"参数合法时做什么"。
 *
 * 写工具的铁律:
 *   · `push_device` 的 schema **绝不接受** target / cmd_id / expires_at / type ——
 *     设备与指令元数据全由服务端填(否则模型能指挥任意设备 / 伪造指令)
 *   · 复用 `http.ts` 的同一目标设备常量与同一上界校验
 *
 * 只读工具的产出**预计算**模型可能说的每一项(remaining_ml / progress_pct …)——
 * 否则严格的数字守卫会把"还差 780ml"这类合法派生值当成瞎编(见 guard.ts)。
 */
import { z } from 'zod';
import type { Command } from '@cup/contract';
import type { Store } from '../../store/store.ts';
import { dayKey, dayStart, DEFAULT_GOAL_ML } from '../../store/store.ts';
import { abandonedCue, ABANDON_HOURS } from './body.ts';
import type { CommandQueue } from '../commands.ts';
import { DEFAULT_DEVICE_TARGET } from '../commands.ts';
import type { ToolSpec } from './types.ts';

export interface ToolCtx {
  store: Store;
  commands: CommandQueue;
  now: () => number;
}

export interface ToolResult {
  ok: boolean;
  output: unknown;
  error?: string;
}

export interface ToolDef {
  spec: ToolSpec;
  /** 写工具:每个 runChat 至多一次(见 agent.ts 写预算) */
  isWrite: boolean;
  /** 校验不可信参数 → 合法值时返回解析后的值,否则 null */
  parse(input: unknown): unknown | null;
  run(ctx: ToolCtx, cupId: string, input: unknown): Promise<ToolResult>;
}

// ── 只读:get_today ──────────────────────────────────────────────

const GetTodayArgs = z.object({});

const getToday: ToolDef = {
  isWrite: false,
  spec: {
    name: 'get_today',
    description:
      '读取杯子今天的数据:已喝多少 ml、目标、还差多少、进度百分比、喝了几次、水温区间、连续达标天数。用户问"今天喝得怎么样"时用它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  parse: (input) => {
    const r = GetTodayArgs.safeParse(input ?? {});
    return r.success ? r.data : null;
  },
  async run(ctx, cupId) {
    const date = dayKey(ctx.now());
    const agg = await ctx.store.agg(cupId, date);
    const goal = agg?.goal_ml ?? (await ctx.store.goal(cupId));
    const drank = agg?.drank_ml ?? 0;
    const remaining = Math.max(0, goal - drank);
    const progress = goal > 0 ? Math.min(100, Math.round((drank / goal) * 100)) : 0;
    return {
      ok: true,
      output: {
        date,
        drank_ml: drank,
        goal_ml: goal,
        remaining_ml: remaining,
        progress_pct: progress,
        drink_count: agg?.drink_count ?? 0,
        refill_ml: agg?.refill_ml ?? 0,
        temp_min_c: agg?.temp_min_c ?? null,
        temp_max_c: agg?.temp_max_c ?? null,
        streak: agg?.streak ?? 0,
        reached_goal: goal > 0 && drank >= goal,
      },
    };
  },
};

// ── 只读:get_history ────────────────────────────────────────────

const GetHistoryArgs = z.object({ days: z.int().min(1).max(30) });
const DEFAULT_HISTORY_DAYS = 7;

const getHistory: ToolDef = {
  isWrite: false,
  spec: {
    name: 'get_history',
    description:
      '读取最近几天的每日数据(默认 7 天,最多 30 天)。用户问"这周怎么样""昨天喝了吗"时用它。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 30, description: '要回顾几天,默认 7' },
      },
      additionalProperties: false,
    },
  },
  parse: (input) => {
    const raw = input ?? {};
    const filled =
      typeof raw === 'object' && raw !== null && !('days' in raw)
        ? { ...(raw as object), days: DEFAULT_HISTORY_DAYS }
        : raw;
    const r = GetHistoryArgs.safeParse(filled);
    return r.success ? r.data : null;
  },
  async run(ctx, cupId, input) {
    const { days } = input as { days: number };
    const today = dayKey(ctx.now());
    const rows = (await ctx.store.recentAggs(cupId, today, days)).map((a) => ({
      date: a.date,
      drank_ml: a.drank_ml,
      goal_ml: a.goal_ml,
      reached: a.goal_ml > 0 && a.drank_ml >= a.goal_ml,
    }));
    const total = rows.reduce((s, r) => s + r.drank_ml, 0);
    const hit = rows.filter((r) => r.reached).length;
    return { ok: true, output: { days, rows, total_ml: total, days_reached: hit } };
  },
};

// ── 只读:get_self ───────────────────────────────────────────────

/** 判定"没电 / 烫"等的设备侧阈值(与 body.ts 的 cue 同源) */
const HOT_C = 55;
const LOW_BATTERY_PCT = 20;

const GetSelfArgs = z.object({});

const getSelf: ToolDef = {
  isWrite: false,
  spec: {
    name: 'get_self',
    description:
      '读取杯子**自己这具身体**的当前状态:电量、水温、是否在底座上、最近一次被触碰/被摔多久以前、是否被冷落太久。' +
      '杯子要报自己的电量/体温、或表达"被摔了/烫了/没劲了/被忘了"这类身体感受时用它。用户问杯子"你还好吗/还有电吗"时也用它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  parse: (input) => {
    const r = GetSelfArgs.safeParse(input ?? {});
    return r.success ? r.data : null;
  },
  async run(ctx, cupId) {
    const now = ctx.now();
    // 杯盖遥测(带电量 / 水温 / 姿态);最新的那条
    const lidPts = (await ctx.store.telemetry(cupId, 0, now)).filter(
      (p) => p.kind === 'lid' && p.lid,
    );
    const lid = lidPts.length > 0 ? lidPts[lidPts.length - 1]!.lid : undefined;

    const sample = await ctx.store.latestSample(cupId);

    // "最近一次被感知到" = 最近一条遥测融合样本(不是事件 —— 没事件但有遥测=没被忘)
    const lastSeenTs = sample ? sample.ts : null;
    const last_seen_ms = lastSeenTs === null ? null : Math.max(0, now - lastSeenTs);

    // 最近一次事件(给"为什么闹脾气"提供上下文)
    const evs = await ctx.store.events(cupId, 0, now);
    const lastEventType = evs.length > 0 ? evs[evs.length - 1]!.type : null;

    const tempC = sample?.temp_c ?? lid?.temp_c ?? null;
    const bat = lid?.battery_pct ?? null;
    const charging = lid?.charging ?? false;

    // 今天发生过的"身体事件"次数(被摔/烫/没电)
    const dayFrom = dayStart(dayKey(now));
    const todays = await ctx.store.events(cupId, dayFrom, now + 1);
    const count = (t: string) => todays.filter((e) => e.type === t).length;

    return {
      ok: true,
      output: {
        battery_pct: bat,
        charging,
        temp_c: tempC,
        on_base: sample?.present ?? (lid?.motion === 'idle' ? true : null),
        stable: sample?.stable ?? null,
        last_seen_ms,
        last_event_type: lastEventType,
        shake_today: count('shake'),
        temp_alert_today: count('temp_alert'),
        low_battery_today: count('low_battery'),
        // "被忘"的判定与 body.ts 同源(复用同一函数,口径不会漂)
        neglected: abandonedCue(lastSeenTs, now) !== null,
        neglected_after_h: ABANDON_HOURS,
        low_battery: bat !== null && bat <= LOW_BATTERY_PCT,
        too_hot: tempC !== null && tempC >= HOT_C,
      },
    };
  },
};

// ── 写:set_goal ─────────────────────────────────────────────────

const SetGoalArgs = z.object({ goal_ml: z.int().min(1).max(10_000) });

const setGoal: ToolDef = {
  isWrite: true,
  spec: {
    name: 'set_goal',
    description: '设置每日饮水目标(单位 ml,1–10000)。仅当用户明确要求改目标时才调用。',
    inputSchema: {
      type: 'object',
      properties: {
        goal_ml: { type: 'integer', minimum: 1, maximum: 10000, description: '新的每日目标 ml' },
      },
      required: ['goal_ml'],
      additionalProperties: false,
    },
  },
  parse: (input) => {
    const r = SetGoalArgs.safeParse(input);
    return r.success ? r.data : null;
  },
  async run(ctx, cupId, input) {
    const { goal_ml } = input as { goal_ml: number };
    const previous = await ctx.store.goal(cupId);
    await ctx.store.setGoal(cupId, goal_ml);
    return { ok: true, output: { goal_ml, previous_goal_ml: previous } };
  },
};

// ── 写:push_device ──────────────────────────────────────────────

/**
 * remind 的 led 效果名 —— 契约 §5 约定 `<effect>_<color>`(示例 `breath_blue`),
 * 由固件 `led_pattern.c` 解析成灯效序列。这里**收紧成一个提醒场景的枚举**:软(呼吸)
 * 到急(红闪)一档;既防模型乱填、又保证下发的名字固件一定认得。
 */
const LED_NAMES = ['breath_blue', 'breath_green', 'blink_blue', 'blink_white', 'blink_red'] as const;
/** 模型没指定 led 时的服务端默认 —— 契约 §5 的示例值,温柔的呼吸蓝 */
const DEFAULT_LED = 'breath_blue';

/** 只开放安全子集:提醒文本 + 可选灯效名。设备/指令元数据一律服务端填 */
const PushDeviceArgs = z.object({
  kind: z.literal('remind'),
  text: z.string().min(1).max(40),
  led: z.enum(LED_NAMES).optional(),
});

const PUSH_TTL_MS = 24 * 3_600_000;

const pushDevice: ToolDef = {
  isWrite: true,
  spec: {
    name: 'push_device',
    description:
      '给杯子设备排队一条提醒指令(设备下次上报时捎回,拉取式下行)。仅支持提醒文本,可选灯效名。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['remind'], description: '指令类型,目前只支持 remind' },
        text: { type: 'string', maxLength: 40, description: '提醒文本' },
        led: {
          type: 'string',
          enum: [...LED_NAMES],
          description:
            '可选灯效名(契约 §5 的 <effect>_<color>,如 breath_blue)。温柔提醒用 breath_*,' +
            '急着催用 blink_red;不确定就省略,服务端默认 breath_blue。',
        },
      },
      required: ['kind', 'text'],
      additionalProperties: false,
    },
  },
  parse: (input) => {
    const r = PushDeviceArgs.safeParse(input);
    return r.success ? r.data : null;
  },
  async run(ctx, cupId, input) {
    const { kind, text, led } = input as { kind: 'remind'; text: string; led?: string };
    const now = ctx.now();
    // target / cmd_id / ts / expires_at / type 全部服务端填 —— 不接受模型指定。
    // led 走白名单枚举(上面),缺席时服务端兜默认 —— 契约 §5 的 payload 本就是 {text, led}。
    const cmd: Command = {
      v: 1,
      cmd_id: `chat-${now}`,
      target: DEFAULT_DEVICE_TARGET,
      ts: now,
      expires_at: now + PUSH_TTL_MS,
      type: kind,
      payload: { text, led: led ?? DEFAULT_LED },
    };
    ctx.commands.enqueue(cmd);
    return { ok: true, output: { queued: true, cmd_id: cmd.cmd_id, target: cmd.target, led: led ?? DEFAULT_LED } };
  },
};

// ── 注册表 ───────────────────────────────────────────────────────

const REGISTRY: Record<string, ToolDef> = {
  get_today: getToday,
  get_history: getHistory,
  get_self: getSelf,
  set_goal: setGoal,
  push_device: pushDevice,
};

/** 全部工具说明(给模型) */
export function toolSpecs(): ToolSpec[] {
  return Object.values(REGISTRY).map((t) => t.spec);
}

/** 按名取工具;未知名 → null(白名单,调用方据此返回 {ok:false}) */
export function getTool(name: string): ToolDef | null {
  return REGISTRY[name] ?? null;
}

export { DEFAULT_GOAL_ML };
