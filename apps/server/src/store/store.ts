/**
 * Store —— 接口 + 内存实现(P4:按需引入工具)。
 *
 * 为什么先内存:此刻唯一的理由是"让 M1 的读数立刻能跑通"。
 * Postgres(架构 §8 建议)要等真有"重启不丢 / 多设备 / 查询历史"的理由再上 ——
 * 到时候**只换实现,不动上层**,因为上层只认这个接口。
 *
 * 接口形状照架构 §5.2 数据模型(telemetry / events / daily_agg),将来换真库对得上。
 */
import type { CupEvent } from '@cup/contract';
import type { DailyAgg, FusedSample, TelemetryPoint } from '../core/types.ts';
import { dayKey, dayStart, shiftDay } from '../core/day-boundary.ts';

/**
 * 存储接口 —— **全部方法返回 Promise**。
 *
 * 为什么全 async(而非"内存工作集 + 异步写回"):十万用户单进程放不下工作集;
 * 写回层会把"`applyEventToAgg` 还没落就有人读 streak"这类顺序 bug 藏到最深处。
 * 全 async 是一次性、机械的改动,且 HTTP 层本就是 async。
 * `MemoryStore` 是最新的默认实现(内存无真 I/O,`async` 只是包一层),零基建照跑;
 * 将来 `PgStore` 只换实现,不动上层(T3)。**写后读的两步必须串行**(见 pipeline.ts)。
 */
export interface Store {
  // ── 时序:遥测点 ──
  appendTelemetry(p: TelemetryPoint): Promise<void>;
  telemetry(cupId: string, fromMs: number, toMs: number): Promise<TelemetryPoint[]>;

  // ── 关系:事件 ──
  appendEvent(e: CupEvent): Promise<void>;
  events(cupId: string, fromMs: number, toMs: number): Promise<CupEvent[]>;

  // ── 汇总:日聚合 ──
  /** 把一条事件累加进它所属那天的聚合,返回刷新后的聚合 */
  applyEventToAgg(e: CupEvent): Promise<DailyAgg>;
  /** 用融合样本刷新那天的"最后水量 / 水温区间"(遥测驱动,非事件) */
  applySampleToAgg(s: FusedSample): Promise<void>;

  agg(cupId: string, date: string): Promise<DailyAgg | null>;
  /** 最近 n 天的聚合(旧→新),用于 streak 与战报 */
  recentAggs(cupId: string, date: string, days: number): Promise<DailyAgg[]>;
  setGoal(cupId: string, goalMl: number): Promise<void>;
  goal(cupId: string): Promise<number>;

  /** 当前融合估计的快照(给 WS 首帧 / REST /state) */
  setLatestSample(s: FusedSample): Promise<void>;
  latestSample(cupId: string): Promise<FusedSample | null>;
}

// ── 日界 ─────────────────────────────────────────────────────────
// 实现搬到 core/day-boundary.ts(支持按 --tz/CUP_TZ 配置时区);这里 re-export,
// 所有 `import { dayKey } from .../store.ts` 的调用点无需改动。

export { dayKey, dayStart, shiftDay, setDayTimeZone, getDayTimeZone } from '../core/day-boundary.ts';

export const DEFAULT_GOAL_ML = 1500;

function emptyAgg(cupId: string, date: string, goalMl: number): DailyAgg {
  return {
    cup_id: cupId,
    date,
    drank_ml: 0,
    refill_ml: 0,
    drink_count: 0,
    goal_ml: goalMl,
    temp_min_c: null,
    temp_max_c: null,
    temp_avg_c: null,
    last_volume_ml: null,
    streak: 0,
    event_count: 0,
    updated_at: 0,
  };
}

// ── 内存实现 ─────────────────────────────────────────────────────

/** 构造选项 —— 让持久化"只换实现、不动上层"(T3):目标恢复 + 变更回调 */
export interface MemoryStoreOptions {
  /** 启动时恢复的目标(cupId → ml);来自上次落盘 */
  goals?: Record<string, number>;
  /** 目标变更回调 —— 接线到 FilePersistence.setGoal,实现目标落盘 */
  onGoal?: (cupId: string, ml: number) => void;
}

export class MemoryStore implements Store {
  private telemetryByCup = new Map<string, TelemetryPoint[]>();
  private eventsByCup = new Map<string, CupEvent[]>();
  private aggs = new Map<string, DailyAgg>(); // key: `${cupId}|${date}`
  private goals = new Map<string, number>();
  private latest = new Map<string, FusedSample>();
  /** 日均温的增量累计:{ `${cupId}|${date}` → {sum, n} },免得留样本数组 */
  private tempAcc = new Map<string, { sum: number; n: number }>();
  private readonly onGoal?: (cupId: string, ml: number) => void;

  constructor(opts: MemoryStoreOptions = {}) {
    for (const [cupId, ml] of Object.entries(opts.goals ?? {})) this.goals.set(cupId, ml);
    this.onGoal = opts.onGoal;
  }

  async appendTelemetry(p: TelemetryPoint): Promise<void> {
    let arr = this.telemetryByCup.get(p.cup_id);
    if (!arr) {
      arr = [];
      this.telemetryByCup.set(p.cup_id, arr);
    }
    arr.push(p);
  }

  async telemetry(cupId: string, fromMs: number, toMs: number): Promise<TelemetryPoint[]> {
    const arr = this.telemetryByCup.get(cupId) ?? [];
    return arr.filter((p) => p.ts >= fromMs && p.ts <= toMs);
  }

  async appendEvent(e: CupEvent): Promise<void> {
    let arr = this.eventsByCup.get(e.cup_id);
    if (!arr) {
      arr = [];
      this.eventsByCup.set(e.cup_id, arr);
    }
    arr.push(e);
    // 按 ts 排序,容忍迟到(乱序到达的事件归位)
    arr.sort((a, b) => a.ts - b.ts);
  }

  async events(cupId: string, fromMs: number, toMs: number): Promise<CupEvent[]> {
    const arr = this.eventsByCup.get(cupId) ?? [];
    return arr.filter((e) => e.ts >= fromMs && e.ts <= toMs);
  }

  async goal(cupId: string): Promise<number> {
    return this.goals.get(cupId) ?? DEFAULT_GOAL_ML;
  }

  async setGoal(cupId: string, goalMl: number): Promise<void> {
    this.goals.set(cupId, goalMl);
    this.onGoal?.(cupId, goalMl);
  }

  private async getAgg(cupId: string, date: string): Promise<DailyAgg> {
    const key = `${cupId}|${date}`;
    let a = this.aggs.get(key);
    if (!a) {
      a = emptyAgg(cupId, date, await this.goal(cupId));
      this.aggs.set(key, a);
    }
    return a;
  }

  async applyEventToAgg(e: CupEvent): Promise<DailyAgg> {
    const a = await this.getAgg(e.cup_id, dayKey(e.ts));
    a.event_count += 1;
    if (e.type === 'drink') {
      a.drank_ml += e.amount_ml ?? 0;
      a.drink_count += 1;
    } else if (e.type === 'refill') {
      a.refill_ml += e.amount_ml ?? 0;
    }
    a.updated_at = Date.now();
    a.streak = this.computeStreak(e.cup_id, a.date);
    return a;
  }

  async applySampleToAgg(s: FusedSample): Promise<void> {
    const date = dayKey(s.ts);
    const a = await this.getAgg(s.cup_id, date);
    a.last_volume_ml = s.volume_ml;
    if (s.temp_c !== null && Number.isFinite(s.temp_c)) {
      a.temp_min_c = a.temp_min_c === null ? s.temp_c : Math.min(a.temp_min_c, s.temp_c);
      a.temp_max_c = a.temp_max_c === null ? s.temp_c : Math.max(a.temp_max_c, s.temp_c);
      const key = `${s.cup_id}|${date}`;
      const acc = this.tempAcc.get(key) ?? { sum: 0, n: 0 };
      acc.sum += s.temp_c;
      acc.n += 1;
      this.tempAcc.set(key, acc);
      a.temp_avg_c = Math.round((acc.sum / acc.n) * 10) / 10;
    }
    a.updated_at = Date.now();
  }

  async agg(cupId: string, date: string): Promise<DailyAgg | null> {
    return this.aggs.get(`${cupId}|${date}`) ?? null;
  }

  async recentAggs(cupId: string, date: string, days: number): Promise<DailyAgg[]> {
    const goal = await this.goal(cupId);
    const out: DailyAgg[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = shiftDay(date, -i);
      out.push(this.aggs.get(`${cupId}|${d}`) ?? emptyAgg(cupId, d, goal));
    }
    return out;
  }

  async setLatestSample(s: FusedSample): Promise<void> {
    this.latest.set(s.cup_id, s);
  }

  async latestSample(cupId: string): Promise<FusedSample | null> {
    return this.latest.get(cupId) ?? null;
  }

  /**
   * 连续达标:从今天往回数,连续满足 drank_ml >= goal 的天数。
   * 今天还没达标不算断链(今天尚未结束)→ 从昨天起算。
   */
  private computeStreak(cupId: string, today: string): number {
    let n = 0;
    const todayAgg = this.aggs.get(`${cupId}|${today}`);
    const todayOk = todayAgg ? todayAgg.drank_ml >= todayAgg.goal_ml : false;
    let cursor = todayOk ? today : shiftDay(today, -1);
    for (;;) {
      const a = this.aggs.get(`${cupId}|${cursor}`);
      if (a && a.drank_ml >= a.goal_ml) {
        n += 1;
        cursor = shiftDay(cursor, -1);
      } else {
        break;
      }
    }
    return n;
  }
}
