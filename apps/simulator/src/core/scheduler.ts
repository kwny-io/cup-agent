/**
 * 虚拟时间调度器 —— 所有"未来某个虚拟时刻要做的事"都排在这里。
 *
 * 这是时间加速的关键:传感器不靠高频轮询,而是把"沉降检查""下次上报"
 * 排进时间线,加速时这些时刻会被瞬间跨过,不产生采样开销。
 */
export interface ScheduledOp {
  atMs: number;
  seq: number; // 同一时刻的稳定排序
  fn: () => void;
  label: string;
}

export class Scheduler {
  private ops: ScheduledOp[] = [];
  private seqCounter = 0;

  /** 排一个未来时刻执行的操作 */
  at(atMs: number, fn: () => void, label = ''): void {
    const op: ScheduledOp = { atMs, seq: this.seqCounter++, fn, label };
    // 二分插入,保持按时刻有序(规模很小,但保持确定性排序)
    let lo = 0;
    let hi = this.ops.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const m = this.ops[mid]!;
      if (m.atMs < op.atMs || (m.atMs === op.atMs && m.seq < op.seq)) lo = mid + 1;
      else hi = mid;
    }
    this.ops.splice(lo, 0, op);
  }

  /** 执行所有到期的操作(按时刻顺序),返回执行条数 */
  runDue(nowMs: number): number {
    let n = 0;
    while (this.ops.length > 0 && this.ops[0]!.atMs <= nowMs) {
      const op = this.ops.shift()!;
      op.fn();
      n++;
    }
    return n;
  }

  get pendingCount(): number {
    return this.ops.length;
  }
}
