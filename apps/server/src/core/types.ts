/**
 * 后端内部表示 —— 契约类型之外的一层薄封装。
 *
 * 原则(P1):后端只认契约里那几种报文;链路由 ingest 适配器吸收。
 * 这里定义"规范化后的点",好让 Store / 融合 / API 不关心数据从哪来。
 *
 * 字段名沿用契约的 snake_case,不转 camelCase —— 少一层映射就少一处 bug。
 */
import type { BaseTelemetry, CupEvent, LidTelemetry } from '@cup/contract';

/** 一路遥测点(去重后)。lid 与 base 共用一个外壳,便于同表时序存储。 */
export interface TelemetryPoint {
  cup_id: string;
  device_id: string;
  kind: 'lid' | 'base';
  ts: number;
  seq: number;
  /** kind==='lid' 时存在 */
  lid?: LidTelemetry;
  /** kind==='base' 时存在 */
  base?: BaseTelemetry;
}

/**
 * 融合后的"当前水量"样本(双源融合的产物,D2 核心)。
 *
 * 底座(weight_g)是精确锚:有底座就用底座(高 conf);
 * 底座失明(杯子被拿起)时退到杯盖 level_pct(低 conf)顶一阵;
 * 杯子放回底座时用底座把杯盖的系统偏差重新锚定(bias 回正)。
 */
export interface FusedSample {
  cup_id: string;
  ts: number;
  /** 估计净水量(ml)——看板"今日量"的真正来源 */
  volume_ml: number;
  /** 归一化液面 0–100 —— 前端液面高度用 */
  level_pct: number;
  /** 当前水温(°C);无杯盖数据时为 null */
  temp_c: number | null;
  /** 该估计的置信度 0–1 */
  confidence: number;
  /** 主导源(契约枚举):当前这个数字由谁驱动 */
  derived_by: 'base' | 'lid' | 'backend';
  /** 底座看得见吗 */
  present: boolean;
  /** 底座是否已沉降稳定(稳定才有资格做锚) */
  stable: boolean;
}

/**
 * 记忆卡的一天(第 3 阶段)—— "每天的点滴"沉淀成一张可 recall 的卡。
 *
 * 与 `daily_agg` 的分工:agg 是**数值 rollup**(drink/sample 热路径驱动);
 * 卡是**天翻页时一次性封存的叙事快照** —— 数值 + 当天事件 + 身体线索 + 对话蒸馏。
 * 卡里每个数字都**来自真实来源**(agg / events / turns),故 recall 把它喂回 agent 时,
 * 这些数字天然可追溯(agent.ts 对每个工具结果跑 collectNumbers)。
 */
export interface MemoryCardDetails {
  drank_ml: number;
  goal_ml: number;
  reached: boolean;
  streak: number;
  refill_count: number;
  /** 水温区间 [最低, 最高];当天无水温 → null */
  temp_range: [number, number] | null;
  /** 当天"值得记一笔"的事件(被摔/烫/没电/倾斜/离座),按 ts 升序 */
  notable_events: { type: string; ts: number }[];
  /** 当天身体线索(与 body.ts 同源的类型→cue 映射) */
  body_cues: { cue: string; evidence: string }[];
  /** 当天对话的一两句蒸馏;当天没聊 → null */
  turns_summary: string | null;
  /** 当天对话轮数 */
  turn_count: number;
}

/** 一张记忆卡(按 cup_id + 本地日存,天翻页时 UPSERT)。 */
export interface MemoryCard {
  cup_id: string;
  /** 本地日 'YYYY-MM-DD'(dayKey() 产出) */
  date: string;
  details: MemoryCardDetails;
  /** 封存时刻(ms) */
  built_at: number;
}

/** 日聚合(对应架构 §5.2 daily_agg)。 */
export interface DailyAgg {
  cup_id: string;
  /** 本地日 'YYYY-MM-DD' */
  date: string;
  drank_ml: number;
  refill_ml: number;
  /** drink 事件次数 */
  drink_count: number;
  goal_ml: number;
  /** 水温区间(来自当天杯盖遥测) */
  temp_min_c: number | null;
  temp_max_c: number | null;
  temp_avg_c: number | null;
  /** 当天最后一次融合估计的水量 */
  last_volume_ml: number | null;
  /** 连续达标天数(按日聚合历史回看) */
  streak: number;
  event_count: number;
  updated_at: number;
}
