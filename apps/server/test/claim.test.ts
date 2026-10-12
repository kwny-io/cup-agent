/**
 * 可信绑定 · 服务端半(风险 R18)—— claim code 规范化 / 哈希不可逆 / 一次性 / 时效 /
 * 首哈希为准 / 服务端算过期 / 失败上限 / 开关默认关旧行为不变。
 *
 * 起真 HTTP + 真聚合路径(同 social.test.ts 手法),核验 `POST /social/cup` 的闸门。
 * 三条与窗口 B 敲定的兜底各有专测:PK=device_id(双形体)、已有活跃码不被覆盖、expires 服务端算。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createApp,
  normalizeClaim,
  hashClaim,
  claimHashEqual,
  ClaimService,
  MemoryAccountsStore,
  CLAIM_TTL_MS,
  type PublicUser,
} from '@cup/server';

const CUP = 'cup-A1B2C3';
const LID = 'lid-A1B2C3';
const BASE = 'base-A1B2C3';
const CODE = 'ABCD2345'; // 8 位、全在 Crockford 字母表内(I/L/O/U 已用 1/0 代表,故这里不含)

interface AuthOk {
  token: string;
  user: PublicUser;
}

async function startApp(requireClaim: boolean) {
  const app = createApp({ log: () => {}, allowUnauth: true, requireClaim });
  const port = await app.listen(0);
  return { app, base: `http://127.0.0.1:${port}` };
}

async function register(base: string, email: string): Promise<AuthOk> {
  const r = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret1', nickname: email.split('@')[0] }),
  });
  assert.equal(r.status, 200, `注册应成功:${await r.clone().text()}`);
  return (await r.json()) as AuthOk;
}

function bind(base: string, cupId: string, token: string, claimCode?: string) {
  return fetch(`${base}/social/cup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(claimCode === undefined ? { cup_id: cupId } : { cup_id: cupId, claim_code: claimCode }),
  });
}

// ── 纯函数:规范化 ───────────────────────────────────────────────

test('normalizeClaim:去分隔符 / 转大写 / I·L→1·O→0;形状非法 → null', () => {
  // 大小写 + 空格 + 连字符 + Crockford 容错(I/L→1, O→0)
  assert.equal(normalizeClaim('abcd-2345'), 'ABCD2345');
  assert.equal(normalizeClaim(' abcd 2345 '), 'ABCD2345');
  assert.equal(normalizeClaim('abcd_2345'), 'ABCD2345');
  assert.equal(normalizeClaim('ILO0-2345'), '11002345');
  assert.equal(normalizeClaim('a\tb\nc d-2345'), 'ABCD2345');
  // 非法:长度 / 字母表外字符(U 不在字母表)
  assert.equal(normalizeClaim('ABCD234'), null);
  assert.equal(normalizeClaim('ABCD23456'), null);
  assert.equal(normalizeClaim('ABCDU345'), null);
  assert.equal(normalizeClaim(''), null);
});

test('hashClaim:同码同 pepper 稳定;换 pepper 变;不含明文', () => {
  const p1 = Buffer.alloc(32, 1);
  const p2 = Buffer.alloc(32, 2);
  const h = hashClaim('ABCD2345', p1);
  assert.equal(h, hashClaim('ABCD2345', p1), '同 pepper 稳定');
  assert.notEqual(h, hashClaim('ABCD2345', p2), '换 pepper 变');
  assert.notEqual(h, hashClaim('ABCD2346', p1), '换码变');
  assert.ok(!h.includes('ABCD2345'), '摘要不含明文');
  assert.equal(h.length, 64, 'sha256 hex');
});

test('claimHashEqual:等值 true;长度 / 内容不同 false;非 hex 不抛', () => {
  const p = Buffer.alloc(32, 7);
  const a = hashClaim('ABCD2345', p);
  assert.equal(claimHashEqual(a, hashClaim('ABCD2345', p)), true);
  assert.equal(claimHashEqual(a, hashClaim('ABCD2346', p)), false);
  assert.equal(claimHashEqual(a, 'deadbeef'), false, '长度不同');
  assert.equal(claimHashEqual(a, 'zzzz'), false, '非 hex 不抛');
});

// ── ClaimService:收码与核码 ────────────────────────────────────

test('noteHello:带 claim 落库(存哈希不存明文);无 claim 字段 → no-op', async () => {
  const store = new MemoryAccountsStore();
  const pepper = Buffer.alloc(32, 3);
  const svc = new ClaimService({ store, pepper, log: () => {} });

  await svc.noteHello(LID, { cup_id: CUP, claim: CODE, issued_at: 1 });
  const row = await store.claimByDevice(LID);
  assert.ok(row, '应落库');
  assert.equal(row!.cup_id, CUP);
  assert.notEqual(row!.claim_hash, CODE, '存的是哈希');
  assert.equal(row!.claim_hash, hashClaim(CODE, pepper));
  assert.equal(row!.used_at, undefined, '未用');

  await svc.noteHello(BASE, { kind: 'hello' }); // 旧形:无 claim
  assert.equal(await store.claimByDevice(BASE), null, '无 claim 不落库');
});

test('noteHello:双形体同 cup 不同 device → 两行共存(PK=device_id)', async () => {
  const store = new MemoryAccountsStore();
  const svc = new ClaimService({ store, pepper: Buffer.alloc(32, 1), log: () => {} });
  await svc.noteHello(LID, { cup_id: CUP, claim: 'AAAA1111' });
  await svc.noteHello(BASE, { cup_id: CUP, claim: 'BBBB2222' });
  const rows = await store.claimsByCup(CUP);
  assert.equal(rows.length, 2, '两具身体各一行;cup_id 作 PK 会互踩');
});

test('noteHello:已有活跃码时忽略后续 hello(拒绝服务防护,首哈希为准)', async () => {
  const store = new MemoryAccountsStore();
  const svc = new ClaimService({ store, pepper: Buffer.alloc(32, 1), log: () => {} });
  await svc.noteHello(LID, { cup_id: CUP, claim: 'AAAA1111' });
  await svc.noteHello(LID, { cup_id: CUP, claim: 'BBBB2222' }); // 覆盖尝试
  const row = await store.claimByDevice(LID);
  assert.equal(row!.claim_hash, hashClaim('AAAA1111', Buffer.alloc(32, 1)), '首个码胜,不被覆盖');
});

test('noteHello:设备时钟不可信 —— expires_at 用服务端 now 算', async () => {
  const store = new MemoryAccountsStore();
  const fixed = 1_000_000_000_000;
  const svc = new ClaimService({ store, pepper: Buffer.alloc(32, 1), now: () => fixed, log: () => {} });
  // 设备谎报 issued_at 在未来一千年 → 若信它,expires 也跑到未来,码成永生
  await svc.noteHello(LID, { cup_id: CUP, claim: CODE, issued_at: fixed + 1e15 });
  const row = await store.claimByDevice(LID);
  assert.equal(row!.issued_at, fixed + 1e15, 'issued_at 只留审计');
  assert.equal(row!.expires_at, fixed + CLAIM_TTL_MS, 'expires 服务端算,与设备谎报无关');
});

test('verify:对的码通过并标 used;错的码 false;used 后同码 false', async () => {
  const store = new MemoryAccountsStore();
  const svc = new ClaimService({ store, pepper: Buffer.alloc(32, 1), log: () => {} });
  await svc.noteHello(LID, { cup_id: CUP, claim: CODE });
  assert.equal(await svc.verify(CUP, CODE), true);
  assert.equal((await store.claimByDevice(LID))!.used_at !== undefined, true, '标 used');
  assert.equal(await svc.verify(CUP, CODE), false, '一次性:同码不能再绑');
  assert.equal(await svc.verify(CUP, 'ZZZZ9999'), false, '错码 false');
  assert.equal(await svc.verify('cup-nope', CODE), false, '未知杯 false');
});

test('verify:小写 / 带空格的手抄码也认(规范化在核验侧同样生效)', async () => {
  const store = new MemoryAccountsStore();
  const svc = new ClaimService({ store, pepper: Buffer.alloc(32, 1), log: () => {} });
  await svc.noteHello(LID, { cup_id: CUP, claim: CODE });
  assert.equal(await svc.verify(CUP, 'abcd 2345'), true);
});

test('verify:过期码 false;重新铸码后 used 重置、可再绑', async () => {
  const store = new MemoryAccountsStore();
  let now = 1_000_000;
  const svc = new ClaimService({ store, pepper: Buffer.alloc(32, 1), ttlMs: 1000, now: () => now, log: () => {} });
  await svc.noteHello(LID, { cup_id: CUP, claim: 'AAAA1111' });
  now += 2000; // 过期
  assert.equal(await svc.verify(CUP, 'AAAA1111'), false, '过期 false');
  await svc.noteHello(LID, { cup_id: CUP, claim: 'BBBB2222' }); // 过期后铸新码
  assert.equal(await svc.verify(CUP, 'BBBB2222'), true, '新码可绑');
  const row = await store.claimByDevice(LID);
  assert.notEqual(row!.used_at, undefined, '新码用后标 used');
});

test('verify:逐设备失败上限 —— 连错 5 次后锁定,期间对码也不放行', async () => {
  const store = new MemoryAccountsStore();
  let now = 1_000_000;
  const svc = new ClaimService({
    store,
    pepper: Buffer.alloc(32, 1),
    maxFailures: 3,
    lockMs: 60_000,
    now: () => now,
    log: () => {},
  });
  await svc.noteHello(LID, { cup_id: CUP, claim: CODE });
  for (let i = 0; i < 3; i++) assert.equal(await svc.verify(CUP, 'WRONG111'), false);
  assert.equal(await svc.verify(CUP, CODE), false, '锁定期间对码也不放行');
  now += 60_001; // 锁到期
  assert.equal(await svc.verify(CUP, CODE), true, '解锁后放行');
});

// ── HTTP 端到端:开关 ────────────────────────────────────────────

test('开关关(默认):POST /social/cup 只校验形状,无 claim_code 照绑(零回归)', async () => {
  const { app, base } = await startApp(false);
  try {
    const bob = await register(base, 'bob@example.com');
    assert.equal((await bind(base, CUP, bob.token)).status, 200, '默认无 claim 也 200');
  } finally {
    await app.close();
  }
});

test('开关开:无 / 错 / 过期 claim_code → 一律 403(无 oracle);对码 → 200', async () => {
  const { app, base } = await startApp(true);
  try {
    const bob = await register(base, 'bob@example.com');
    // 尚无 claim:任何码都 403
    const r1 = await bind(base, CUP, bob.token, CODE);
    assert.equal(r1.status, 403);
    assert.equal((await bind(base, CUP, bob.token)).status, 403, '缺字段也 403');
    // 设备报码
    await app.claims.noteHello(LID, { cup_id: CUP, claim: CODE });
    assert.equal((await bind(base, CUP, bob.token, 'WRONG111')).status, 403, '错码 403');
    const ok = await bind(base, CUP, bob.token, CODE);
    assert.equal(ok.status, 200, '对码 200');
    assert.equal(((await ok.json()) as { cup_id: string }).cup_id, CUP);
    // 一次性:再绑同一码 403
    assert.equal((await bind(base, CUP, bob.token, CODE)).status, 403, '用过即废');
  } finally {
    await app.close();
  }
});

test('开关开:双形体 —— 任一具身体的码都能绑同一只杯', async () => {
  const { app, base } = await startApp(true);
  try {
    const bob = await register(base, 'bob@example.com');
    await app.claims.noteHello(LID, { cup_id: CUP, claim: 'AAAA1111' });
    await app.claims.noteHello(BASE, { cup_id: CUP, claim: 'BBBB2222' });
    // 从底座抄的码(bob 手上那具是底座)
    assert.equal((await bind(base, CUP, bob.token, 'BBBB2222')).status, 200, '底座码可绑');
  } finally {
    await app.close();
  }
});
