/**
 * 实时推送 —— 架构 §5.3 的 `WS /cups/{id}/live`。
 *
 * 一个极薄的广播器:管住所有订阅者,按 cup_id 过滤,向每人推 JSON。
 * 它不知道数据从哪来(谁调 broadcast),也不知道谁在订阅(浏览器/手机/测试),
 * —— 和 ingest 对称,都是"适配器"。
 *
 * 用 ws 的 noServer 模式:HTTP 与 WS 共用同一个端口,由 http.ts 在同源上升级。
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';

export interface LiveFrame {
  /** 帧类型:给前端一个 switch 的依据 */
  kind: 'hello' | 'sample' | 'event' | 'telemetry' | 'proactive';
  /** 空 = 广播给所有 cup;有值 = 只发给订阅该 cup 的连接 */
  cup_id?: string;
  payload?: unknown;
}

interface Sub {
  sock: WebSocket;
  cupId: string | null; // null = 订阅全部
}

export class LiveHub {
  private wss = new WebSocketServer({ noServer: true });
  private subs = new Set<Sub>();

  constructor() {
    this.wss.on('connection', (sock, cupId: string | null) => {
      const sub: Sub = { sock, cupId };
      this.subs.add(sub);
      sock.send(JSON.stringify({ kind: 'hello', v: 1 }));
      sock.on('close', () => this.subs.delete(sub));
      sock.on('error', () => this.subs.delete(sub));
    });
  }

  /** 挂到 http server 上;只在 /cups/:id/live(或 /live)路径上升级 */
  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const m = url.pathname.match(/^\/cups\/([^/]+)\/live$/);
      const isLive = m !== null || url.pathname === '/live';
      if (!isLive) return;
      const cupId = m ? decodeURIComponent(m[1]!) : null;
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, cupId);
      });
    });
  }

  broadcast(frame: LiveFrame): void {
    if (this.subs.size === 0) return;
    const text = JSON.stringify(frame);
    for (const s of this.subs) {
      if (frame.cup_id && s.cupId && s.cupId !== frame.cup_id) continue;
      if (s.sock.readyState === 1) s.sock.send(text);
    }
  }

  clientCount(): number {
    return this.subs.size;
  }

  close(): void {
    for (const s of this.subs) s.sock.close();
    this.wss.close();
  }
}
