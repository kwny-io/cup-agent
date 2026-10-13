/**
 * 结构化日志 —— 级别 + 字段 + 上下文。
 *
 * 背景:此前全服务端只有 `deps.log?.(msg, level?)` 一个缝,默认 `console[l](m)`,
 * 打印的就是一行拼接字符串 —— **没有级别过滤、没有结构化字段、没有请求/设备上下文**,
 * 生产上出问题只能靠 grep 猜。这里把它升格成一个小 logger,同时**保住旧签名**。
 *
 * 设计要点:
 *   · 兼容:一个 Logger 实例**可当函数调**(`log('msg','warn')`),旧的 20+ 调用点零改动。
 *   · 结构化:`log.info('msg', { cupId, status })` → text 格式拼成 `msg key=val ...`,
 *     json 格式打成一行 JSON(便于采集器解析)。
 *   · 上下文:`log.child({ cupId })` 绑一层不变字段,子 logger 打印自动带上。
 *   · 零依赖:只用内置,不引第三方(原则 P4)。
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** 级别数值序(过滤用:>= min 才出)。 */
const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 可序列化的字段值(日志字段是"事实",不是任意对象)。 */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

/** 一条日志的未序列化形态 —— 脱敏器的输入/输出(脱敏必须在拼行前发生)。 */
export interface LogEntry {
  msg: string;
  fields: LogFields;
}

/** 脱敏器:在原串上抹掉敏感值。**纯函数**(不改入参、返回新对象),便于单测。 */
export type Redactor = (entry: LogEntry) => LogEntry;

export interface LoggerOptions {
  /** 最低级别;低于它的丢弃(默认 info) */
  level?: LogLevel;
  /** 输出格式:`text`(human 可读,默认)或 `json`(每行一条,便于采集) */
  format?: 'text' | 'json';
  /** 落点;默认按级别打到 console 对应通道 */
  sink?: (line: string, level: LogLevel) => void;
  /** 固定字段(打每条日志都带上;child 在此基础上再叠) */
  fields?: LogFields;
  /** 源标记(如 `http`/`mqtt`);text 里打 `[源]` 前缀,json 里作 `src` */
  source?: string;
  /**
   * 序列化**之前**的脱敏钩子。缺省不脱敏 → 零回归(控制台与既有测试逐字节不变)。
   * 生产由 `createApp` 在启用持久化时传 `redactFields`,故落库/落文件前敏感值已抹净。
   */
  redact?: Redactor;
}

/**
 * 日志器 —— **可调用**(兼容旧 `log(msg, level?)`)。
 * 额外暴露 `child` / `with` 快捷法与 `debug..error`(带字段)。
 */
export interface Logger {
  (msg: string, level?: LogLevel): void;
  child(fields: LogFields): Logger;
  with(source: string): Logger;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  isEnabled(level: LogLevel): boolean;
  /** 本 logger 的有效级别(接线/测试读用) */
  readonly level: LogLevel;
}

/** 把字段拼进一行 `msg k=v k=v`(text 格式)。值含空格/特殊字符时用 JSON 引号包。 */
function appendFields(msg: string, fields: LogFields | undefined): string {
  if (!fields) return msg;
  let out = msg;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue; // undefined = 没这个字段(与 null 区分)
    const s = typeof v === 'string' && /^[\w.\-:/@]*$/.test(v) ? v : JSON.stringify(v);
    out += ` ${k}=${s}`;
  }
  return out;
}

/** 默认落点(按级别打到 console 对应通道)。**导出**供 cli/持久 sink 组合成单 sink。 */
export function consoleSink(line: string, level: LogLevel): void {
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(line);
}
const defaultSink = consoleSink;

/** 建一个 logger。child/with 通过闭包叠加字段与源标记。 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? 'info';
  const format = opts.format ?? 'text';
  const sink = opts.sink ?? defaultSink;
  const minRank = LEVEL_RANK[level];
  const isEnabled = (l: LogLevel): boolean => LEVEL_RANK[l] >= minRank;

  function make(fields: LogFields | undefined, source: string | undefined): Logger {
    const emit = (l: LogLevel, msg: string, extra?: LogFields): void => {
      if (!isEnabled(l)) return;
      const all = fields ? { ...fields, ...extra } : extra;
      // 脱敏在拼行之前发生:控制台/落库/落文件三处共用同一份脱敏后的值。
      const e = opts.redact ? opts.redact({ msg, fields: all ?? {} }) : { msg, fields: all ?? {} };
      let line: string;
      if (format === 'json') {
        // 保留键(ts/level/src/msg)**最后展开**:fields 里同名键不得覆盖它们。
        line = JSON.stringify({
          ...e.fields,
          ts: new Date().toISOString(),
          level: l,
          ...(source ? { src: source } : {}),
          msg: e.msg,
        });
      } else {
        line = `${source ? `[${source}] ` : ''}${l.toUpperCase()} ${appendFields(e.msg, e.fields)}`;
      }
      sink(line, l);
    };
    const self = ((msg: string, l: LogLevel = 'info') => emit(l, msg)) as Logger;
    Object.defineProperty(self, 'level', { value: level, enumerable: true });
    self.isEnabled = isEnabled;
    self.child = (f: LogFields) => make(fields ? { ...fields, ...f } : f, source);
    self.with = (s: string) => make(fields, s);
    self.debug = (m, f) => emit('debug', m, f);
    self.info = (m, f) => emit('info', m, f);
    self.warn = (m, f) => emit('warn', m, f);
    self.error = (m, f) => emit('error', m, f);
    return self;
  }

  return make(opts.fields, opts.source);
}

/** 解析级别字符串(大小写不敏感);非法/缺省 → fallback。 */
export function parseLogLevel(raw: string | undefined | null, fallback: LogLevel = 'info'): LogLevel {
  if (!raw) return fallback;
  const v = raw.trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(v) ? (v as LogLevel) : fallback;
}

/** 解析格式字符串;非法/缺省 → 'text'。 */
export function parseLogFormat(raw: string | undefined | null): 'text' | 'json' {
  return raw?.trim().toLowerCase() === 'json' ? 'json' : 'text';
}
