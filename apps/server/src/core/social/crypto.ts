/**
 * 口令哈希 + 会话令牌 —— 全部走 Node 24 内建 `node:crypto`,**零新依赖**(计划硬约束)。
 *
 * ── 为什么是 scrypt 而不是 bcrypt/argon2 ──────────────────────────
 * 引密码库 = 一条原生依赖 + 编译工具链(Node 24 strip-only、无构建的项目尤其忌讳)。
 * `scryptSync` 是 Node 内建的**内存硬** KDF,RFC 7914,对抗 GPU 爆破足够;对单机
 * 单进程的本地水杯产品,它是"安全与零依赖"的甜点。真上公网多租户时再评估 argon2id。
 *
 * ── 三个不变量 ────────────────────────────────────────────────────
 *   1. 盐随账号生成(`randomBytes`),绝不全局共用 —— 否则彩虹表一次打穿全库。
 *   2. 比较用 `timingSafeEqual`(定长缓冲),不用 `===` —— 免得按字节时间侧信道。
 *   3. salt/hash **永不出出口**:`toPublicUser` 里没有它们;日志/响应一律不带。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** scrypt 派生长度(字节) */
const KEY_LEN = 64;
/** 盐长度(字节) */
const SALT_LEN = 16;

export interface PasswordHash {
  salt: string; // hex
  hash: string; // hex
}

/** 生成 `{salt, hash}`(注册时存进账号) */
export function hashPassword(password: string): PasswordHash {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(password, salt, KEY_LEN);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

/**
 * 验口令 —— 定长比较,防时间侧信道。
 * 账号无 salt/hash(理论上不该有)时返回 false,不抛。
 */
export function verifyPassword(password: string, stored: PasswordHash): boolean {
  let expected: Buffer;
  try {
    expected = Buffer.from(stored.hash, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== KEY_LEN) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(password, Buffer.from(stored.salt, 'hex'), KEY_LEN);
  } catch {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

/** 会话令牌:32 字节随机 → base64url(URL 安全,可放进 Authorization 头) */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 用户 id:不易猜的随机串(`u_` 前缀便于日志里辨认) */
export function newUserId(): string {
  return `u_${randomBytes(9).toString('base64url')}`;
}

/** 人格包 id */
export function newPackId(): string {
  return `pk_${randomBytes(9).toString('base64url')}`;
}

/** 会话有效期(ms)—— 7 天 */
export const SESSION_TTL_MS = 7 * 24 * 3_600_000;
