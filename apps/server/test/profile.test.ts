/**
 * #72 人格档案(养成卡 / 迁移码的**服务端半边**)—— `/cups/:id/profile` 读写端点
 * + traits 落盘。
 *
 * 钉的是**写入端的口径**,不是"卡好不好看":
 *   · GET 无档案 → 用当下 computePersonality **现算**返回(不落盘,只读不写)
 *   · PUT 只收昵称;**traits 一律服务端现算**,客户端传来的数值一律忽略(防伪造)
 *   · traits 与 /report/latest、/personality/history 末日**同源**(同一 computePersonality)
 *   · PUT 是写端点:配了 apiKey → 必带 x-api-key;GET 是读端点 → 开放(R10-B)
 *   · 落盘:FileProfileStore 挂 state.json 的 traits 段,重启不丢
 *
 * 起真 HTTP(createApp,与 personality-history.test.ts 同法),数据走真实聚合路径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, FilePersistence, FileProfileStore, MemoryProfileStore } from '@cup/server';
import type { TraitRecord } from '@cup/server';
import { dayKey, shiftDay } from '@cup/server';
import type { CupEvent } from '@cup/contract';

const CUP = 'cup-A1B2C3';
const GOAL = 1500;

interface ProfileBody {
  cup_id: string;
  nickname: string;
  traits: TraitRecord;
}

async function startApp(opts: Parameters<typeof createApp>[0] = {}) {
  const app = createApp({ log: () => {}, allowUnauth: true, ...opts });
  const port = await app.listen(0);
  return { app, base: `http://127.0.0.1:${port}` };
}

function seedDrink(app: Awaited<ReturnType<typeof startApp>>['app'], date: string, ml: number): void {
  const ts = new Date(`${date}T12:00:00`).getTime();
  const e: CupEvent = {
    v: 1,
    cup_id: CUP,
    device_id: 'base-A1B2C3',
    ts,
    type: 'drink',
    amount_ml: ml,
    confidence: 1,
    derived_by: 'base',
  };
  app.store.applyEventToAgg(e);
}

function getProfile(base: string) {
  return fetch(`${base}/cups/${CUP}/profile`);
}

function putProfile(base: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/cups/${CUP}/profile`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// ── GET:无档案 → 现算 ────────────────────────────────────────────

test('GET profile:无落盘档案 → 200 + nickname 空 + 现算 traits(不落盘)', async () => {
  const { app, base } = await startApp();
  try {
    seedDrink(app, shiftDay(dayKey(Date.now()), -1), GOAL);
    seedDrink(app, dayKey(Date.now()), GOAL); // 连 2 天达标 → smug

    const r = await getProfile(base);
    assert.equal(r.status, 200);
    const j = (await r.json()) as ProfileBody;
    assert.equal(j.cup_id, CUP);
    assert.equal(j.nickname, '', '没起名 → 空串');
    assert.equal(j.traits.disposition, 'smug');
    assert.equal(j.traits.streak, 2);
    assert.ok(j.traits.updated_at > 0, '快照应带生成时刻');

    // 只读不写:再取一次仍然没有落盘档案
    assert.equal(app.profiles.get(CUP), null, 'GET 不应把现算结果落盘');
  } finally {
    await app.close();
  }
});

test('GET profile:traits 与 /report/latest 同源(disposition 一致)', async () => {
  const { app, base } = await startApp();
  try {
    seedDrink(app, shiftDay(dayKey(Date.now()), -2), 200);
    seedDrink(app, shiftDay(dayKey(Date.now()), -1), 200);
    seedDrink(app, dayKey(Date.now()), 200); // 连续欠水 → sulky

    const p = (await (await getProfile(base)).json()) as ProfileBody;
    const report = (await (await fetch(`${base}/cups/${CUP}/report/latest`)).json()) as {
      disposition: string;
    };
    assert.equal(p.traits.disposition, report.disposition, '档案 disposition = 今日战报(同一 computePersonality)');
  } finally {
    await app.close();
  }
});

// ── PUT:写昵称,traits 服务端现算 ─────────────────────────────────

test('PUT profile:写昵称 → 200;再 GET 读回落盘的昵称与 traits', async () => {
  const { app, base } = await startApp();
  try {
    seedDrink(app, dayKey(Date.now()), GOAL);

    const put = await putProfile(base, { nickname: '  小水  ' });
    assert.equal(put.status, 200);
    const saved = (await put.json()) as ProfileBody;
    assert.equal(saved.nickname, '小水', '昵称应 trim');
    assert.equal(saved.traits.streak, 1);

    const got = (await (await getProfile(base)).json()) as ProfileBody;
    assert.equal(got.nickname, '小水');
    assert.equal(got.traits.disposition, saved.traits.disposition);
    assert.notEqual(app.profiles.get(CUP), null, 'PUT 应落盘');
  } finally {
    await app.close();
  }
});

test('PUT profile:客户端伪造的 traits 数值一律忽略(服务端现算)', async () => {
  const { app, base } = await startApp();
  try {
    seedDrink(app, dayKey(Date.now()), 200); // 实际欠水 → 不该 smug
    const r = await putProfile(base, {
      nickname: '骗子',
      traits: { disposition: 'smug', level: 1, streak: 999, warmth: 1, refill_habit: 1, updated_at: 1 },
      level: 1,
      streak: 999,
    });
    assert.equal(r.status, 200);
    const j = (await r.json()) as ProfileBody;
    assert.notEqual(j.traits.disposition, 'smug', '不得接受客户端伪造的 smug');
    assert.notEqual(j.traits.streak, 999, '不得接受伪造的 streak');
    assert.equal(app.profiles.get(CUP)?.traits.streak, j.traits.streak, '落盘的也是现算值');
  } finally {
    await app.close();
  }
});

test('PUT profile:昵称超长截到 24;非字符串昵称 → 400', async () => {
  const { app, base } = await startApp();
  try {
    const long = 'x'.repeat(50);
    const r = await putProfile(base, { nickname: long });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as ProfileBody).nickname.length, 24, '截到 PROFILE_NICKNAME_MAX');

    assert.equal((await putProfile(base, { nickname: 123 })).status, 400, '昵称非字符串 → 400');
  } finally {
    await app.close();
  }
});

test('PUT profile:缺 nickname 字段 → 200 空昵称(不报错)', async () => {
  const { app, base } = await startApp();
  try {
    const r = await putProfile(base, {});
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as ProfileBody).nickname, '');
  } finally {
    await app.close();
  }
});

// ── R10-B:写端点鉴权,读端点开放 ─────────────────────────────────

test('R10-B:配了 apiKey → PUT 无 key 401,带对 key 放行;GET 始终开放', async () => {
  // 显式给 key（不 用 allowUnauth）→ 写端点强制
  const app = createApp({ log: () => {}, apiKey: 'secret-key' });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await getProfile(base)).status, 200, '读端点默认开放');

    assert.equal((await putProfile(base, { nickname: 'a' })).status, 401, '写端点无 key → 401');
    assert.equal(
      (await putProfile(base, { nickname: 'a' }, { 'x-api-key': 'wrong' })).status,
      401,
      'key 不对 → 401',
    );
    const ok = await putProfile(base, { nickname: 'a' }, { 'x-api-key': 'secret-key' });
    assert.equal(ok.status, 200, '带对 key → 放行');
  } finally {
    await app.close();
  }
});

// ── 落盘 ─────────────────────────────────────────────────────────

test('持久化:FileProfileStore 落 state.json,新实例读回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cup-profile-'));
  let app1: ReturnType<typeof createApp> | null = null;
  let app2: ReturnType<typeof createApp> | null = null;
  try {
    app1 = createApp({ log: () => {}, allowUnauth: true, dataDir: dir });
    const port1 = await app1.listen(0);
    const base1 = `http://127.0.0.1:${port1}`;
    seedDrink(app1, dayKey(Date.now()), GOAL);
    assert.equal((await putProfile(base1, { nickname: '豆豆' })).status, 200);
    const before = app1.profiles.get(CUP)!.traits;
    await app1.close(); // flush
    app1 = null;

    // 新进程:同目录
    app2 = createApp({ log: () => {}, allowUnauth: true, dataDir: dir });
    const port2 = await app2.listen(0);
    const base2 = `http://127.0.0.1:${port2}`;
    const j = (await (await fetch(`${base2}/cups/${CUP}/profile`)).json()) as ProfileBody;
    assert.equal(j.nickname, '豆豆', '昵称应恢复');
    assert.equal(j.traits.disposition, before.disposition, 'traits 快照应恢复');
    assert.equal(j.traits.streak, before.streak);
  } finally {
    await app1?.close();
    await app2?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MemoryProfileStore:get 未命中 → null;set 后 get 回读', () => {
  const s = new MemoryProfileStore();
  assert.equal(s.get('nope'), null);
  const rec = {
    nickname: 'n',
    traits: { disposition: 'normal' as const, level: 0.5, streak: 0, warmth: 0.5, refill_habit: 0.5, updated_at: 1 },
  };
  s.set('c1', rec);
  assert.deepEqual(s.get('c1'), rec);
});

test('FileProfileStore:包装 FilePersistence 的 traits 段', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cup-profile-store-'));
  try {
    const fp = new FilePersistence(dir);
    const s = new FileProfileStore(fp);
    assert.equal(s.get(CUP), null);
    s.set(CUP, {
      nickname: 'x',
      traits: { disposition: 'smug', level: 1, streak: 3, warmth: 1, refill_habit: 1, updated_at: 42 },
    });
    assert.equal(s.get(CUP)?.traits.updated_at, 42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
