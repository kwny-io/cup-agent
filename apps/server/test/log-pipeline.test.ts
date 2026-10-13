/**
 * 日志管线 —— 缓冲 + 异步刷写 + DB/文件双落点。零基建(注入内存文件 sink / 假 append)。
 *
 * 钉的核心不变量:
 *   · 同步 sink **只入队、不做 I/O**(`autoFlush:false` 时无任何落点被触达);
 *   · `parseLogLine` 好坏行都能还原、ts/level 非法各自回退;
 *   · 缓冲溢出**丢最旧**、并报一次;
 *   · DB 落点失败 → 丢该批 + **静默 stderr**(绝不过 logger 递归);
 *   · 文件按 UTC 日期轮转、超字节再切序号;
 *   · `close()` 排干所有缓冲(setInterval 停掉、文件关闭)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createLogPipeline,
  parseLogLine,
  composeSinks,
  LOG_MAX_BATCH,
  type FileSink,
  type LogRow,
} from '@cup/server';

/** 真临时目录(管线构造时会 mkdirSync;注入的 openFile 不真写盘,故只需可建)。 */
function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'cup-log-'));
}

/** 内存文件 sink —— 记录每次 write 的分块 + 记录关闭。 */
function memFileSink(): FileSink & { chunks: string[]; ended: boolean } {
  const chunks: string[] = [];
  let errCb: ((e: Error) => void) | null = null;
  let total = 0;
  return {
    chunks,
    ended: false,
    write(chunk: string): boolean {
      chunks.push(chunk);
      total += Buffer.byteLength(chunk);
      return true; // 不背压
    },
    drain: () => Promise.resolve(),
    end(): Promise<void> {
      this.ended = true;
      return Promise.resolve();
    },
    onError(cb) {
      errCb = cb;
    },
    get bytes() {
      return total;
    },
    // 测试辅助:触发一次写流错误
    _fail(e: Error) {
      errCb?.(e);
    },
  } as FileSink & { chunks: string[]; ended: boolean; _fail(e: Error): void };
}

test('parseLogLine:正常 JSON 行还原成列(其余字段进 payload)', () => {
  const r = parseLogLine(
    JSON.stringify({ ts: '2026-10-13T00:00:00.000Z', level: 'warn', src: 'http', msg: 'hi', cupId: 'cup-A1' }),
    999,
  );
  assert.equal(r.ts, Date.parse('2026-10-13T00:00:00.000Z'));
  assert.equal(r.level, 'warn');
  assert.equal(r.src, 'http');
  assert.equal(r.msg, 'hi');
  assert.deepEqual(r.payload, { cupId: 'cup-A1' });
});

test('parseLogLine:ts 非法 → 回退 fallbackTs;level 非法 → info;坏行不丢', () => {
  const r1 = parseLogLine(JSON.stringify({ ts: 'not-a-date', level: 'bogus', msg: 'x' }), 12345);
  assert.equal(r1.ts, 12345);
  assert.equal(r1.level, 'info');
  assert.equal(r1.msg, 'x');

  const r2 = parseLogLine('plain text not json', 777);
  assert.equal(r2.ts, 777);
  assert.equal(r2.level, 'info');
  assert.equal(r2.src, null);
  assert.equal(r2.msg, 'plain text not json');
  assert.deepEqual(r2.payload, { raw: true });
});

test('parseLogLine:src 缺省 → null', () => {
  const r = parseLogLine(JSON.stringify({ ts: 1, level: 'info', msg: 'm' }), 0);
  assert.equal(r.src, null);
});

test('composeSinks:一个 sink 抛错不牵连其余', () => {
  const seen: string[] = [];
  const boom = (): void => {
    throw new Error('boom');
  };
  const sink = composeSinks(boom, (line) => seen.push(line));
  sink('hello', 'info');
  assert.deepEqual(seen, ['hello']);
});

test('同步 sink 只入队:autoFlush 关时,append 未被触达', async () => {
  let appended: LogRow[] = [];
  const p = createLogPipeline({
    append: (rows) => {
      appended = appended.concat(rows);
      return Promise.resolve();
    },
    autoFlush: false,
    now: () => 1000,
  });
  p.sink(JSON.stringify({ ts: 1000, level: 'info', msg: 'a' }), 'info');
  p.sink(JSON.stringify({ ts: 1000, level: 'warn', msg: 'b' }), 'warn');
  assert.equal(appended.length, 0, '未 flush 前不该落库');
  await p.flush();
  assert.equal(appended.length, 2);
  await p.close();
});

test('缓冲溢出 → 丢最旧 + 报一次', async () => {
  const errors: string[] = [];
  let got: LogRow[] = [];
  const p = createLogPipeline({
    append: (rows) => {
      got = got.concat(rows);
      return Promise.resolve();
    },
    autoFlush: false,
    maxBuffer: 3,
    reportError: (m) => errors.push(m),
    now: () => 0,
  });
  for (let i = 0; i < 5; i++) {
    p.sink(JSON.stringify({ ts: i, level: 'info', msg: `m${i}` }), 'info');
  }
  await p.flush();
  assert.deepEqual(errors.filter((e) => e.includes('缓冲溢出')), ['[log-pipeline] 缓冲溢出累计丢弃 2 行']);
  // 丢的是最旧两条(m0/m1),留最新三条
  assert.deepEqual(got.map((r) => r.msg), ['m2', 'm3', 'm4']);
  await p.close();
});

test('DB 落点失败 → 丢该批 + 走裸 stderr(不抛、不递归)', async () => {
  const errors: string[] = [];
  const p = createLogPipeline({
    append: () => Promise.reject(new Error('db down')),
    autoFlush: false,
    reportError: (m) => errors.push(m),
    now: () => 0,
  });
  p.sink(JSON.stringify({ ts: 1, level: 'error', msg: 'x' }), 'error');
  await p.flush(); // 不该抛
  assert.ok(errors.some((e) => e.includes('DB 落点失败') && e.includes('丢弃 1 行')));
  await p.close();
});

test('批上限:满 maxBatch 时一批只落这么多', async () => {
  const batches: number[] = [];
  const p = createLogPipeline({
    append: (rows) => {
      batches.push(rows.length);
      return Promise.resolve();
    },
    autoFlush: false,
    maxBatch: 2,
    now: () => 0,
  });
  for (let i = 0; i < 5; i++) p.sink(JSON.stringify({ ts: i, level: 'info', msg: `m${i}` }), 'info');
  await p.flush();
  assert.deepEqual(batches, [2, 2, 1]);
  await p.close();
});

test('文件落点:按行写 JSONL', async () => {
  const dir = tmpDir();
  const files = new Map<string, ReturnType<typeof memFileSink>>();
  const p = createLogPipeline({
    dir,
    autoFlush: false,
    now: () => Date.UTC(2026, 9, 13, 12),
    openFile: (path) => {
      const f = memFileSink();
      files.set(path, f);
      return f;
    },
  });
  p.sink(JSON.stringify({ ts: Date.UTC(2026, 9, 13, 12), level: 'info', src: 'http', msg: 'a' }), 'info');
  p.sink(JSON.stringify({ ts: Date.UTC(2026, 9, 13, 12), level: 'warn', msg: 'b' }), 'warn');
  await p.flush();
  const f = files.get(join(dir, 'server-2026-10-13.log'));
  assert.ok(f, '按 UTC 日期命名的文件已建');
  assert.equal(f!.chunks.length, 2);
  const first = JSON.parse(f!.chunks[0]!) as Record<string, unknown>;
  assert.equal(first.msg, 'a');
  assert.equal(first.level, 'info');
  assert.equal(first.src, 'http');
  assert.ok(typeof first.ts === 'string', 'ts 序列化成 ISO 串');
  await p.close();
  assert.ok(f!.ended, 'close 后文件已 end');
  rmSync(dir, { recursive: true, force: true });
});

test('文件轮转:UTC 日期变 → 新文件', async () => {
  const dir = tmpDir();
  const files = new Map<string, ReturnType<typeof memFileSink>>();
  let t = Date.UTC(2026, 9, 13, 23, 59);
  const p = createLogPipeline({
    dir,
    autoFlush: false,
    now: () => t,
    openFile: (path) => {
      const f = memFileSink();
      files.set(path, f);
      return f;
    },
  });
  p.sink(JSON.stringify({ ts: t, level: 'info', msg: 'day1' }), 'info');
  await p.flush();
  t = Date.UTC(2026, 9, 14, 0, 1);
  p.sink(JSON.stringify({ ts: t, level: 'info', msg: 'day2' }), 'info');
  await p.flush();
  assert.ok(files.has(join(dir, 'server-2026-10-13.log')), '第一天的文件');
  assert.ok(files.has(join(dir, 'server-2026-10-14.log')), '第二天的文件');
  assert.ok(files.get(join(dir, 'server-2026-10-13.log'))!.ended, '旧文件已关');
  await p.close();
  rmSync(dir, { recursive: true, force: true });
});

test('文件轮转:同 UTC 日超字节上限 → 切序号', async () => {
  const dir = tmpDir();
  const files = new Map<string, ReturnType<typeof memFileSink>>();
  const p = createLogPipeline({
    dir,
    autoFlush: false,
    maxFileBytes: 1, // 任意一行都超 → 每批切新文件
    now: () => Date.UTC(2026, 9, 13, 1),
    openFile: (path) => {
      const f = memFileSink();
      files.set(path, f);
      return f;
    },
  });
  p.sink(JSON.stringify({ ts: 1, level: 'info', msg: 'a' }), 'info');
  await p.flush();
  p.sink(JSON.stringify({ ts: 2, level: 'info', msg: 'b' }), 'info');
  await p.flush();
  assert.ok(files.has(join(dir, 'server-2026-10-13.log')), '首个');
  assert.ok(files.has(join(dir, 'server-2026-10-13.1.log')), '超限后切序号');
  await p.close();
  rmSync(dir, { recursive: true, force: true });
});

test('close():排干在飞缓冲、停表、幂等', async () => {
  const rows: LogRow[] = [];
  const p = createLogPipeline({
    append: (r) => {
      rows.push(...r);
      return Promise.resolve();
    },
    intervalMs: 5,
    now: () => 0,
  });
  for (let i = 0; i < 10; i++) p.sink(JSON.stringify({ ts: i, level: 'info', msg: `m${i}` }), 'info');
  await p.close();
  assert.equal(rows.length, 10, 'close 排干全部 10 行');
  await p.close(); // 幂等,不炸
});

test('close() 之后的 sink 调用被丢弃(按定义)', async () => {
  const rows: LogRow[] = [];
  const p = createLogPipeline({
    append: (r) => {
      rows.push(...r);
      return Promise.resolve();
    },
    autoFlush: false,
    now: () => 0,
  });
  await p.close();
  p.sink(JSON.stringify({ ts: 1, level: 'info', msg: 'late' }), 'info');
  await p.flush();
  assert.equal(rows.length, 0);
});

test('LOG_MAX_BATCH 常量为 1000', () => {
  assert.equal(LOG_MAX_BATCH, 1000);
});
