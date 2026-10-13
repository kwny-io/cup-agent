/**
 * 多日回填 —— 给"成长 / 连击 / 记忆"喂历史,不必等真杯子攒。
 *
 * 背景:杯子的**养成闭环**(成长阶段、里程碑、连续达标)全靠 `daily_agg` 里的日聚合,
 * 而日聚合要"真喝过才有数"。新装的杯子永远是第 0 天 —— 想看"一起 100 天 / 连续两周"
 * 长什么样,今天只能等 100 天,或手工造数。这一层就是**手工造数**的正式出口。
 *
 * 立场(与 day.ts / control.ts 同款纪律):
 *   · **纯合成** —— `buildBackfill` 不碰网络、不碰系统时钟,**固定 seed 同输入同输出**;
 *     HTTP 只是一层薄壳(`runBackfill`),把生成好的帧喂进后端**既有的** ingest 端点。
 *   · **只走后端既有入口** —— 直接 POST `/cups/:id/ingest`(S9 http-adapter),
 *     不碰 store、不新增端点、不改契约。后端那侧一行不动(P1)。
 *   · **只造事件,不造遥测** —— 成长/连击/续杯全部由**事件**驱动
 *     (drank_ml / refill_ml / event_count);合成 drink/refill 事件足矣,
 *     不必也不该伪造温度/液位遥测(那属于 fusion 层,造了反而是假数据)。
 *
 * 与 `--days` 的区别:`--days` 是把典型一天**重复跑 N 遍**并实时发流(演示用);
 * `--backfill` 是**离线补历史**(ts 回填到过去),一次灌进后端,给长期指标铺底。
 *
 * ⚠️ 后端事件去重是**进程内**的(按 `device_id|ts|type`)。同一次服务生命周期内重跑
 * 会被去重;但**重启后端后再跑会叠加**(日聚合是累加的)。要重置请删杯 / 换 cup_id / 清库。
 */
import { createRng, uniform } from '../util/rng.ts';
import { dayStartMs } from '../core/clock.ts';
import type { CupEvent, UpstreamFrame } from '@cup/contract';

/** 与后端 `DEFAULT_GOAL_ML` 同值(store/store.ts)。回填按它算"达标线"。 */
export const DEFAULT_GOAL_ML = 1500;

/**
 * 回填档位(给 A 的两档,对应"想长什么指标"):
 *   · `goal`   —— **每天达标**:喝够 goal + 隔天续杯 → 连击 / 累计达标 / 续杯 全阶梯解锁。
 *   · `sparse` —— **稀疏**:只铺时间跨度(最早一天 + 今天),连击/续杯基本不动,
 *                 用来单独验"阶段按天数升、里程碑大多仍锁着"。
 */
export type BackfillTier = 'goal' | 'sparse';

export interface BackfillOptions {
  cupId: string;
  baseId: string;
  /** 回溯多少天(**含今天**);`days=1` = 只有今天 */
  days: number;
  tier?: BackfillTier;
  /** 达标线(默认 {@link DEFAULT_GOAL_ML});goal 档据此切分当天饮水 */
  goalMl?: number;
  /** "今天"那天的本地 00:00(Unix ms);调用方给,便于测试注入 */
  endMs: number;
  seed?: number;
}

/** 一天的回填产物 —— `frames` 可直接塞进 `{frames:[...]}` 的 ingest 信封 */
export interface BackfillDay {
  /** 该天自然日 `'YYYY-MM-DD'`(本地) */
  date: string;
  /** 该天本地 00:00 的 Unix ms */
  atMs: number;
  events: CupEvent[];
  frames: UpstreamFrame[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (n: number): string => String(n).padStart(2, '0');

/** Unix ms → 本地自然日 `'YYYY-MM-DD'`(与后端 dayKey 的默认(本地)口径对齐) */
function localDateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 某天 00:00 + hh:mm(:ss) → Unix ms(本地墙钟,与脚本里 hhmm() 同直觉) */
function atClock(dayStart: number, hh: number, mm: number, ss = 0): number {
  return dayStart + ((hh * 60 + mm) * 60 + ss) * 1000;
}

/** 造一条底座派生事件(照 sensors/base.ts 的字段口径) */
function baseEvent(
  o: Pick<CupEvent, 'cup_id' | 'device_id' | 'ts' | 'type'> & { amount_ml?: number },
): CupEvent {
  return {
    v: 1,
    cup_id: o.cup_id,
    device_id: o.device_id,
    ts: Math.round(o.ts),
    type: o.type,
    confidence: 0.95,
    derived_by: 'base',
    ...(o.amount_ml !== undefined ? { amount_ml: o.amount_ml } : {}),
  };
}

/**
 * 造"这一天"的事件。返回按 ts 升序(同一天内先早后晚,便于链路顺序正确)。
 * @param dayIndex 0 = 最早一天,`days-1` = 今天
 */
function synthDay(
  dayStart: number,
  dayIndex: number,
  days: number,
  opts: Required<Pick<BackfillOptions, 'cupId' | 'baseId' | 'goalMl' | 'seed'>>,
  tier: BackfillTier,
): CupEvent[] {
  // 每天一条独立随机流(seed ⊕ 天序),天与天互不串扰,整体仍可复现
  const rng = createRng(opts.seed ^ Math.imul(dayIndex + 1, 0x9e3779b1));
  const dev = opts.baseId;
  const out: CupEvent[] = [];

  const lightDrink = (hh: number, ml: number): CupEvent =>
    baseEvent({ cup_id: opts.cupId, device_id: dev, ts: atClock(dayStart, hh, Math.floor(rng() * 60)), type: 'drink', amount_ml: ml });

  if (tier === 'sparse') {
    // 稀疏:只在"最早一天"给一顿达标的,今天给一顿轻的 —— 跨度拉满,连击/续杯不动。
    if (dayIndex === 0) {
      out.push(...goalDay(dayStart, rng, opts));
    } else if (dayIndex === days - 1) {
      out.push(lightDrink(10, 300)); // 未达标 → 今天 streak 归零
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  // goal 档:每天达标 + 隔天续杯
  out.push(...goalDay(dayStart, rng, opts));
  if (dayIndex % 2 === 0) {
    const amount = 300 + Math.round(rng() * 100); // 300–400ml
    out.push(baseEvent({ cup_id: opts.cupId, device_id: dev, ts: atClock(dayStart, 7, 0), type: 'refill', amount_ml: amount }));
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** 把 goal_ml 切成当天 4–6 杯,保证合计 ≥ goal(尾杯补差)—— 那天必达标 */
function goalDay(dayStart: number, rng: () => number, opts: { cupId: string; baseId: string; goalMl: number }): CupEvent[] {
  const n = 4 + Math.floor(rng() * 3); // 4..6
  const per = Math.ceil(opts.goalMl / n);
  const amounts: number[] = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const ml = Math.max(50, per + Math.round(uniform(rng, -30, 30)));
    amounts.push(ml);
    sum += ml;
  }
  if (sum < opts.goalMl) amounts[n - 1] = amounts[n - 1]! + (opts.goalMl - sum); // 尾杯补差,必达标

  const out: CupEvent[] = [];
  for (let i = 0; i < n; i++) {
    // 07:00–21:00 均匀铺开
    const hh = n === 1 ? 12 : 7 + Math.round((i * 14) / (n - 1));
    const mm = Math.floor(rng() * 60);
    out.push(
      baseEvent({
        cup_id: opts.cupId,
        device_id: opts.baseId,
        ts: atClock(dayStart, hh, mm),
        type: 'drink',
        amount_ml: amounts[i]!,
      }),
    );
  }
  return out;
}

/**
 * 生成多日回填计划(**旧 → 新**,含今天)。固定 seed → 同输出。
 *
 * 旧→新是**硬要求**:后端按事件顺序算连击,必须从最早一天开始喂,
 * 否则较早那天的 streak 会在"更早的天还没落库"时被算错且此后不再重算。
 */
export function buildBackfill(opts: BackfillOptions): BackfillDay[] {
  const days = Math.max(1, Math.floor(opts.days));
  const tier: BackfillTier = opts.tier ?? 'goal';
  const o = {
    cupId: opts.cupId,
    baseId: opts.baseId,
    goalMl: opts.goalMl ?? DEFAULT_GOAL_ML,
    seed: opts.seed ?? 42,
  };
  const out: BackfillDay[] = [];
  for (let i = 0; i < days; i++) {
    const dayStart = dayStartMs(opts.endMs) - (days - 1 - i) * DAY_MS; // i=0 最早
    const events = synthDay(dayStart, i, days, o, tier);
    out.push({
      date: localDateKey(dayStart),
      atMs: dayStart,
      events,
      frames: events.map((e) => ({ kind: 'event' as const, payload: e })),
    });
  }
  return out;
}

export interface RunBackfillOptions extends Omit<BackfillOptions, 'endMs'> {
  /** 后端 base URL,如 `http://localhost:8788` */
  server: string;
  /** 写端点设备钥(env `CUP_API_KEY`);后端开了鉴权就必须给 */
  apiKey?: string | null;
  endMs?: number;
  /** 每天一行进度(默认打到 console) */
  log?: (msg: string) => void;
}

export interface RunBackfillResult {
  days: number;
  accepted: number;
  deduped: number;
  rejected: number;
}

/**
 * 回填的 HTTP 薄壳:生成计划,每天一个 POST(**旧 → 新**串行),喂进 `/cups/:id/ingest`。
 * 一天一请求:帧数天然小于 `MAX_INGEST_BATCH`(1000),且顺序可控、进度可见。
 */
export async function runBackfill(opts: RunBackfillOptions): Promise<RunBackfillResult> {
  const plan = buildBackfill({ ...opts, endMs: opts.endMs ?? dayStartMs(Date.now()) });
  const log = opts.log ?? ((m: string) => console.log(m));
  const url = `${opts.server.replace(/\/+$/, '')}/cups/${encodeURIComponent(opts.cupId)}/ingest`;
  const res: RunBackfillResult = { days: plan.length, accepted: 0, deduped: 0, rejected: 0 };

  for (const day of plan) {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.apiKey ? { 'x-api-key': opts.apiKey } : {}),
      },
      body: JSON.stringify({ frames: day.frames }),
    });
    const body = (await r.json().catch(() => ({}))) as Partial<RunBackfillResult> & { error?: string; errors?: string[] };
    if (!r.ok) {
      throw new Error(`回填 ${day.date} 失败:HTTP ${r.status} ${body.error ?? ''} ${JSON.stringify(body.errors ?? [])}`.trim());
    }
    res.accepted += body.accepted ?? 0;
    res.deduped += body.deduped ?? 0;
    res.rejected += body.rejected ?? 0;
    log(`  ${day.date}  ${day.events.length} 事件 → 收 ${body.accepted ?? 0} / 去重 ${body.deduped ?? 0} / 拒 ${body.rejected ?? 0}`);
  }
  return res;
}
