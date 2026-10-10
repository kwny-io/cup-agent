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

export interface WsHandle {
  broadcast: (frame: Frame) => void;
  close: () => void;
  clientCount: () => number;
}

export function startWsServer(port: number, onControl?: (msg: unknown) => void): WsHandle {
  const wss = new WebSocketServer({ port });
  const clients = new Set<WebSocket>();

  wss.on('connection', (sock) => {
    clients.add(sock);
    // 握手:告诉客户端模拟器的设备标识
    sock.send(JSON.stringify({ kind: 'hello', v: 1 }));
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
