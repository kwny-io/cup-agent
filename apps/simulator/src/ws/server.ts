/**
 * 模拟器的 WebSocket 服务 —— 给前端(和临时给后端)消费数据。
 *
 * 协议:
 *   服务器 → 客户端:每条 UpstreamFrame 的 JSON(见契约 §2.1 信封)
 *   客户端 → 服务器:控制指令 {"type":"shake"|"drink"|"pause"|"resume", ...}
 *                    (前端开发时可手动触发,不必等脚本)
 *
 * 注意:这不是"后端",只是模拟器的出口。后端接模拟器时也走这里。
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { Frame } from '../core/engine.ts';
import { UpstreamFrameSchema, type UpstreamFrame } from '@cup/contract';
import type { HelloFrame } from '../util/claim.ts';

export interface WsHandle {
  broadcast: (frame: Frame) => void;
  close: () => void;
  clientCount: () => number;
  /** 实际监听的端口(`port=0` 时由内核分配,起来前返回 0) */
  port: () => number;
  /** listen 落定;`await` 之后 `port()` 才可信 */
  ready: () => Promise<void>;
}

export interface WsServerOptions {
  onControl?: (msg: unknown) => void;
  /**
   * 握手帧工厂:每个客户端连上时调一次,产出的帧发给它。默认 `() => ({kind:'hello',v:1})`。
   * 给可信绑定用 —— 传一个带 `{cup_id, device_id, claim, issued_at}` 的工厂(见 util/claim.ts),
   * 后端 sim-adapter 便能把设备自报的 claim 交给绑定校验(pg 阶段 4 前置)。
   * 不给则维持旧形(前端直连场景零变化)。
   */
  hello?: () => HelloFrame | { kind: 'hello'; v: 1 };
}

export function startWsServer(
  port: number,
  onControlOrOpts?: ((msg: unknown) => void) | WsServerOptions,
): WsHandle {
  // 兼容旧签名 `startWsServer(port, onControl)`(前端直连等既有调用点)。
  const opts: WsServerOptions =
    typeof onControlOrOpts === 'function' ? { onControl: onControlOrOpts } : (onControlOrOpts ?? {});
  const onControl = opts.onControl;
  const hello = opts.hello ?? ((): { kind: 'hello'; v: 1 } => ({ kind: 'hello', v: 1 }));

  const wss = new WebSocketServer({ port });
  const clients = new Set<WebSocket>();
  // 等 listen 落定再广播 —— port=0 时端口要到这会儿才可读;启动期不该静默丢首帧。
  const ready = new Promise<void>((resolve, reject) => {
    wss.once('listening', () => resolve());
    wss.once('error', reject);
  });

  wss.on('connection', (sock) => {
    clients.add(sock);
    // 握手:告诉客户端模拟器的设备标识(带 claim 时即可信绑定的设备半)
    sock.send(JSON.stringify(hello()));
    sock.on('close', () => clients.delete(sock));
    sock.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        onControl?.(msg);
      } catch {
        /* 忽略非法消息 */
      }
    });
  });

  return {
    broadcast(frame: Frame) {
      if (clients.size === 0) return;
      const frames = toFrames(frame);
      const text = frames.map((f) => JSON.stringify(f)).join('\n');
      for (const c of clients) {
        if (c.readyState === 1) c.send(text);
      }
    },
    close() {
      for (const c of clients) c.close();
      wss.close();
    },
    clientCount: () => clients.size,
    port() {
      const addr = wss.address();
      return typeof addr === 'object' && addr ? addr.port : 0;
    },
    /** listen 落定(port=0 时用来读真实端口) */
    ready: () => ready,
  };
}

/** 把一帧拆成契约信封(校验后发送,确保出口数据合法) */
export function toFrames(frame: Frame): UpstreamFrame[] {
  const out: UpstreamFrame[] = [];
  if (frame.lid) out.push(UpstreamFrameSchema.parse({ kind: 'lid', payload: frame.lid }));
  if (frame.base) out.push(UpstreamFrameSchema.parse({ kind: 'base', payload: frame.base }));
  for (const e of frame.events) {
    out.push(UpstreamFrameSchema.parse({ kind: 'event', payload: e }));
  }
  return out;
}
