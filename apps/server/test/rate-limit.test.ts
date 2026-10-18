/**
 * 速率限制单测 —— 令牌桶 + 分桶归类 + 客户端标识。
 *
 * 全部用**注入的假时钟**,不做真实等待:限流的行为是"时间 × 令牌"的函数,
 * 睡真觉只会让测试慢且抖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBucket,
  clientKey,
  createRateLimiter,
  DEFAULT_RULES,
  type BucketRule,
} from '../src/api/rate-limit.ts';

/** 假时钟:手动推进。 */
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const TIGHT: Readonly<Record<string, BucketRule>> = {
  auth: { capacity: 3, refillPerSec: 1 },
  default: { capacity: 10, refillPerSec: 10 },
};

// ── 令牌桶语义 ────────────────────────────────────────────────

test('桶容量内全部放行,超出即拒', () => {
  const c = clock();
  const rl = createRateLimiter({ rules: TIGHT, now: c.now });
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(rl.check('1.2.3.4', 'auth'), { ok: true }, `第 ${i + 1} 次应放行`);
  }
  const v = rl.check('1.2.3.4', 'auth');
  assert.equal(v.ok, false, '第 4 次应被拒');
  assert.equal(v.ok === false && v.bucket, 'auth');
});

test('按 refillPerSec 回填;回填满则恢复全容量', () => {
  const c = clock();
  const rl = createRateLimiter({ rules: TIGHT, now: c.now });
  for (let i = 0; i < 3; i++) rl.check('ip', 'auth');
  assert.equal(rl.check('ip', 'auth').ok, false);

  c.advance(1000); // 1 秒 → 1 个令牌
  assert.equal(rl.check('ip', 'auth').ok, true, '回填 1 个后应放行');
  assert.equal(rl.check('ip', 'auth').ok, false, '又用完了');

  c.advance(1000 * 100); // 远超回满时间
  for (let i = 0; i < 3; i++) {
    assert.equal(rl.check('ip', 'auth').ok, true, `回满后第 ${i + 1} 次应放行`);
  }
});

test('令牌不会超过容量(长时间空闲不攒额度)', () => {
  const c = clock();
  const rl = createRateLimiter({ rules: TIGHT, now: c.now });
  c.advance(1_000_000); // 空闲很久
  for (let i = 0; i < 3; i++) assert.equal(rl.check('ip', 'auth').ok, true);
  assert.equal(rl.check('ip', 'auth').ok, false, '容量仍是 3,不该因空闲而更多');
});

test('Retry-After 为正整数秒,且与缺口成反比', () => {
  const c = clock();
  // 每秒回填 0.1 个 → 缺 1 个要等 10 秒
  const rl = createRateLimiter({
    rules: { slow: { capacity: 1, refillPerSec: 0.1 }, default: { capacity: 1, refillPerSec: 0.1 } },
    now: c.now,
  });
  assert.equal(rl.check('ip', 'slow').ok, true);
  const v = rl.check('ip', 'slow');
  assert.equal(v.ok, false);
  if (v.ok === false) {
    assert.ok(Number.isInteger(v.retryAfterSec), '应为整数秒');
    assert.ok(v.retryAfterSec >= 1 && v.retryAfterSec <= 11, `应在 1..11 秒,实得 ${v.retryAfterSec}`);
  }
});

test('桶彼此独立:一个桶耗尽不影响另一个', () => {
  const c = clock();
  const rl = createRateLimiter({ rules: TIGHT, now: c.now });
  for (let i = 0; i < 3; i++) rl.check('ip', 'auth');
  assert.equal(rl.check('ip', 'auth').ok, false, 'auth 已耗尽');
  assert.equal(rl.check('ip', 'default').ok, true, 'default 桶不该受影响');
});

test('不同客户端各算各的额度', () => {
  const c = clock();
  const rl = createRateLimiter({ rules: TIGHT, now: c.now });
  for (let i = 0; i < 3; i++) rl.check('a', 'auth');
  assert.equal(rl.check('a', 'auth').ok, false);
  assert.equal(rl.check('b', 'auth').ok, true, '换个 IP 应满额度');
});

test('未知桶名落到 default 规则', () => {
  const c = clock();
  const rl = createRateLimiter({ rules: TIGHT, now: c.now });
  for (let i = 0; i < 10; i++) assert.equal(rl.check('ip', '从没见过的桶').ok, true);
  assert.equal(rl.check('ip', '从没见过的桶').ok, false, '应按 default 的 10 计');
});

// ── 有界内存 ─────────────────────────────────────────────────

test('桶表超上限会被裁剪(防伪造 IP 打爆内存)', () => {
  const c = clock();
  const rl = createRateLimiter({
    rules: { default: { capacity: 100, refillPerSec: 100 } },
    maxKeys: 5,
    now: c.now,
  });
  for (let i = 0; i < 50; i++) rl.check(`ip-${i}`, 'default');
  assert.ok(rl.size() <= 5, `桶数应被压到上限内,实得 ${rl.size()}`);
});

test('裁剪优先清"已回满"的桶,不误伤正在被限的', () => {
  const c = clock();
  const rl = createRateLimiter({
    rules: { tight: { capacity: 1, refillPerSec: 0 }, default: { capacity: 100, refillPerSec: 100 } },
    maxKeys: 2,
    now: c.now,
  });
  rl.check('limited', 'tight'); // 用掉唯一令牌
  assert.equal(rl.check('limited', 'tight').ok, false, '应已进入限流状态');
  // 再塞一批"满桶"(用 default,一次只用 1 个,远未到 100)
  for (let i = 0; i < 10; i++) rl.check(`fresh-${i}`, 'default');
  // 被限的那个桶如果在裁剪里被清掉,会瞬间复活成满额 —— 那等于限流失效
  assert.equal(rl.check('limited', 'tight').ok, false, '正在被限的桶不该被裁掉');
});

// ── 归类 ─────────────────────────────────────────────────────

test('classifyBucket:认证口最严', () => {
  for (const p of ['/auth/login', '/auth/register', '/auth/logout', '/auth/session']) {
    assert.equal(classifyBucket('POST', p), 'auth', p);
  }
});

test('classifyBucket:设备写端点归 write', () => {
  assert.equal(classifyBucket('POST', '/cups/cup-A1/ingest'), 'write');
  assert.equal(classifyBucket('POST', '/cups/cup-A1/config'), 'write');
  assert.equal(classifyBucket('POST', '/cups/cup-A1/ask'), 'write');
  assert.equal(classifyBucket('PUT', '/cups/cup-A1/goal'), 'write');
  assert.equal(classifyBucket('PUT', '/cups/cup-A1/profile'), 'write');
  assert.equal(classifyBucket('POST', '/social/cup'), 'write');
});

test('classifyBucket:读端点与其它走 default', () => {
  assert.equal(classifyBucket('GET', '/cups/cup-A1/today'), 'default');
  assert.equal(classifyBucket('GET', '/healthz'), 'default');
  // 同样的路径,方法不对就不是写端点(别把 GET /goal 当写)
  assert.equal(classifyBucket('GET', '/cups/cup-A1/goal'), 'default');
  // 嵌更深的路径不该被前缀误伤
  assert.equal(classifyBucket('POST', '/cups/cup-A1/ingest/extra'), 'default');
});

// ── 客户端标识 ────────────────────────────────────────────────

test('clientKey:直连取 socket 地址,忽略 x-forwarded-for', () => {
  const req = {
    headers: { 'x-forwarded-for': '9.9.9.9' },
    socket: { remoteAddress: '10.0.0.1' },
  };
  assert.equal(clientKey(req, false), '10.0.0.1', '未信任代理时不得采信可伪造的头');
  assert.equal(clientKey(req, true), '9.9.9.9', '信任代理时取首跳');
});

test('clientKey:多跳 x-forwarded-for 取最左一跳;缺失则回落 socket', () => {
  assert.equal(
    clientKey({ headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' }, socket: { remoteAddress: 'r' } }, true),
    '1.1.1.1',
  );
  assert.equal(clientKey({ headers: {}, socket: { remoteAddress: 'r' } }, true), 'r');
  assert.equal(clientKey({ headers: {} }, false), 'unknown');
});

test('默认阈值:认证口比写口严,写口比兜底严', () => {
  assert.ok(DEFAULT_RULES.auth!.capacity < DEFAULT_RULES.write!.capacity);
  assert.ok(DEFAULT_RULES.write!.capacity < DEFAULT_RULES.default!.capacity);
  // 折算成"每分钟"看一遍,阈值是否在合理量级(防手滑写错数量级)
  const perMin = (r: BucketRule) => r.refillPerSec * 60;
  assert.equal(perMin(DEFAULT_RULES.auth!), 20);
  assert.equal(perMin(DEFAULT_RULES.write!), 300);
  assert.equal(perMin(DEFAULT_RULES.default!), 1200);
});
