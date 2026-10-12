/**
 * sim-adapter —— 后端接模拟器的入口(P1 适配器的第一个实现)。
 *
 * 它只做三件事:
 *   1. 连模拟器的 WebSocket(模拟器 `--ws <port>` 起的就是它)
 *   2. 按行切 JSON,逐条用 `UpstreamFrameSchema` 做 §2 契约校验(验收 4)
 *   3. 合法的交管线;不合法的**记日志并丢弃**,绝不让脏数据进 Store
 *
 * 将来接真机:新增 mqtt-adapter,把"连 WS"换成"订阅 topic",
 * 下游(管线/Store/API)一行不动 —— 这就是 P1 的意义。
 *
 * 自动重连:模拟器重启 / 网络抖动时自己接回来,指数退避封顶 5s。
 */
import { WebSocket } from 'ws';
import { UpstreamFrameSchema } from '@cup/contract';
import type { Pipeline } from '../core/pipeline.ts';

export interface SimAdapterOptions {
  url: string;
  pipeline: Pipeline;
  /** 日志出口;默认 console。测试里可换成收集器 */
  log?: (msg: string, level?: 'info' | 'warn' | 'error') => void;
  /**
   * 收到 hello 握手帧时回调(可信绑定用,见 core/social/claim.ts)。
   * WS 出口**没有 topic**,故 deviceId 只能取自 hello 自报的 `device_id` 字段(模拟器为本地开发路径,
   * 信任级别与整条 WS 连接一致);缺字段 → 传空串,ClaimService 会当 no-op。
   */
  onHello?: (deviceId: string, hello: Record<string, unknown>) => void | Promise<void>;
}

export interface SimAdapterHandle {
  stop: () => void;
  /** 已接受的帧数 */
  accepted: () => number;
  /** 被契约校验拒收的帧数 */
  rejected: () => number;
}

const MAX_BACKOFF_MS = 5000;

export function startSimAdapter(opts: SimAdapterOptions): SimAdapterHandle {
  const log = opts.log ?? ((m, l = 'info') => console[l](m));
  let accepted = 0;
  let rejected = 0;
  let stopped = false;
  let retryMs = 500;
  let timer: NodeJS.Timeout | null = null;
  /** 闭包守卫:防止旧的 socket 回调污染新连接(参考前端 simulator.ts 的 current()) */
  let sock: WebSocket | null = null;

  const isCurrent = (s: WebSocket): boolean => sock === s;

  const connect = (): void => {
    if (stopped) return;
    log(`[sim-adapter] 连接 ${opts.url} …`);
    const ws = new WebSocket(opts.url);
    sock = ws;

    ws.on('open', () => {
      if (!isCurrent(ws)) return;
      retryMs = 500;
      log('[sim-adapter] 已连接');
    });

    ws.on('message', (data: Buffer) => {
      if (!isCurrent(ws)) return;
      // 模拟器一次广播可能是多行(一帧拆成 lid/base/event 多条,见其 ws/server.ts)
      const lines = data.toString().split('\n');
      for (const line of lines) {
        const text = line.trim();
        if (text.length === 0) continue;
        handleLine(text);
      }
    });

    ws.on('error', (err: Error) => {
      if (!isCurrent(ws)) return;
      log(`[sim-adapter] 连接错误: ${err.message}`, 'warn');
    });

    ws.on('close', () => {
      if (!isCurrent(ws)) return;
      sock = null;
      if (stopped) return;
      log(`[sim-adapter] 断开,${retryMs}ms 后重连`, 'warn');
      timer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, MAX_BACKOFF_MS);
    });
  };

  const handleLine = (text: string): void => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      rejected += 1;
      opts.pipeline.noteRejected();
      log(`[sim-adapter] 拒收:不是合法 JSON — ${text.slice(0, 120)}`, 'error');
      return;
    }

    // 握手帧 {kind:'hello'} 不是契约报文,静默放行(模拟器起手发它)
    if (raw && typeof raw === 'object' && (raw as { kind?: string }).kind === 'hello') {
      log('[sim-adapter] 收到 hello 握手');
      // 可信绑定:WS 出口无 topic,deviceId 只能取自 hello 自报字段(见 SimAdapterOptions.onHello)。
      if (opts.onHello) {
        const h = raw as Record<string, unknown>;
        const deviceId = typeof h.device_id === 'string' ? h.device_id : '';
        try {
          void Promise.resolve(opts.onHello(deviceId, h)).catch((err: unknown) => {
            log(`[sim-adapter] onHello 异常:${err instanceof Error ? err.message : String(err)}`, 'error');
          });
        } catch (err: unknown) {
          log(`[sim-adapter] onHello 异常:${err instanceof Error ? err.message : String(err)}`, 'error');
        }
      }
      return;
    }

    const parsed = UpstreamFrameSchema.safeParse(raw);
    if (!parsed.success) {
      rejected += 1;
      opts.pipeline.noteRejected();
      const why = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      log(`[sim-adapter] 拒收:不符合契约 §2 — ${why}`, 'error');
      return;
    }

    // ingest 现在 async:不 await(适配器不该为等一次落盘阻塞入站),尾挂 catch 防未捕获拒绝。
    void opts.pipeline
      .ingest(parsed.data)
      .then((ok) => {
        if (ok) accepted += 1;
      })
      .catch((err: unknown) => {
        log(`[sim-adapter] 入站异常:${err instanceof Error ? err.message : String(err)}`, 'error');
      });
  };

  connect();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      sock?.close();
      sock = null;
    },
    accepted: () => accepted,
    rejected: () => rejected,
  };
}
