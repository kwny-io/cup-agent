/**
 * 双源融合(D2 核心)—— 把杯盖(ToF 液位)与底座(称重)拧成一个水量估计。
 *
 * 为什么要融合:
 *   · 底座称重**精确**(±5g 级)但**失明** —— 杯子一被拿起就读不到。
 *   · 杯盖 ToF **跟着杯子走**(永远在线)但**粗糙** —— 液面波动 + 蒸汽冷凝,
 *     给动画够用,当看板数字不合格。
 *   两者互补:底座在座时做**锚**,杯盖在离座时**顶一阵**,
 *   杯子每次放回底座,就用底座把杯盖的**系统偏差**重新锚定。
 *
 * 契约早为此留好了字段:`derived_by`(谁主导)与 `confidence`(信几分)。
 * 这层是**纯软件**,不依赖 M6 真机 —— 它只认契约字段。
 *
 * 融合规则(按优先级):
 *   1. 底座在座    → 数字用底座;conf ≈0.98(已沉降)/ 0.7(沉降中)
 *   2. 底座失明    → 数字用杯盖(减掉偏置);conf 0.55,摇晃时 0.35
 *   3. 杯盖也断了  → 输出 null,上层沿用上一个估计
 *
 * 偏置追踪:底座在座且杯盖数据新鲜时,记录 (杯盖估计 − 底座真值) 做 EMA。
 * 杯盖单独顶的时候减掉这个偏置,精度立刻好一档。
 */
import { CUP, mlToLevelPct, volumeMl, type BaseTelemetry, type LidTelemetry } from '@cup/contract';
import type { FusedSample } from './types.ts';

/** 杯盖数据"新鲜"的窗口:超过它,底座就不信任杯盖来锚偏置 */
const LID_FRESH_MS = 10 * 60_000;

const CONF = {
  base: 0.98,
  baseSettling: 0.7,
  lid: 0.55,
  lidShaking: 0.35,
} as const;

/** 偏置 EMA 权重:新样本占比。太大 → 偏置抖动;太小 → 回锚慢。 */
const BIAS_ALPHA = 0.25;

function lidVolumeMl(level_pct: number): number {
  return (level_pct / 100) * CUP.capacity_ml;
}

export class CupFusion {
  private readonly cupId: string;
  /** 杯盖估计 − 底座真值(ml);杯盖单独顶时减掉它 */
  private biasMl = 0;
  private lastLid: LidTelemetry | null = null;
  private lastBase: BaseTelemetry | null = null;

  constructor(cupId: string) {
    this.cupId = cupId;
  }

  onLid(l: LidTelemetry): FusedSample {
    this.lastLid = l;
    return this.compute(l.ts);
  }

  onBase(b: BaseTelemetry): FusedSample {
    this.lastBase = b;
    // 底座在座且已沉降 + 杯盖新鲜 → 回锚偏置
    if (b.present && b.stable && this.lastLid && b.ts - this.lastLid.ts <= LID_FRESH_MS) {
      const lidEst = lidVolumeMl(this.lastLid.level_pct);
      const truth = volumeMl(b.weight_g);
      this.biasMl = this.biasMl * (1 - BIAS_ALPHA) + (lidEst - truth) * BIAS_ALPHA;
    }
    return this.compute(b.ts);
  }

  /** 当前估计(不推进状态),给"只读"场景用 */
  current(): FusedSample | null {
    const ts = Math.max(this.lastLid?.ts ?? -1, this.lastBase?.ts ?? -1);
    if (ts < 0) return null;
    return this.compute(ts);
  }

  private compute(ts: number): FusedSample {
    const base = this.lastBase;
    const lid = this.lastLid;

    // 1) 底座在座 → 用底座
    if (base && base.present) {
      const vol = Math.max(0, volumeMl(base.weight_g));
      return {
        cup_id: this.cupId,
        ts,
        volume_ml: round1(vol),
        level_pct: mlToLevelPct(vol),
        temp_c: lid ? lid.temp_c : null,
        confidence: base.stable ? CONF.base : CONF.baseSettling,
        derived_by: 'base',
        present: true,
        stable: base.stable,
      };
    }

    // 2) 底座失明 → 用杯盖(减偏置)
    if (lid) {
      const est = Math.max(0, lidVolumeMl(lid.level_pct) - this.biasMl);
      const shaking = lid.motion === 'shake';
      return {
        cup_id: this.cupId,
        ts,
        volume_ml: round1(est),
        level_pct: mlToLevelPct(est),
        temp_c: lid.temp_c,
        confidence: shaking ? CONF.lidShaking : CONF.lid,
        derived_by: 'lid',
        present: false,
        stable: false,
      };
    }

    // 3) 两路都断 → 交给上层沿用旧值
    return {
      cup_id: this.cupId,
      ts,
      volume_ml: 0,
      level_pct: 0,
      temp_c: null,
      confidence: 0,
      derived_by: 'backend',
      present: false,
      stable: false,
    };
  }
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
