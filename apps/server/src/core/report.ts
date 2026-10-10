/**
 * 每日战报 —— M4 的出口。
 *
 * **主路径是模板 + 真实数字**,不是"LLM 生成 + 模板兜底"(见 ADR T12)。
 * 这里产出的 Report 里:
 *   · facts     数字骨架,**唯一数字来源**;LLM 不许产生数字
 *   · headline  文案(模板先填好;LLM 只在上面润色语气)
 *   · source    'template' | 'llm' —— 前端据此知道走了哪条路
 *
 * 所以即使 LLM 全挂,Report 也完整、数字也真、前端也永远有东西显示(验收 3)。
 */
import type { DailyAgg } from './types.ts';
import { computePersonality, type Disposition, type Personality } from './personality.ts';

/** 战报里的数字骨架 —— 全部来自日聚合,不来自 LLM */
export interface ReportFacts {
  date: string;
  drank_ml: number;
  goal_ml: number;
  /** 0–100 */
  progress: number;
  drink_count: number;
  temp_min_c: number | null;
  temp_max_c: number | null;
  streak: number;
  reached_goal: boolean;
}

export interface Report {
  date: string;
  disposition: Disposition;
  /** 杯子状态一句话(来自性格层,LLM 可润色语气) */
  mood_line: string;
  /** 主文案 —— 模板先成立,LLM 只加语气 */
  headline: string;
  facts: ReportFacts;
  source: 'template' | 'llm';
  generated_at: number;
}

/** 由今日聚合抽出数字骨架 */
export function factsFrom(agg: DailyAgg): ReportFacts {
  const goal = agg.goal_ml > 0 ? agg.goal_ml : 0;
  const progress = goal > 0 ? Math.min(100, Math.round((agg.drank_ml / goal) * 100)) : 0;
  return {
    date: agg.date,
    drank_ml: agg.drank_ml,
    goal_ml: agg.goal_ml,
    progress,
    drink_count: agg.drink_count,
    temp_min_c: agg.temp_min_c,
    temp_max_c: agg.temp_max_c,
    streak: agg.streak,
    reached_goal: goal > 0 && agg.drank_ml >= goal,
  };
}

/**
 * 历史战报 —— 把若干天的日聚合抽成**只含数字**的每日条目(新→旧)。
 *
 * **不调 LLM**:历史战报是"数字回看",不是又一处文案出口 —— 与今日战报不同,
 * 它不润语气,故没有模型缺席的兜底问题,天生确定性(同 ADR T12 的立场更彻底)。
 * 只保留**有数据的日子**(event_count > 0):没喝的日子不该在历史里冒充一条"战报"。
 */
export function historyFacts(recent: DailyAgg[]): ReportFacts[] {
  return recent
    .filter((d) => d.event_count > 0)
    .map(factsFrom)
    .reverse();
}

/**
 * 历史某天的一句话 —— **只由那天的数字**得出,不带长期性格尾巴。
 *
 * 与 templateHeadline 不同:历史列表里每一天都重复"最近都不上心"这类长期判断会很怪
 * (长期性格是**当下**视角,不该烙进过去每一天),故这里只按当天的喝/没喝、达没达标分档。
 */
export function historyHeadline(f: ReportFacts): string {
  if (f.drink_count === 0) return '这一天一口都没喝。';
  if (f.reached_goal) return `喝了 ${f.drank_ml}ml,达标了。`;
  if (f.progress >= 50) return `喝了 ${f.drank_ml}ml(目标 ${f.goal_ml}),过半。`;
  return `才 ${f.drank_ml}ml(目标 ${f.goal_ml})。`;
}

/**
 * 脾气变化史某一天 —— {日期, 那天的长期心情, 达标了没}。
 *
 * 与战报不同:这里回放的是**长期性格的时间线**,不是当天的喝水量。
 */
export interface DispositionDay {
  date: string;
  disposition: Disposition;
  /** 那天是否达标(供前端上色,不必自己比) */
  reached_goal: boolean;
}

/**
 * 长期性格回放 —— 把"杯子这几天心情怎么变的"算成一条时间线(旧→新)。
 *
 * 对每个下标记日 `i`,用 `recent[0..i]` 当"到那天为止的历史"、`recent[i]` 当"那天",
 * 调 `computePersonality` 得到那天的 disposition —— 即"如果站在那天回看,杯子是什么脾气"。
 * 这样得到的正是现有 `report/latest` 用的同一个性格函数的**逐日切片**,不是另建一套。
 *
 * **空白日被跳过**(event_count===0 且 updated_at===0):没喝的日历日在变化史里不该占位,
 * 否则新杯子会被一串"平常"刷屏(同 reportRoute 的过滤口径)。
 *
 * 注意 streak/smug 的观感:一次达标当天即 smug(连续 2 天阈值要**两天都**出现在历史里),
 * 这正是把"连续天数"做可视化时想要的。纯函数、无 I/O。
 */
export function dispositionTimeline(recent: DailyAgg[]): DispositionDay[] {
  const history: DailyAgg[] = [];
  const out: DispositionDay[] = [];
  for (const d of recent) {
    if (d.event_count === 0 && d.updated_at === 0) continue; // 跳过空白日,不占位
    history.push(d);
    const p = computePersonality(history, d.drank_ml >= d.goal_ml && d.goal_ml > 0);
    out.push({
      date: d.date,
      disposition: p.disposition,
      reached_goal: d.goal_ml > 0 && d.drank_ml >= d.goal_ml,
    });
  }
  return out;
}

/**
 * 生成战报(模板版——永远先有这一版)。
 *
 * @param agg     今日日聚合
 * @param recent  最近 N 天聚合(旧→新),用于长期性格
 * @param nowMs   生成时刻(默认 Date.now())
 */
export function generateReport(agg: DailyAgg, recent: DailyAgg[], nowMs = Date.now()): Report {
  const facts = factsFrom(agg);
  const p = computePersonality(recent, facts.reached_goal);
  return {
    date: facts.date,
    disposition: p.disposition,
    mood_line: p.reason,
    headline: templateHeadline(p, facts),
    facts,
    source: 'template',
    generated_at: nowMs,
  };
}

/**
 * 模板文案 —— 傲娇宠物(D1):嘴上嫌弃、其实在乎。
 *
 * 每句都**内嵌真实数字**,而不是"喝得不错"这类空话 —— 数字必须真(验收 2)。
 */
export function templateHeadline(p: Personality, f: ReportFacts): string {
  // 先按"今天喝没喝"分档,再由长期性格收尾
  if (f.drink_count === 0) {
    const tail =
      p.disposition === 'sulky' ? '……杯子已经把脸转过去了。' : '杯子在角落里盯着你。';
    return `今天一口都没喝,${tail}`;
  }

  let head: string;
  if (f.reached_goal) {
    head = `喝了 ${f.drank_ml}ml,达标啦`;
  } else if (f.progress >= 50) {
    head = `已经 ${f.drank_ml}ml(目标 ${f.goal_ml}),过半了`;
  } else {
    head = `才 ${f.drank_ml}ml(目标 ${f.goal_ml}),杯子有点渴`;
  }

  // 长期心情决定尾巴 —— 傲娇:即使得意也要嘴硬
  const tail =
    p.disposition === 'smug'
      ? `——哼,也就连着 ${p.streak} 天还行而已。`
      : p.disposition === 'sulky'
        ? `——最近都不上心,杯子不太高兴。`
        : f.reached_goal
          ? `,今天挺会照顾自己。`
          : `,再冲一冲?`;

  return head + tail;
}
