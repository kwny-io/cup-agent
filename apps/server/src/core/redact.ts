/**
 * 写入时脱敏 —— 日志落库/落文件**之前**抹掉敏感值。
 *
 * 为什么在写入侧(而非读取侧过滤):持久化的东西一旦写了密钥就**已经在盘上**,
 * 读取侧再过滤只是掩耳盗铃。故脱敏挂在 `createLogger({ redact })`,序列化前生效。
 *
 * 覆盖两类:
 *   · **字段值**:键名命中 `SENSITIVE_KEYS` → 整值替换为 `[REDACTED]`(大小写不敏感)。
 *   · **自由文本**:`msg`/字符串值里出现的 `Bearer <t>` 或 `token=…` / `password: …` 等
 *     形如「名字+值」的片段 → 抹值留名;邮箱 → 局部掩码(留首字符与域名,够诊断又降敏感)。
 *
 * 纯函数、零依赖(原则 P4)。默认**不启用**(logger 不传 redact),生产由 app 接线打开。
 */
import type { LogEntry, LogFields } from './logger.ts';

/** 键名(小写)命中即整值抹除。改这里 = 改全局脱敏口径。 */
export const SENSITIVE_KEYS: readonly string[] = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api_key',
  'apikey',
  'token',
  'access_token',
  'refresh_token',
  'password',
  'passwd',
  'secret',
  'claim_code',
];
const SENSITIVE = new Set(SENSITIVE_KEYS);

/** 抹除后的占位符。 */
export const REDACTED = '[REDACTED]';

/** 邮箱局部掩码:`ann@x.com → a***@x.com`(留首字符 + 域名,便于对账又不露全名)。 */
export function maskEmail(s: string): string {
  const at = s.indexOf('@');
  if (at <= 0) return s;
  return `${s[0]}***${s.slice(at)}`;
}

// 邮箱:moggy.li+tg@sub.x.com 这类也认(local 段允许 . + -)。
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// `Bearer <token>`(token 通常无分隔符)。
const BEARER_RE = /\bBearer\s+[\w.\-+/=]{6,}/gi;
// 具名密钥**强制要分隔符**(`=`/`:`)—— 故 "password policy updated" 这类正文不误伤。
const NAMED_SECRET_RE = /\b(token|api[_-]?key|password|passwd|secret|claim[_-]?code)\b\s*[:=]\s*["']?[\w.\-+/=]{6,}/gi;

/** 对单段自由文本:抹 named-secret → 抹 bearer → 掩邮箱(replace 会重置 lastIndex,无状态残留)。 */
function scrubText(s: string): string {
  return s
    .replace(NAMED_SECRET_RE, (_m, name: string) => `${name}=${REDACTED}`)
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(EMAIL_RE, maskEmail);
}

/**
 * 脱敏入口 —— logger 的 `redact` 钩子。**总是返回新对象**(不动入参,便于测试)。
 * 非字符串字段值(数字/布尔/null)原样透传;undefined 保留(它表示"没这个字段")。
 */
export function redactFields(entry: LogEntry): LogEntry {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(entry.fields)) {
    out[k] = SENSITIVE.has(k.toLowerCase())
      ? REDACTED
      : typeof v === 'string'
        ? scrubText(v)
        : v;
  }
  return { msg: scrubText(entry.msg), fields: out };
}
