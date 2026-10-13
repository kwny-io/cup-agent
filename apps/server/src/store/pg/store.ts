/**
 * `PgStore` —— `Store` 接口的 Postgres 实现（第 2 阶段）。
 *
 * **语义必须与 `MemoryStore` 逐条对齐**（`store-contract.test.ts` 用同一组断言跑两者）。
 * 几个关键口径（照 memory 版，别"顺手优化"）：
 *   · `goal_ml` 在**行创建时冻结**：`setGoal` 只改 `cup_settings`，**不回改**既有 `daily_agg`
 *     行 —— 与 MemoryStore 一致（streak 用**存下来的** per-day goal 比较）。
 *   · `agg()` 从不建行（只读）；`recentAggs()` 用**当前** goal 补缺天。
 *   · `applyEventToAgg` / `applySampleToAgg` 会建行（缺行时按当前 goal 建）。
 *   · `telemetry()` 保留插入语义；`events()` 按 ts 升序（对齐 memory 的 sort）。
 *
 * 事件/遥测用 **payload jsonb 存整对象**（列另有副本供索引/查询）—— 契约将来加字段
 * 也不会静默丢数据；读时直接回 payload，零形状映射。
 */
import type { CupEvent } from '@cup/contract';
import type { DailyAgg, FusedSample, MemoryCard, MemoryCardDetails, TelemetryPoint } from '../../core/types.ts';
import { dayKey, dayStart, shiftDay } from '../../core/day-boundary.ts';
import { DEFAULT_GOAL_ML, type DeleteScope, type ForgetCounts, type Store } from '../store.ts';
import { query, queryOne, withTransaction, type Pool } from './pool.ts';

interface AggRow {
  cup_id: string;
  date: string;
  drank_ml: number;
  refill_ml: number;
  drink_count: number;
  goal_ml: number;
  temp_min_c: number | null;
  temp_max_c: number | null;
  temp_avg_c: number | null;
  last_volume_ml: number | null;
  streak: number;
  event_count: number;
  updated_at: number;
}

function toAgg(r: AggRow): DailyAgg {
  return {
    cup_id: r.cup_id,
    date: r.date,
    drank_ml: r.drank_ml,
    refill_ml: r.refill_ml,
    drink_count: r.drink_count,
    goal_ml: r.goal_ml,
    temp_min_c: r.temp_min_c,
    temp_max_c: r.temp_max_c,
    temp_avg_c: r.temp_avg_c,
    last_volume_ml: r.last_volume_ml,
    streak: r.streak,
    event_count: r.event_count,
    updated_at: r.updated_at,
  };
}

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

/** 建行时 goal 的来源：该杯配的目标，否则默认 1500（对齐 memory 的 `goal()` 默认）。 */
const GOAL_SUBQ = `COALESCE((SELECT goal_ml FROM cup_settings WHERE cup_id = $1), ${DEFAULT_GOAL_ML})`;

export class PgStore implements Store {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  // ── 遥测 ───────────────────────────────────────────────────────

  async appendTelemetry(p: TelemetryPoint): Promise<void> {
    await query(
      this.pool,
      `INSERT INTO telemetry (cup_id, device_id, kind, ts, seq, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [p.cup_id, p.device_id, p.kind, p.ts, p.seq, JSON.stringify(p)],
    );
  }

  async telemetry(cupId: string, fromMs: number, toMs: number): Promise<TelemetryPoint[]> {
    const rows = await query<{ payload: TelemetryPoint }>(
      this.pool,
      `SELECT payload FROM telemetry
        WHERE cup_id = $1 AND ts >= $2 AND ts <= $3
        ORDER BY ts, id`,
      [cupId, fromMs, toMs],
    );
    return rows.map((r) => r.payload);
  }

  // ── 事件 ───────────────────────────────────────────────────────

  async appendEvent(e: CupEvent): Promise<void> {
    await query(
      this.pool,
      `INSERT INTO events (cup_id, device_id, ts, type, amount_ml, temp_c, confidence, derived_by, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        e.cup_id,
        e.device_id,
        e.ts,
        e.type,
        e.amount_ml ?? null,
        e.temp_c ?? null,
        e.confidence,
        e.derived_by,
        JSON.stringify(e),
      ],
    );
  }

  async events(cupId: string, fromMs: number, toMs: number): Promise<CupEvent[]> {
    const rows = await query<{ payload: CupEvent }>(
      this.pool,
      `SELECT payload FROM events
        WHERE cup_id = $1 AND ts >= $2 AND ts <= $3
        ORDER BY ts`,
      [cupId, fromMs, toMs],
    );
    return rows.map((r) => r.payload);
  }

  // ── 日聚合 ─────────────────────────────────────────────────────

  async applyEventToAgg(e: CupEvent): Promise<DailyAgg> {
    const date = dayKey(e.ts);
    const isDrink = e.type === 'drink';
    const isRefill = e.type === 'refill';
    const amt = e.amount_ml ?? 0;
    await query(
      this.pool,
      `INSERT INTO daily_agg (cup_id, date, goal_ml, drank_ml, refill_ml, drink_count, event_count, updated_at)
       VALUES ($1, $2, ${GOAL_SUBQ}, $3, $4, $5, 1, $6)
       ON CONFLICT (cup_id, date) DO UPDATE SET
         drank_ml    = daily_agg.drank_ml + EXCLUDED.drank_ml,
         refill_ml   = daily_agg.refill_ml + EXCLUDED.refill_ml,
         drink_count = daily_agg.drink_count + EXCLUDED.drink_count,
         event_count = daily_agg.event_count + EXCLUDED.event_count,
         updated_at  = EXCLUDED.updated_at`,
      [
        e.cup_id,
        date,
        isDrink ? amt : 0,
        isRefill ? amt : 0,
        isDrink ? 1 : 0,
        Date.now(),
      ],
    );
    const streak = await this.computeStreak(e.cup_id, date);
    await query(this.pool, `UPDATE daily_agg SET streak = $3 WHERE cup_id = $1 AND date = $2`, [
      e.cup_id,
      date,
      streak,
    ]);
    const row = await queryOne<AggRow>(
      this.pool,
      `SELECT * FROM daily_agg WHERE cup_id = $1 AND date = $2`,
      [e.cup_id, date],
    );
    return toAgg(row!);
  }

  async applySampleToAgg(s: FusedSample): Promise<void> {
    const date = dayKey(s.ts);
    const now = Date.now();
    if (s.temp_c === null || !Number.isFinite(s.temp_c)) {
      // 无温度：只刷新"最后水量"，温度列原样（对齐 memory 的 if 分支）
      await query(
        this.pool,
        `INSERT INTO daily_agg (cup_id, date, goal_ml, last_volume_ml, updated_at)
         VALUES ($1, $2, ${GOAL_SUBQ}, $3, $4)
         ON CONFLICT (cup_id, date) DO UPDATE SET
           last_volume_ml = EXCLUDED.last_volume_ml,
           updated_at     = EXCLUDED.updated_at`,
        [s.cup_id, date, s.volume_ml, now],
      );
      return;
    }
    const t = s.temp_c;
    await query(
      this.pool,
      `INSERT INTO daily_agg (cup_id, date, goal_ml, last_volume_ml,
                              temp_min_c, temp_max_c, temp_sum, temp_n, temp_avg_c, updated_at)
       VALUES ($1, $2, ${GOAL_SUBQ}, $3, $4::float8, $4::float8, $4::float8, 1,
               round(($4::float8)::numeric, 1)::float8, $5)
       ON CONFLICT (cup_id, date) DO UPDATE SET
         last_volume_ml = EXCLUDED.last_volume_ml,
         temp_min_c = LEAST(COALESCE(daily_agg.temp_min_c, EXCLUDED.temp_min_c), EXCLUDED.temp_min_c),
         temp_max_c = GREATEST(COALESCE(daily_agg.temp_max_c, EXCLUDED.temp_max_c), EXCLUDED.temp_max_c),
         temp_sum   = daily_agg.temp_sum + EXCLUDED.temp_sum,
         temp_n     = daily_agg.temp_n + 1,
         temp_avg_c = round(((daily_agg.temp_sum + EXCLUDED.temp_sum) / (daily_agg.temp_n + 1))::numeric, 1)::float8,
         updated_at = EXCLUDED.updated_at`,
      [s.cup_id, date, s.volume_ml, t, now],
    );
  }

  async agg(cupId: string, date: string): Promise<DailyAgg | null> {
    const row = await queryOne<AggRow>(
      this.pool,
      `SELECT * FROM daily_agg WHERE cup_id = $1 AND date = $2`,
      [cupId, date],
    );
    return row ? toAgg(row) : null;
  }

  async recentAggs(cupId: string, date: string, days: number): Promise<DailyAgg[]> {
    const from = shiftDay(date, -(days - 1));
    const rows = await query<AggRow>(
      this.pool,
      `SELECT * FROM daily_agg WHERE cup_id = $1 AND date >= $2 AND date <= $3`,
      [cupId, from, date],
    );
    const byDate = new Map(rows.map((r) => [r.date, toAgg(r)]));
    const goal = await this.goal(cupId);
    const out: DailyAgg[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = shiftDay(date, -i);
      out.push(byDate.get(d) ?? emptyAgg(cupId, d, goal));
    }
    return out;
  }

  async setGoal(cupId: string, goalMl: number): Promise<void> {
    await query(
      this.pool,
      `INSERT INTO cup_settings (cup_id, goal_ml) VALUES ($1, $2)
       ON CONFLICT (cup_id) DO UPDATE SET goal_ml = EXCLUDED.goal_ml`,
      [cupId, goalMl],
    );
  }

  async goal(cupId: string): Promise<number> {
    const row = await queryOne<{ goal_ml: number }>(
      this.pool,
      `SELECT goal_ml FROM cup_settings WHERE cup_id = $1`,
      [cupId],
    );
    return row?.goal_ml ?? DEFAULT_GOAL_ML;
  }

  async setLatestSample(s: FusedSample): Promise<void> {
    await query(
      this.pool,
      `INSERT INTO cup_latest (cup_id, sample, updated_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (cup_id) DO UPDATE SET sample = EXCLUDED.sample, updated_at = EXCLUDED.updated_at`,
      [s.cup_id, JSON.stringify(s), Date.now()],
    );
  }

  async latestSample(cupId: string): Promise<FusedSample | null> {
    const row = await queryOne<{ sample: FusedSample }>(
      this.pool,
      `SELECT sample FROM cup_latest WHERE cup_id = $1`,
      [cupId],
    );
    return row?.sample ?? null;
  }

  // ── 长期记忆:记忆卡(第 3 阶段)────────────────────────────────

  async putMemoryCard(card: MemoryCard): Promise<void> {
    await query(
      this.pool,
      `INSERT INTO memory_cards (cup_id, date, details, built_at) VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (cup_id, date) DO UPDATE SET details = EXCLUDED.details, built_at = EXCLUDED.built_at`,
      [card.cup_id, card.date, JSON.stringify(card.details), card.built_at],
    );
  }

  async memoryCard(cupId: string, date: string): Promise<MemoryCard | null> {
    const row = await queryOne<{ details: MemoryCardDetails; built_at: number }>(
      this.pool,
      `SELECT details, built_at FROM memory_cards WHERE cup_id = $1 AND date = $2`,
      [cupId, date],
    );
    return row ? { cup_id: cupId, date, details: row.details, built_at: row.built_at } : null;
  }

  async recentMemoryCards(cupId: string, date: string, days: number): Promise<MemoryCard[]> {
    const from = shiftDay(date, -(days - 1));
    const rows = await query<{ date: string; details: MemoryCardDetails; built_at: number }>(
      this.pool,
      `SELECT date, details, built_at FROM memory_cards
        WHERE cup_id = $1 AND date >= $2 AND date <= $3
        ORDER BY date`,
      [cupId, from, date],
    );
    // 只含有卡的天(缺天不补 —— 与 memory 实现一致:sparse)
    return rows.map((r) => ({ cup_id: cupId, date: r.date, details: r.details, built_at: r.built_at }));
  }

  // ── 删除:三档(第 4 阶段)─────────────────────────────────────
  //
  // conversation 档在本 Store 名下无物(在 ChatStore)→ no-op。memory 档只删记忆卡;
  // all 档连 telemetry/events/daily_agg/goal/最新样本一并抹。多表删除收在一个事务里,
  // 半删(删了 events 没删 agg)不可接受。行数用各 DELETE 的 rowCount 汇报。
  async forget(cupId: string, scope: DeleteScope): Promise<ForgetCounts> {
    const zero: ForgetCounts = {
      telemetry: 0,
      events: 0,
      daily_agg: 0,
      goal: 0,
      latest: 0,
      memory_cards: 0,
    };
    if (scope === 'conversation') return zero;

    return withTransaction(this.pool, async (client) => {
      const cards = await client.query(`DELETE FROM memory_cards WHERE cup_id = $1`, [cupId]);
      if (scope === 'memory') return { ...zero, memory_cards: cards.rowCount ?? 0 };

      const telemetry = await client.query(`DELETE FROM telemetry WHERE cup_id = $1`, [cupId]);
      const events = await client.query(`DELETE FROM events WHERE cup_id = $1`, [cupId]);
      const aggs = await client.query(`DELETE FROM daily_agg WHERE cup_id = $1`, [cupId]);
      const goal = await client.query(`DELETE FROM cup_settings WHERE cup_id = $1`, [cupId]);
      const latest = await client.query(`DELETE FROM cup_latest WHERE cup_id = $1`, [cupId]);
      return {
        telemetry: telemetry.rowCount ?? 0,
        events: events.rowCount ?? 0,
        daily_agg: aggs.rowCount ?? 0,
        goal: goal.rowCount ?? 0,
        latest: latest.rowCount ?? 0,
        memory_cards: cards.rowCount ?? 0,
      };
    });
  }

  // ── 内部 ───────────────────────────────────────────────────────

  /**
   * 连续达标：从今天往回数（今天没达标则从昨天起算），直到遇见"缺行或没达标"。
   * 递归 CTE 走到没达标那天自然停（递归项 JOIN 不到行 → 无产出 → 终止）。
   * 与 memory 的 `computeStreak` 同语义。
   */
  private async computeStreak(cupId: string, today: string): Promise<number> {
    const row = await queryOne<{ streak: number | null }>(
      this.pool,
      `WITH RECURSIVE seed AS (
         SELECT CASE
           WHEN (SELECT drank_ml >= goal_ml FROM daily_agg WHERE cup_id = $1 AND date = $2)
             THEN $2::text
           ELSE to_char(to_date($2, 'YYYY-MM-DD') - 1, 'YYYY-MM-DD')
         END AS d
       ),
       walk AS (
         SELECT s.d AS d, 1 AS n
           FROM seed s
           JOIN daily_agg a ON a.cup_id = $1 AND a.date = s.d AND a.drank_ml >= a.goal_ml
         UNION ALL
         SELECT to_char(to_date(w.d, 'YYYY-MM-DD') - 1, 'YYYY-MM-DD'), w.n + 1
           FROM walk w
           JOIN daily_agg a ON a.cup_id = $1
             AND a.date = to_char(to_date(w.d, 'YYYY-MM-DD') - 1, 'YYYY-MM-DD')
             AND a.drank_ml >= a.goal_ml
       )
       SELECT COALESCE(MAX(n), 0) AS streak FROM walk`,
      [cupId, today],
    );
    return row?.streak ?? 0;
  }
}

/** 保留给日界相关工具（与 memory 版同名导出，方便调用方换实现不动 import）。 */
export { dayKey, dayStart, shiftDay };
