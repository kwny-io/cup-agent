/**
 * 速率限制 —— 手写令牌桶(零依赖,原则 P4),挂在请求入口最早处。
 *
 * 为什么需要:公网暴露后,`/auth/login` 是可被撞库的口子,`/cups/:id/ingest` 与
 * `PUT goal` 这类写端点能被脚本灌爆,而 `GET /today` 之类读端点也可能被刷。
 * 应用层限流是最后一道;反向代理/WAF 是第一道,两者不冲突。
 *
 * 设计取舍:
 *   · **令牌桶**(非固定窗口):允许短突发,又能压住持续速率,且不需要"窗口边界"状态。
 *   · **按桶分规则**:认证口最严、写口次之、其它宽松 —— 一刀切的阈值要么误伤读、要么放过撞库。
 *   · **每个请求只记一个桶**(最具体的那个),不叠加计数 —— 否则写请求等于扣两次额度,阈值难解释。
 *   · **有界内存**:桶表超过 `maxKeys` 就清掉已满的桶(空闲/被限的留),防止伪造 IP 打爆内存。
 *   · **时钟注入**:测试给假时钟,不做真实等待。
 */

export interface BucketRule {
  /** 桶容量(可一次性突发的请求数) */
  capacity: number;
  /** 每秒回填令牌数 */
  refillPerSec: number;
}

export interface RateLimitConfig {
  /** 桶名 → 规则;`default` 作兜底 */
  rules?: Readonly<Record<string, BucketRule>>;
  /** 信任 `x-forwarded-for` 的首跳作为客户端 IP(反向代理后面才开;直连时开=可被伪造) */
  trustProxy?: boolean;
  /** 桶表键上限(每个桶名 × 每个 IP 一个键) */
  maxKeys?: number;
  /** 时钟(ms);测试注入 */
  now?: () => number;
}

export type RateLimitVerdict =
  | { ok: true }
  | { ok: false; retryAfterSec: number; bucket: string };

/** 默认阈值:认证口严(撞库)、写口中(设备上报是常在线流)、其余宽松。 */
export const DEFAULT_RULES: Readonly<Record<string, BucketRule>> = {
  auth: { capacity: 20, refillPerSec: 20 / 60 },
  write: { capacity: 300, refillPerSec: 300 / 60 },
  default: { capacity: 1200, refillPerSec: 1200 / 60 },
};

/** `Retry-After` 上限(1 天)。防 refillPerSec=0 时算出 Infinity → JSON 变 null。 */
const MAX_RETRY_AFTER_SEC = 86_400;

interface Token {
  tokens: number;
  updatedAt: number;
}

export interface RateLimiter {
  /** 记一次请求;超限则返回建议的 `Retry-After` 秒数 */
  check(key: string, bucket: string): RateLimitVerdict;
  /** 当前存活桶数(测试/自检用) */
  size(): number;
}

export function createRateLimiter(cfg: RateLimitConfig = {}): RateLimiter {
  const rules = cfg.rules ?? DEFAULT_RULES;
  const now = cfg.now ?? Date.now;
  const maxKeys = cfg.maxKeys ?? 10_000;
  const buckets = new Map<string, Token>();

  const ruleFor = (name: string): BucketRule => rules[name] ?? rules.default ?? DEFAULT_RULES.default!;

  // 键 = 桶名 + IP。分隔符用 \u0000,防止 IP 里出现同名字符串拼出歧义键。
  const keyOf = (bucket: string, ip: string): string => `${bucket}\u0000${ip}`;

  /** 桶当前填充率(0 = 已耗尽,1 = 满)。需要拿规则,故并入裁剪流程用。 */
  const fillRatio = (k: string, tok: Token, t: number): number => {
    const rule = ruleFor(k.slice(0, k.indexOf('\u0000')));
    const tokens = Math.min(rule.capacity, tok.tokens + ((t - tok.updatedAt) / 1000) * rule.refillPerSec);
    return rule.capacity === 0 ? 0 : tokens / rule.capacity;
  };

  const evictIfNeeded = (): void => {
    if (buckets.size <= maxKeys) return;
    const t = now();
    // 第一遍:清"已回满"的桶 —— 它们等价于不存在,丢掉零代价。
    for (const [k, tok] of buckets) {
      if (fillRatio(k, tok, t) >= 1) buckets.delete(k);
    }
    if (buckets.size <= maxKeys) return;
    // 第二遍:仍超限时**优先丢填充率高的**(把它们重置成满额,对用户最宽容),
    // 从而保住填充率低的 —— 那正是正在被限流的桶;把它们删掉等于限流被绕过。
    // 同率时按最久未更新先丢(LRU)。
    const sorted = [...buckets.entries()].sort((a, b) => {
      const d = fillRatio(b[0], b[1], t) - fillRatio(a[0], a[1], t);
      return d !== 0 ? d : a[1].updatedAt - b[1].updatedAt;
    });
    for (const [k] of sorted.slice(0, buckets.size - maxKeys)) buckets.delete(k);
  };

  return {
    check(ip, bucket) {
      const rule = ruleFor(bucket);
      const k = keyOf(bucket, ip);
      const t = now();
      const tok = buckets.get(k) ?? { tokens: rule.capacity, updatedAt: t };
      const elapsedSec = Math.max(0, (t - tok.updatedAt) / 1000);
      const tokens = Math.min(rule.capacity, tok.tokens + elapsedSec * rule.refillPerSec);
      if (tokens < 1) {
        // refillPerSec=0(彻底封禁)时 need 会是 Infinity → JSON 序列化成 null,
        // 客户端拿不到退避值。夹到 MAX_RETRY_AFTER_SEC,语义上是"很久以后再来"。
        const need = rule.refillPerSec > 0 ? (1 - tokens) / rule.refillPerSec : MAX_RETRY_AFTER_SEC;
        buckets.set(k, { tokens, updatedAt: t });
        evictIfNeeded();
        const sec = Math.max(1, Math.ceil(need));
        return { ok: false, retryAfterSec: Math.min(sec, MAX_RETRY_AFTER_SEC), bucket };
      }
      buckets.set(k, { tokens: tokens - 1, updatedAt: t });
      evictIfNeeded();
      return { ok: true };
    },
    size: () => buckets.size,
  };
}

/**
 * 按方法与路径归类到桶。**只做最具体的那个归类**,不叠加。
 * 认证口优先于写口:登录不是"设备写",阈值要更严。
 */
export function classifyBucket(method: string, pathname: string): string {
  if (pathname === '/auth/register' || pathname === '/auth/login') return 'auth';
  if (pathname.startsWith('/auth/')) return 'auth';
  // 设备写端点(与 http.ts 的 isWriteEndpoint 同口径,但这里只能看路径/方法)
  if (method === 'POST' && /^\/cups\/[^/]+\/(ingest|config|ask)$/.test(pathname)) return 'write';
  if (method === 'PUT' && /^\/cups\/[^/]+\/(goal|profile)$/.test(pathname)) return 'write';
  if (method === 'POST' && pathname === '/social/cup') return 'write';
  return 'default';
}

/** 客户端标识:直连取 socket 地址,反代后取 `x-forwarded-for` 首跳。 */
export function clientKey(req: { headers: Record<string, unknown>; socket?: { remoteAddress?: string } }, trustProxy: boolean): string {
  if (trustProxy) {
    const raw = req.headers['x-forwarded-for'];
    const first = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress ?? 'unknown';
}
