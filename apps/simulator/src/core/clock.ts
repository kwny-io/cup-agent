/**
 * 虚拟时钟 —— 让"一秒跑一天"成为可能。
 *
 * 关键:模拟器内部**永远只用虚拟时间**,不碰 Date.now()。
 * 实时推送时把虚拟时刻当作 ts 发出,于是前端/后端看到的是"那一天"的数据流。
 * 这使长周期场景(打卡、战报、24h 曲线)能在秒级内跑完。
 */
export class VirtualClock {
  /** 虚拟时间的起点(Unix ms),通常设为某天 00:00 */
  readonly startMs: number;
  /** 加速倍率:1 实时,86400 则 1 秒 = 1 天 */
  readonly scale: number;

  /** 已推进的真实毫秒 */
  private realElapsedMs = 0;

  constructor(startMs: number, scale: number) {
    if (scale <= 0) throw new Error('scale 必须 > 0');
    this.startMs = startMs;
    this.scale = scale;
  }

  /** 当前虚拟时刻(Unix ms) */
  get nowMs(): number {
    return this.startMs + this.realElapsedMs * this.scale;
  }

  /**
   * 推进时钟。
   * @param realDeltaMs 真实流逝的毫秒(由调度器给出,通常是 tick 间隔)
   * @returns 推进前后的虚拟时刻,便于计算本 tick 覆盖的虚拟区间
   */
  advance(realDeltaMs: number): { fromMs: number; toMs: number } {
    const fromMs = this.nowMs;
    this.realElapsedMs += realDeltaMs;
    return { fromMs, toMs: this.nowMs };
  }

  /** 距起点的虚拟时长(ms) */
  get virtualElapsedMs(): number {
    return this.realElapsedMs * this.scale;
  }
}

/** 取某天**本地** 00:00 的 Unix ms。用本地零点,脚本里的 hhmm('07:00') 和日志时间才符合直觉;ts 仍是绝对 Unix ms,契约无歧义。 */
export function dayStartMs(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 把 Unix ms 格式化成本地可读时间(仅日志用,不影响契约里的 ts) */
export function fmt(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}`
  );
}
