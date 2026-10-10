/**
 * 去重 —— 契约约定按 `(device_id, seq)` 去重(contract §2 通用约定)。
 *
 * 为什么需要:设备离线时会攒批重传,链路(MQTT QoS1 / HTTP 重试)也会重投;
 * 同一帧到两次是常态,不是异常。不去重 → 喝水量翻倍。
 *
 * 用有界的"已见 seq 集合"而非单点高水位:Mqtt 乱序 / 迟到时会重投**旧的** seq,
 * 只记高水位会把这类重传当新数据放过去。
 */

/** 每设备记住多少条最近 seq;超过则丢弃最老的(够覆盖几天的重传窗口) */
const WINDOW_PER_DEVICE = 4096;

export interface SeqKeyed {
  device_id: string;
  seq: number;
}

export class Deduper {
  private seen = new Map<string, Set<number>>();

  /** @returns true = 首次见到,应当处理;false = 重复,应丢弃 */
  accept(item: SeqKeyed): boolean {
    let set = this.seen.get(item.device_id);
    if (!set) {
      set = new Set();
      this.seen.set(item.device_id, set);
    }
    if (set.has(item.seq)) return false;
    set.add(item.seq);
    if (set.size > WINDOW_PER_DEVICE) {
      // Set 保持插入序:删掉最老的一条
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
    return true;
  }

  /** 事件也有 device_id(来自 lid/base),但事件没有单调 seq —— 用 (id,ts,type) 键另做 */
  size(): number {
    let n = 0;
    for (const s of this.seen.values()) n += s.size;
    return n;
  }

  reset(): void {
    this.seen.clear();
  }
}

/**
 * 事件去重键:同一设备同一时刻同一类型,视作同一条。
 * 事件没有 seq,而 (device_id, ts, type) 已足够区分 —— 真机上两个"同刻同类"事件
 * 会被合并,这不影响计量(amount 相同才可能同刻同类)。
 */
export function eventKey(e: { device_id: string; ts: number; type: string }): string {
  return `${e.device_id}|${e.ts}|${e.type}`;
}
