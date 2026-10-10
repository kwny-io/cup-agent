/**
 * 指令队列 —— 架构 §5.1 的"拉取式下行"落地。
 *
 * 为什么不主动推给设备:设备大部分时间在深睡(见架构 §3.3 续航),
 * 保持长连等于把续航从 62 天打到 4 天。所以服务端只把指令**排队**,
 * 等设备下次上报时顺手捎回(MQTT 响应 / HTTP 响应体 / BLE 通知)。
 *
 * M1 阶段只做"排队 + 可见";真正的捎回发生在 M5 接 MQTT 时。
 */
import type { Command } from '@cup/contract';

/**
 * 默认设备目标 —— 真机配网前,lid 指令都发到这里。
 * 收成一个常量:http.ts 的 config 与 chat 的 push_device 共用一处,
 * 免得两处各硬编一个字符串(见 tools.ts pushDevice)。
 */
export const DEFAULT_DEVICE_TARGET = 'lid-A1B2C3';

export class CommandQueue {
  private byTarget = new Map<string, Command[]>();
  private all: Command[] = [];

  enqueue(cmd: Command): void {
    let q = this.byTarget.get(cmd.target);
    if (!q) {
      q = [];
      this.byTarget.set(cmd.target, q);
    }
    q.push(cmd);
    this.all.push(cmd);
  }

  /** 设备来拉指令:取出并清空该设备的队列(顺带丢掉过期的) */
  takeFor(target: string, nowMs = Date.now()): Command[] {
    const q = this.byTarget.get(target) ?? [];
    this.byTarget.set(target, []);
    const live = q.filter((c) => c.expires_at > nowMs);
    return live;
  }

  /**
   * 捎回发布失败时把指令放回队列,下一次上行重试。
   * 只回填 `byTarget`(前插,保持原顺序),**不写 `all`** ——
   * `all` 是只增的入队历史,`takeFor` 也没从它删过,回填会造出重复。
   */
  requeue(cmds: Command[]): void {
    const byTarget = new Map<string, Command[]>();
    for (const c of cmds) {
      const arr = byTarget.get(c.target) ?? [];
      arr.push(c);
      byTarget.set(c.target, arr);
    }
    for (const [target, arr] of byTarget) {
      this.byTarget.set(target, arr.concat(this.byTarget.get(target) ?? []));
    }
  }

  /** 只看不取(调试/REST) */
  peek(target: string): Command[] {
    return this.byTarget.get(target) ?? [];
  }

  allCommands(): Command[] {
    return this.all.slice();
  }
}
