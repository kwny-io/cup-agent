/**
 * 可信绑定 · 服务端半 —— 设备一次性 claim code 的核验(风险 R18)。
 *
 * 要解决什么:`POST /social/cup` 过去只校验 cup_id 的**形状**,不验调用者是否真拥有那台杯
 * → A 登录后能绑 B 的杯,再 `DELETE /cups/:id/memory?scope=all` 清掉 B 的数据。修法:绑定
 * 须出示一枚**设备端生成的一次性码**(手上有真设备 → 自证归属)。这是第 4 阶段(三档删除)的硬前置。
 *
 * ── 码怎么到服务端 ────────────────────────────────────────────────
 * 设备在 hello 握手帧里带上 `{cup_id, claim, issued_at}`。`mqtt-adapter`/`sim-adapter` 在
 * `UpstreamFrameSchema` 校验**之前**就放行 `kind:'hello'`(见那两个文件),所以**契约零改动**。
 * 设备 id **从 topic 取**(`dev/<device_id>/up`),不信 hello 自报。
 *
 * ── 三条不可让步的兜底(与窗口 B 跨会话敲定,都是未认证通道逼出来的)─────────
 *   1. **PK = device_id,不是 cup_id** —— 本项目双形体:一 cup 一灵魂两具身体(杯盖 + 底座)
 *      共用 `cup_id`、`device_id` 不同。PK=cup_id 时两具身体每次上电互踩那行 → 谁后配网谁赢、
 *      另一具的码永久报废。绑定查 `WHERE cup_id AND 未用 AND 未过期`,命中任一行即过 →
 *      用户从盖**或**底座抄码都能绑同一只杯(同一物理套装,安全无碍)。
 *   2. **拒绝服务防护**:hello 未认证,知道受害者 cup_id 就能灌。故**已有未用码时忽略后续 hello**
 *      (首哈希为准);只有已用/已过期才接受新码。
 *   3. **别信设备时钟**:`issued_at` 来自未认证通道,伪造到未来 = 永生码。故 `expires_at` 一律
 *      **服务端 `now()` 算**;设备 `issued_at` 只留审计/展示,不进判定。
 *
 * 另有**逐 device_id 失败上限**(默认 5 次 / 15 分钟):40 bit 码对在线爆破偏弱,加了锁才够。
 * 键用 device_id:核验失败时对"该 cup 的所有候选 device"各记一次(攻击者只给 cup_id,只能这样归因)。
 *
 * 明文码**绝不落盘**:只存 `HMAC-SHA256(规范化码, 服务端 pepper)`(见 hashClaim)。比较用
 * `timingSafeEqual` 防时序侧信道 —— 同 `crypto.ts` 的口令那套立场。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountsStore, CupClaim } from './types.ts';
import type { LogLevel } from '../logger.ts';

/** Crockford Base32 字母表(恰 32 字符;无 I/L/O/U)—— 必须与固件 `CUP_CLAIM_ALPHABET` 逐字一致 */
export const CLAIM_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 码长(字符数)—— 与固件 `CUP_CLAIM_LEN` 一致 */
export const CLAIM_LEN = 8;
/** 有效期(ms):24 小时 —— 与固件 `CUP_CLAIM_TTL_MS` 一致 */
export const CLAIM_TTL_MS = 24 * 3_600_000;
/** 缺省失败上限(次)与锁定时长(ms) */
export const CLAIM_MAX_FAILURES = 5;
export const CLAIM_LOCK_MS = 15 * 60_000;

/**
 * 把输入**规范化**到标准形:丢空格/连字符/下划线、转大写、Crockford 容错映射
 * (I/L→1,O→0)。与固件 `claim_code_normalize` 同规则 —— 手抄必然带空格/大小写/0 写成 O。
 * @returns 规范化后的 8 串;形状不合法(长度不对 / 含字母表外字符)→ null。
 */
export function normalizeClaim(input: string): string | null {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '-' || ch === '_') {
      continue;
    }
    // 仅 ASCII 小写转大写(非 ASCII 原样保留 → 后段必落字母表外 → 判非法)
    let c = ch >= 'a' && ch <= 'z' ? String.fromCharCode(ch.charCodeAt(0) - 32) : ch;
    if (c === 'I' || c === 'L') c = '1';
    else if (c === 'O') c = '0';
    out += c;
  }
  if (out.length !== CLAIM_LEN) return null;
  for (let i = 0; i < out.length; i++) {
    if (!CLAIM_ALPHABET.includes(out[i]!)) return null;
  }
  return out;
}

/** 规范化码 → 带 pepper 的 HMAC-SHA256(hex)。**只存这个,明文码永不落盘** */
export function hashClaim(claim: string, pepper: Buffer): string {
  return createHmac('sha256', pepper).update(claim, 'utf8').digest('hex');
}

/** 定长常量时间比较两个 hex 摘要 */
export function claimHashEqual(a: string, b: string): boolean {
  let ba: Buffer;
  let bb: Buffer;
  try {
    ba = Buffer.from(a, 'hex');
    bb = Buffer.from(b, 'hex');
  } catch {
    return false;
  }
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** 解析服务端 pepper:env `CUP_CLAIM_PEPPER`(base64)优先;否则 dataDir 下落盘;否则进程内一次性 */
export function resolveClaimPepper(dataDir?: string): Buffer {
  const env = process.env['CUP_CLAIM_PEPPER'];
  if (env && env.length > 0) {
    const buf = Buffer.from(env, 'base64');
    if (buf.length >= 16) return buf;
  }
  if (!dataDir) return randomBytes(32); // 内存模式:进程内有效(claim 也不跨重启存活)
  const path = join(dataDir, 'claim-pepper');
  try {
    if (existsSync(path)) {
      const buf = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
      if (buf.length >= 16) return buf;
    }
    mkdirSync(dataDir, { recursive: true });
    const fresh = randomBytes(32);
    writeFileSync(path, fresh.toString('base64'), { encoding: 'utf8', mode: 0o600 });
    return fresh;
  } catch {
    return randomBytes(32); // 落盘失败 → 退化成进程内(不该让服务起不来)
  }
}

export interface HelloFrame {
  cup_id?: unknown;
  claim?: unknown;
  issued_at?: unknown;
  [k: string]: unknown;
}

export interface ClaimServiceOptions {
  store: AccountsStore;
  pepper: Buffer;
  ttlMs?: number;
  maxFailures?: number;
  lockMs?: number;
  now?: () => number;
  log?: (msg: string, level?: LogLevel) => void;
}

interface FailureState {
  count: number;
  lockedUntil: number;
}

/**
 * claim 的业务规则:**收码(hello)** 与 **核码(绑定)**。
 * 规则厚、路由薄 —— 与 `auth.ts` 同一立场;失败上限内存态(不需跨重启)。
 */
export class ClaimService {
  private readonly store: AccountsStore;
  private readonly pepper: Buffer;
  private readonly ttlMs: number;
  private readonly maxFailures: number;
  private readonly lockMs: number;
  private readonly now: () => number;
  private readonly log: (msg: string, level?: LogLevel) => void;
  /** device_id → 连续失败 / 锁定状态(内存态) */
  private readonly failures = new Map<string, FailureState>();

  constructor(opts: ClaimServiceOptions) {
    this.store = opts.store;
    this.pepper = opts.pepper;
    this.ttlMs = opts.ttlMs ?? CLAIM_TTL_MS;
    this.maxFailures = opts.maxFailures ?? CLAIM_MAX_FAILURES;
    this.lockMs = opts.lockMs ?? CLAIM_LOCK_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m, l = 'info') => console[l](m));
  }

  /**
   * 收到设备的 hello:若带有效 `claim` → 记 (device_id → 哈希)。
   * 无 `claim` 字段(旧形 hello)/ 形状非法 / deviceId 空 → **静默忽略**(不 upsert)。
   * 首哈希为准:该 device 已有"未用且未过期"的码时,忽略后续 hello。
   */
  async noteHello(deviceId: string, hello: HelloFrame): Promise<void> {
    if (deviceId.length === 0) return;
    const raw = hello.claim;
    if (typeof raw !== 'string') return; // 旧形 hello:无 claim 字段 → 不动
    const cupId = typeof hello.cup_id === 'string' ? hello.cup_id.trim() : '';
    if (cupId.length === 0 || cupId.length > 64) return;
    const norm = normalizeClaim(raw);
    if (!norm) return; // 形状非法 → 忽略(不记脏行)

    const now = this.now();
    const existing = await this.store.claimByDevice(deviceId);
    if (existing && existing.used_at === undefined && existing.expires_at > now) {
      // 拒绝服务防护:已有活跃码,别让未认证的 hello 覆盖它
      return;
    }
    const issuedAt =
      typeof hello.issued_at === 'number' && Number.isFinite(hello.issued_at)
        ? hello.issued_at
        : 0;
    await this.store.putClaim({
      device_id: deviceId,
      cup_id: cupId,
      claim_hash: hashClaim(norm, this.pepper),
      issued_at: issuedAt, // 设备自报,仅审计/展示
      expires_at: now + this.ttlMs, // **服务端时钟** —— 绝不信设备
    });
    this.log(`[claim] 记录设备 ${deviceId} 的 claim(cup=${cupId})`);
  }

  /**
   * 核验绑定请求。命中任一台"未用 + 未过期 + 未锁"的候选设备即通过 → 标 used、清失败计数。
   * 否则记失败(对每个候选 device 各记一次)并返回 false。
   */
  async verify(cupId: string, rawCode: string): Promise<boolean> {
    const candidates = await this.store.claimsByCup(cupId);
    if (candidates.length === 0) return false;
    const now = this.now();
    const live = candidates.filter((c) => c.used_at === undefined && c.expires_at > now);
    if (live.length === 0) return false;
    const unlocked = live.filter((c) => !this.isLocked(c.device_id, now));
    if (unlocked.length === 0) return false; // 候选全锁 → 快速失败

    const norm = normalizeClaim(rawCode);
    if (norm) {
      const h = hashClaim(norm, this.pepper);
      const hit = unlocked.find((c) => claimHashEqual(c.claim_hash, h));
      if (hit) {
        await this.store.markClaimUsed(hit.device_id, now);
        for (const c of candidates) this.failures.delete(c.device_id);
        return true;
      }
    }
    for (const c of live) this.recordFailure(c.device_id, now);
    return false;
  }

  private isLocked(deviceId: string, now: number): boolean {
    const f = this.failures.get(deviceId);
    return f !== undefined && f.lockedUntil > now;
  }

  private recordFailure(deviceId: string, now: number): void {
    const f = this.failures.get(deviceId) ?? { count: 0, lockedUntil: 0 };
    f.count += 1;
    if (f.count >= this.maxFailures) {
      f.lockedUntil = now + this.lockMs;
      f.count = 0;
      this.log(`[claim] 设备 ${deviceId} 校验连续失败 ${this.maxFailures} 次,锁 ${this.lockMs}ms`, 'warn');
    }
    this.failures.set(deviceId, f);
  }
}
