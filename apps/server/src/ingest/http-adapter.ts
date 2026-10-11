/**
 * http-adapter —— 第三个 ingest 适配器:P1 原则的又一次实例化。
 *
 * 前两个:
 *   · sim-adapter  :连模拟器 WebSocket(开发/演示)
 *   · mqtt-adapter :订阅 MQTT topic(真机)
 * 这一个:
 *   · http-adapter :写端点 `POST /cups/:id/ingest` 收**批量上报**
 *
 * 为什么需要它?真机在**弱网/断网**后回传缓存(固件 `uplink_cache` 就是干这个的),
 * 用 MQTT 逐条重发既慢又占连接;一次性 POST 一坨 JSON 更省。也方便第三方
 * 小程序/脚本把数据推进来(网关中转),而**不必**实现 MQTT 客户端。
 *
 * 设计立场(与另两个适配器一致):
 *   · **契约校验在最前** —— 每帧过 `UpstreamFrameSchema`(§2),脏数据挡在门外。
 *   · **不改下游** —— 合规帧交给同一条 `Pipeline`,Store/API 一行不动(这就是 P1)。
 *   · **纯函数内核** —— `ingestEnvelope` 不碰网络、不碰时钟,可在 PC 上单测钉死;
 *     HTTP 薄壳只负责读 body + 调它 + 回计数。
 *
 * 信封形状(两种都收,给调用方选):
 *   { "frame":  {...} }             单帧
 *   { "frames": [ {...}, {...} ] }  多帧(弱网补传主用这个)
 * 帧内容即契约 §2 的 lid/base/event(与 WS/MQTT 上行**完全同形**)。
 * 额外接受一个裸数组 `[ {...} ]` / 裸对象 `{...}` 作便利(见 normalize)。
 */
import { UpstreamFrameSchema } from '@cup/contract';
import type { Pipeline } from '../core/pipeline.ts';

/** 一批最多多少帧 —— 防一次 POST 灌爆内存/CPU(粗限流,非精确配额) */
export const MAX_INGEST_BATCH = 1000;

export interface IngestResult {
  /** 通过契约校验且被管线收下(非去重丢弃)的帧数 */
  accepted: number;
  /** 合规但被管线去重丢弃(重复 seq)的帧数 */
  deduped: number;
  /** 契约校验不通过的帧数 */
  rejected: number;
  /** 逐条拒收原因(仅前若干条,避免响应体过大);格式 `[索引] 原因` */
  errors: string[];
}

const MAX_ERRORS_REPORTED = 10;

/**
 * 把请求体归一成"帧数组"。宽容三种写法,但**绝不**凭空造帧:
 *   { frame }  → [frame]
 *   { frames } → frames
 *   [ ... ]    → 数组本身
 *   { ... }    → [整对象](裸对象当单帧)
 * 其余(数字/字符串/null/{} )→ []。
 */
export function normalizeEnvelope(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const o = raw as { frame?: unknown; frames?: unknown };
    if (Array.isArray(o.frames)) return o.frames;
    if (o.frame !== undefined) return [o.frame];
    // 裸对象:像是单帧(有 kind 字段)才当一帧,否则空批
    if ((o as { kind?: unknown }).kind !== undefined) return [raw];
  }
  return [];
}

/**
 * 核心:收下一个信封,逐帧校验并灌入管线。**无副作用的地道纯逻辑**(无网络、无时钟、无全局态)。
 *
 * @param raw  已 JSON.parse 的请求体(不可信输入)
 * @param pipe 下游管线(与 WS/MQTT 适配器同一个)
 * @param expectedCupId 若给出,帧的 cup_id 必须匹配(路由级隔离:`/cups/A/ingest`
 *        不许塞 cup B 的数据)。不匹配计入 rejected。给 undefined 则不检查。
 */
export async function ingestEnvelope(
  raw: unknown,
  pipe: Pipeline,
  expectedCupId?: string,
): Promise<IngestResult> {
  const frames = normalizeEnvelope(raw);
  const res: IngestResult = { accepted: 0, deduped: 0, rejected: 0, errors: [] };

  if (frames.length > MAX_INGEST_BATCH) {
    res.rejected = frames.length;
    res.errors.push(`批过大:${frames.length} > ${MAX_INGEST_BATCH}`);
    return res;
  }

  // 逐帧**串行** await —— ingest 内含"写事件 + 写聚合"的写后读不变量,
  // 并行会破坏顺序(与 pipeline.ts 同一铁律)。
  for (let i = 0; i < frames.length; i++) {
    const item = frames[i];
    const parsed = UpstreamFrameSchema.safeParse(item);
    if (!parsed.success) {
      res.rejected += 1;
      pipe.noteRejected();
      if (res.errors.length < MAX_ERRORS_REPORTED) {
        const why = parsed.error.issues
          .map((x) => `${x.path.join('.') || '(root)'}: ${x.message}`)
          .join('; ');
        res.errors.push(`[${i}] ${why}`);
      }
      continue;
    }
    const frame = parsed.data;
    if (expectedCupId !== undefined && frame.payload.cup_id !== expectedCupId) {
      res.rejected += 1;
      pipe.noteRejected();
      if (res.errors.length < MAX_ERRORS_REPORTED) {
        res.errors.push(`[${i}] cup_id 不符:帧为 ${frame.payload.cup_id},路由为 ${expectedCupId}`);
      }
      continue;
    }
    if (await pipe.ingest(frame)) res.accepted += 1;
    else res.deduped += 1; // 合规但重复
  }

  return res;
}
