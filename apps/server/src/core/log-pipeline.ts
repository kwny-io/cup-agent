/**
 * 日志管线 —— 把 logger 的**同步 sink** 接到两个**异步持久落点**(DB + JSONL 文件)。
 *
 * 核心不变量:
 *   · 同步 sink **只解析 + 入队,不做任何 I/O** —— 绝不阻塞每请求/每帧的热路径。
 *   · 一个异步循环负责落库 + 落文件;DB 与文件**各自独立失败**,互不牵连。
 *   · 管线自身的失败走**裸 `process.stderr.write`**,**绝不过 logger** —— 否则 DB 挂了
 *     会递归自打(日志失败 → 打日志 → 又失败 …)。
 *
 * 单个 logger 只支持一个 sink,故 `composeSinks(consoleSink, pipeline.sink)` 组合;
 * 管线激活时 logger 强制 `format:'json'`(sink 只拿到已序列化串,唯 JSON 行能结构还原)。
 *
 * 零依赖(原则 P4):文件只用 `node:fs`。
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { LOG_LEVELS, type LogLevel } from './logger.ts';
import type { LogRow } from './log-store.ts';

/** 管线句柄 —— `sink` 交给 logger;`flush`/`close` 给 app 生命周期。 */
export interface LogSinkHandle {
  readonly sink: (line: string, level: LogLevel) => void;
  /** 排干当前缓冲(不强关;给测试与周期性使用)。 */
  flush(): Promise<void>;
  /** 停表 → 等在飞的 drain → 强制全排 → 关文件。幂等。 */
  close(): Promise<void>;
}

/** 文件落点抽象 —— 生产是 `fs` 写流;测试注入内存实现。 */
export interface FileSink {
  /** 写一块;返回 false = 背压,调用方应 `await drain()`。 */
  write(chunk: string): boolean;
  /** 可继续写时 resolve(流 drain)。 */
  drain(): Promise<void>;
  end(): Promise<void>;
  onError(cb: (e: Error) => void): void;
  /** 已写字节数(轮转判定用)。 */
  readonly bytes: number;
}

export interface LogPipelineOptions {
  /** 落库口(主用 `store.append`);不给则不落库。 */
  append?: ((rows: LogRow[]) => Promise<void>) | null;
  /** JSONL 文件目录(`CUP_LOG_DIR`);不给则不落文件。 */
  dir?: string | null;
  /** 刷写周期(默认 1000ms)。 */
  intervalMs?: number;
  /** 缓冲上限(默认 1 万;超出丢最旧 + 计数)。 */
  maxBuffer?: number;
  /** 一批上限(默认 1000;达阈提前刷)。 */
  maxBatch?: number;
  /** 单文件字节上限(默认 64MiB;同日超限再切序号)。 */
  maxFileBytes?: number;
  /** 注入时钟(测试轮转用);默认 `Date.now`。 */
  now?: () => number;
  /** 自动定时刷(默认 true);测试传 false 手动 `flush()`。 */
  autoFlush?: boolean;
  /** 报错口;默认裸写 stderr(**绝不过 logger**)。 */
  reportError?: (msg: string) => void;
  /** 注入文件落点(测试);不给则用 `fs` 写流。 */
  openFile?: (path: string) => FileSink;
}

/** 默认常量。 */
export const LOG_FLUSH_INTERVAL_MS = 1000;
export const LOG_MAX_BUFFER = 10_000;
export const LOG_MAX_BATCH = 1_000;
export const LOG_MAX_FILE_BYTES = 64 * 1024 * 1024;

/** JSON 行 → 结构化列。坏行**不丢**:整行进 `msg`、`payload={raw:true}`。 */
export function parseLogLine(line: string, fallbackTs: number): LogRow {
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    if (o === null || typeof o !== 'object') throw new Error('not object');
    const { ts, level, src, msg, ...rest } = o;
    const parsedTs = typeof ts === 'string' ? Date.parse(ts) : NaN;
    return {
      ts: Number.isFinite(parsedTs) ? parsedTs : fallbackTs,
      level: (LOG_LEVELS as readonly string[]).includes(level as string) ? (level as LogLevel) : 'info',
      src: typeof src === 'string' ? src : null,
      msg: typeof msg === 'string' ? msg : line,
      payload: rest,
    };
  } catch {
    return { ts: fallbackTs, level: 'info', src: null, msg: line, payload: { raw: true } };
  }
}

/** 组合多个 sink 成单 sink:各自 try/catch,**一个抛错不牵连其余、不冒泡到热路径**。 */
export function composeSinks(
  ...sinks: ((line: string, level: LogLevel) => void)[]
): (line: string, level: LogLevel) => void {
  return (line, level) => {
    for (const s of sinks) {
      try {
        s(line, level);
      } catch {
        // 单个 sink 抛错(如 console 被替换)→ 静默,守住热路径
      }
    }
  };
}

/** 默认文件落点:`fs` 追加写流(非 `appendFileSync`)。 */
function fsFileSink(path: string): FileSink {
  const stream = createWriteStream(path, { flags: 'a', encoding: 'utf8' });
  let bytes = 0;
  let errCb: ((e: Error) => void) | null = null;
  stream.on('error', (e) => errCb?.(e));
  return {
    write(chunk: string): boolean {
      bytes += Buffer.byteLength(chunk);
      return stream.write(chunk);
    },
    drain(): Promise<void> {
      return once(stream, 'drain').then(() => undefined).catch(() => undefined);
    },
    onError(cb) {
      errCb = cb;
    },
    async end(): Promise<void> {
      if (stream.writableEnded) return;
      stream.end();
      await once(stream, 'close').catch(() => undefined);
    },
    get bytes() {
      return bytes;
    },
  };
}

/** UTC 日期键 `YYYY-MM-DD`(轮转判定;分区即按 UTC 月,与此一致)。 */
function utcDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 建日志管线。 */
export function createLogPipeline(opts: LogPipelineOptions = {}): LogSinkHandle {
  const append = opts.append ?? null;
  const dir = opts.dir ?? null;
  const intervalMs = opts.intervalMs ?? LOG_FLUSH_INTERVAL_MS;
  const maxBuffer = opts.maxBuffer ?? LOG_MAX_BUFFER;
  const maxBatch = opts.maxBatch ?? LOG_MAX_BATCH;
  const maxFileBytes = opts.maxFileBytes ?? LOG_MAX_FILE_BYTES;
  const now = opts.now ?? Date.now;
  const openFile = opts.openFile ?? fsFileSink;
  const reportError = opts.reportError ?? ((m: string) => process.stderr.write(`${m}\n`));

  const buf: LogRow[] = [];
  let overflowDropped = 0;
  let flushing = false;
  let closed = false;

  // ── 文件落点 ──
  let file: FileSink | null = null;
  let fileDisabled = false;
  let curDay = '';
  let seq = 0;
  if (dir) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e) {
      fileDisabled = true;
      reportError(`[log-pipeline] 建日志目录失败,文件落点停用:${(e as Error).message}`);
    }
  }

  function openFileFor(today: string): void {
    if (!dir || fileDisabled) return;
    const sameDay = today === curDay;
    curDay = today;
    const path = sameDay ? join(dir, `server-${today}.${++seq}.log`) : join(dir, `server-${today}.log`);
    if (!sameDay) seq = 0;
    try {
      const f = openFile(path);
      f.onError((e) => {
        if (fileDisabled) return;
        fileDisabled = true;
        reportError(`[log-pipeline] 文件落点出错,已停用:${e.message}`);
      });
      file = f;
    } catch (e) {
      fileDisabled = true;
      reportError(`[log-pipeline] 开文件失败,已停用:${(e as Error).message}`);
    }
  }

  async function writeFile(rows: LogRow[]): Promise<void> {
    if (!dir || fileDisabled) return;
    const today = utcDateKey(now());
    if (file && (today !== curDay || file.bytes >= maxFileBytes)) {
      const old = file;
      file = null;
      await old.end().catch(() => undefined);
    }
    if (!file) openFileFor(today);
    if (!file || fileDisabled) return;
    for (const r of rows) {
      const line = JSON.stringify({
        ...r.payload,
        ts: new Date(r.ts).toISOString(),
        level: r.level,
        ...(r.src ? { src: r.src } : {}),
        msg: r.msg,
      });
      if (!file.write(`${line}\n`)) await file.drain();
    }
  }

  async function drain(force = false): Promise<void> {
    if ((closed && !force) || flushing || buf.length === 0) return;
    flushing = true;
    try {
      while (buf.length > 0) {
        const batch = buf.splice(0, maxBatch);
        await writeFile(batch); // 失败已内部降级,不抛
        if (append) {
          try {
            await append(batch);
          } catch (e) {
            reportError(`[log-pipeline] DB 落点失败,丢弃 ${batch.length} 行:${(e as Error).message}`);
          }
        }
      }
      if (overflowDropped > 0) {
        reportError(`[log-pipeline] 缓冲溢出累计丢弃 ${overflowDropped} 行`);
        overflowDropped = 0;
      }
    } finally {
      flushing = false;
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  if (opts.autoFlush !== false) {
    timer = setInterval(() => void drain(), intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  const sink = (line: string, _level: LogLevel): void => {
    if (closed) return; // 关闭后的行按定义丢弃
    buf.push(parseLogLine(line, now()));
    if (buf.length > maxBuffer) {
      const over = buf.length - maxBuffer;
      overflowDropped += over;
      buf.splice(0, over); // 丢最旧(近处日志更有诊断价值)
    }
    if (buf.length >= maxBatch && !flushing) void drain();
  };

  const waitIdle = async (): Promise<void> => {
    while (flushing) await new Promise((r) => setTimeout(r, 5));
  };

  async function flush(): Promise<void> {
    await waitIdle();
    await drain(true);
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    await waitIdle();
    await drain(true); // closed=true → 需 force 才排
    if (file) await file.end().catch(() => undefined);
  }

  return { sink, flush, close };
}
