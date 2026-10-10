/**
 * 连模拟器的 WebSocket 数据源。
 *
 * 协议见 apps/simulator/src/ws/server.ts:
 *   每行 JSON 一个 UpstreamFrame({kind:'lid'|'base'|'event', payload})
 *   连接后先收到 {kind:'hello'}(会被 schema 拒掉,跳过)
 *
 * 断线自动重连(指数退避,上限 5s):模拟器重启、换端口都不用刷页面。
 */
import { UpstreamFrameSchema, type UpstreamFrame } from '@cup/contract';
import {
  Emitter,
  type ConnectionState,
  type DataSource,
  type DataSourceEvents,
  type LiveFrame,
} from './source.ts';

export class SimulatorSource implements DataSource {
  readonly kind = 'simulator';
  private url: string;
  private ws: WebSocket | null = null;
  private em = new Emitter();
  /** 累积到下一次 flush 的帧(同一批消息合并成一帧) */
  private buffer: LiveFrame = { events: [] };
  private flushScheduled = false;
  private stopped = false;
  private retryMs = 500;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(url = 'ws://localhost:8787') {
    this.url = url;
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  disconnect(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.ws?.close();
    this.ws = null;
    this.em.emit('state', 'closed');
  }

  // 本源只发 frame/state;server 事件是 CloudSource 的事,这里实现成空订阅
  on<K extends keyof DataSourceEvents>(
    evt: K,
    cb: Parameters<DataSource['on']>[1],
  ): () => void {
    return this.em.on(evt, cb as never);
  }

  private open(): void {
    if (this.stopped) return;
    this.em.emit('state', 'connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;

    // 只用"当前"这个 socket 的事件。StrictMode 双挂载会先 close 掉上一个
    // 连接,若不过滤,那个被弃用 socket 的 onclose 会再触发一次重连,
    // 导致同一事件被两条连接重复收到。
    const current = () => this.ws === ws;

    ws.onopen = () => {
      if (!current()) return;
      this.retryMs = 500; // 连上就重置退避
      this.em.emit('state', 'open');
    };
    ws.onclose = () => {
      if (!current()) return;
      this.scheduleRetry();
    };
    ws.onerror = () => {
      if (!current()) return;
      this.em.emit('state', 'error');
      // onerror 后通常紧跟 onclose,重连交给 onclose
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (!current()) return;
      const text = typeof ev.data === 'string' ? ev.data : '';
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          continue; // 忽略坏消息
        }
        // hello 等非 UpstreamFrame 消息会被 safeParse 拒绝,直接跳过
        const parsed = UpstreamFrameSchema.safeParse(raw);
        if (!parsed.success) continue;
        this.absorb(parsed.data);
      }
    };
  }

  private scheduleRetry(): void {
    if (this.stopped) {
      this.em.emit('state', 'closed');
      return;
    }
    this.em.emit('state', 'connecting');
    this.retryTimer = setTimeout(() => this.open(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 5000);
  }

  private absorb(frame: UpstreamFrame): void {
    switch (frame.kind) {
      case 'lid':
        this.buffer.lid = frame.payload;
        break;
      case 'base':
        this.buffer.base = frame.payload;
        break;
      case 'event':
        this.buffer.events.push(frame.payload);
        break;
    }
    // 合并同一批消息成一次 frame 事件,避免 React 频繁重渲染
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  private flush(): void {
    this.flushScheduled = false;
    const f = this.buffer;
    this.buffer = { events: [] };
    if (!f.lid && !f.base && f.events.length === 0) return; // 空帧不发
    this.em.emit('frame', f);
  }
}

export function currentStateLabel(s: ConnectionState): string {
  return (
    {
      connecting: '连接中…',
      open: '已连接',
      closed: '已断开',
      error: '连接失败',
    } as const
  )[s];
}
