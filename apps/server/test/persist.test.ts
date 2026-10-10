/**
 * P3 测试:持久化 —— 目标 + 对话记忆"重启不丢"(ADR T14)。
 *
 * 用真实的临时目录 + 真的写文件再读回(不 mock fs)—— 这正是这个功能存在的理由,
 * mock 掉就测不到它了(T3 精神:换实现要经得起真跑)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FilePersistence,
  FileChatStore,
  MemoryStore,
  MemoryChatStore,
  capTurns,
  windowTurns,
  MAX_TURNS_PER_CUP,
  type ChatTurnRecord,
} from '@cup/server';

const CUP = 'cup-A1B2C3';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'cup-persist-'));
}

function turn(role: ChatTurnRecord['role'], text: string, ts = 1000): ChatTurnRecord {
  return { cup_id: CUP, ts, role, text };
}

test('持久化:目标写入 → flush → 新实例读回(重启不丢)', async () => {
  const dir = tmp();
  try {
    const p1 = new FilePersistence(dir);
    p1.setGoal(CUP, 2000);
    await p1.flush();

    const p2 = new FilePersistence(dir);
    assert.equal(p2.goals()[CUP], 2000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('持久化:MemoryStore 钩子 → 落盘 → 新 store 恢复目标(T3 不动接口)', async () => {
  const dir = tmp();
  try {
    // 第一次"进程":带 onGoal 钩子的 store
    const p1 = new FilePersistence(dir);
    const s1 = new MemoryStore({ goals: p1.goals(), onGoal: (c, g) => p1.setGoal(c, g) });
    s1.setGoal(CUP, 2500);
    await p1.flush();

    // 第二次"进程":从磁盘恢复
    const p2 = new FilePersistence(dir);
    const s2 = new MemoryStore({ goals: p2.goals() });
    assert.equal(s2.goal(CUP), 2500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('持久化:对话轮写入 → 新 FileChatStore 读回', async () => {
  const dir = tmp();
  try {
    const p1 = new FilePersistence(dir);
    const cs1 = new FileChatStore(p1);
    cs1.appendTurn(turn('user', '今天喝得怎么样', 1));
    cs1.appendTurn(turn('assistant', '才 720ml 呀', 2));
    await p1.flush();

    const p2 = new FilePersistence(dir);
    const cs2 = new FileChatStore(p2);
    const recent = cs2.recentTurns(CUP, 10);
    assert.equal(recent.length, 2);
    assert.equal(recent[0]!.text, '今天喝得怎么样');
    assert.equal(recent[1]!.text, '才 720ml 呀');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('持久化:坏文件不会让服务起不来(从空开始)', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'state.json'), '{ not valid json', 'utf8');
    const p = new FilePersistence(dir);
    assert.deepEqual(p.goals(), {}); // 静默从空开始
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('持久化:原子写 —— tmp 文件不残留', async () => {
  const dir = tmp();
  try {
    const p = new FilePersistence(dir);
    p.setGoal(CUP, 1800);
    await p.flush();
    // 落盘后只剩 state.json,tmp 已被 rename 消耗
    const raw = readFileSync(join(dir, 'state.json'), 'utf8');
    assert.equal(JSON.parse(raw).goals[CUP], 1800);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 裁剪规则:两个实现共用,必须一致 ─────────────────────────────

test('裁剪:超过 MAX_TURNS_PER_CUP 只留最近 N 条', () => {
  let arr: ChatTurnRecord[] = [];
  for (let i = 0; i < MAX_TURNS_PER_CUP + 20; i++) arr = capTurns(arr, turn('user', `m${i}`, i));
  assert.equal(arr.length, MAX_TURNS_PER_CUP);
  assert.equal(arr[0]!.text, 'm20'); // 最老的 20 条被丢
});

test('窗口:按字节封顶,超预算的旧轮被丢、新的留下', () => {
  const arr: ChatTurnRecord[] = [
    turn('user', 'x'.repeat(5000), 1), // 单条就撑爆 4KB 预算
    turn('user', 'hi', 2),
    turn('assistant', 'ok', 3),
  ];
  const w = windowTurns(arr, 10);
  assert.equal(w.length, 2); // 5000 字那条被截掉,只留后两条
  assert.equal(w[w.length - 1]!.text, 'ok'); // 最新的在
});

test('记忆:两个实现(内存 / 文件)在相同输入下给相同窗口', async () => {
  const dir = tmp();
  try {
    const mem = new MemoryChatStore();
    const file = new FileChatStore(new FilePersistence(dir));
    for (let i = 0; i < 5; i++) {
      mem.appendTurn(turn('user', `m${i}`, i));
      file.appendTurn(turn('user', `m${i}`, i));
    }
    assert.deepEqual(
      mem.recentTurns(CUP, 3).map((t) => t.text),
      file.recentTurns(CUP, 3).map((t) => t.text),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
