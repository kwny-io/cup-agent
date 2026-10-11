/**
 * 事件管线 —— ingest 进来的帧,在这里变成"存储 + 实时推送"。
 *
 * 流程(对应架构 §5.1):
 *   校验后的帧 ──► 去重 ──► 融合 ──► 日聚合 ──► Store ──► 广播给订阅者
 *
 * 校验(契约 §2)在 ingest 适配器里最先做;这里收到的都是已过 §2 的帧。
 * 设计上这层**不关心链路** —— 模拟器、MQTT、HTTP 中转到这儿长得一样(P1)。
 */
import type { BaseTelemetry, CupEvent, LidTelemetry, UpstreamFrame } from '@cup/contract';
import { Deduper, eventKey } from './dedupe.ts';
import { CupFusion } from './fusion.ts';
import type { FusedSample, TelemetryPoint } from './types.ts';
import type { Store } from '../store/store.ts';
import { dayKey } from '../store/store.ts';

export interface PipelineEvents {
  /** 一条新的融合样本(前端液面/看板的人数来源) */
  sample?: (s: FusedSample) => void;
  /** 一条新事件 */
  event?: (e: CupEvent) => void;
  /** 接受的遥测点(给序列 API / 调试) */
  telemetry?: (p: TelemetryPoint) => void;
}

export class Pipeline {
  private readonly store: Store;
  private readonly deduper = new Deduper();
  private readonly fusions = new Map<string, CupFusion>();
  private readonly em: PipelineEvents;
  private readonly seenEvents = new Set<string>();
  /** 统计:被拒收的报文数(验收 4 要可观测) */
  private rejected = 0;

  constructor(store: Store, em: PipelineEvents = {}) {
    this.store = store;
    this.em = em;
  }

  /**
   * 处理一帧(已过 §2 校验)。
   * @returns 是否被接受(false = 去重丢弃)
   */
  async ingest(frame: UpstreamFrame): Promise<boolean> {
    switch (frame.kind) {
      case 'lid':
        return this.onLid(frame.payload);
      case 'base':
        return this.onBase(frame.payload);
      case 'event':
        return this.onEvent(frame.payload);
    }
  }

  private fusion(cupId: string): CupFusion {
    let f = this.fusions.get(cupId);
    if (!f) {
      f = new CupFusion(cupId);
      this.fusions.set(cupId, f);
    }
    return f;
  }

  private async onLid(l: LidTelemetry): Promise<boolean> {
    if (!this.deduper.accept(l)) return false;
    const p: TelemetryPoint = {
      cup_id: l.cup_id,
      device_id: l.device_id,
      kind: 'lid',
      ts: l.ts,
      seq: l.seq,
      lid: l,
    };
    await this.store.appendTelemetry(p);
    this.em.telemetry?.(p);

    const s = this.fusion(l.cup_id).onLid(l);
    await this.commit(s);
    return true;
  }

  private async onBase(b: BaseTelemetry): Promise<boolean> {
    if (!this.deduper.accept(b)) return false;
    const p: TelemetryPoint = {
      cup_id: b.cup_id,
      device_id: b.device_id,
      kind: 'base',
      ts: b.ts,
      seq: b.seq,
      base: b,
    };
    await this.store.appendTelemetry(p);
    this.em.telemetry?.(p);

    const s = this.fusion(b.cup_id).onBase(b);
    await this.commit(s);
    return true;
  }

  private async onEvent(e: CupEvent): Promise<boolean> {
    // 事件无 seq,用 (device_id, ts, type) 去重
    const key = eventKey(e);
    if (this.seenEvents.has(key)) return false;
    this.seenEvents.add(key);
    // 有界:超过 8192 清掉一半(简单游标,够用)
    if (this.seenEvents.size > 8192) {
      const drop = [...this.seenEvents].slice(0, 4096);
      for (const k of drop) this.seenEvents.delete(k);
    }

    // 写后读必须**串行**:appendEvent 落定后再 applyEventToAgg。
    // 绝不可 Promise.all —— 否则聚合可能读到"事件还没落"的状态,静默毁 streak/聚合。
    await this.store.appendEvent(e);
    await this.store.applyEventToAgg(e);
    this.em.event?.(e);
    return true;
  }

  private async commit(s: FusedSample): Promise<void> {
    await this.store.setLatestSample(s);
    await this.store.applySampleToAgg(s);
    this.em.sample?.(s);
  }

  noteRejected(): void {
    this.rejected += 1;
  }

  stats(): { rejected: number; dedupeWindow: number } {
    return { rejected: this.rejected, dedupeWindow: this.deduper.size() };
  }

  /** 给 REST 用的便捷只读入口 */
  today(cupId: string, nowMs = Date.now()) {
    return this.store.agg(cupId, dayKey(nowMs));
  }
}
