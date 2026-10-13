/**
 * 「回忆」界面测试 —— 走**真实 click**(铁律),不合成 submit、不直接调 handler。
 *
 * 覆盖:空态 / 时间线渲染 / 那年今日 / 封存今天(带 buildToday)/ 三档删除两步确认。
 * social 用假实现(记调用 + 可编排返回),不连真后端。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { MemoriesCard } from '../src/components/dashboard/MemoriesCard.tsx';
import { MemoriesView } from '../src/components/MemoriesView.tsx';
import { localDayKey } from '../src/lib/memories.ts';
import type { MemoryCard, MemoryCardDetails, MemoryQuery, SocialApi } from '../src/data/source.ts';
import type { Session } from '../src/data/useSession.ts';
import { mount, click, flush } from './mount.tsx';

function details(over: Partial<MemoryCardDetails> = {}): MemoryCardDetails {
  return {
    drank_ml: 1200,
    goal_ml: 1500,
    reached: false,
    streak: 2,
    refill_count: 0,
    temp_range: null,
    notable_events: [],
    body_cues: [],
    turns_summary: null,
    turn_count: 0,
    ...over,
  };
}

function card(date: string, over: Partial<MemoryCardDetails> = {}): MemoryCard {
  return { cup_id: 'cup-X', date, built_at: 1, details: details(over) };
}

/** 只要回忆卡用到的两位;其余 SocialApi 成员给最小桩 */
function fakeSocial(over: Partial<SocialApi> = {}): SocialApi {
  const base = {
    me: async () => null,
    hasSession: () => false,
    getToken: () => null,
    getMemory: async (_q?: MemoryQuery): Promise<MemoryCard[]> => [],
    deleteMemory: async () => true,
  } as unknown as SocialApi;
  return { ...base, ...over };
}

function fakeSession(user: Session['user'] = null): Session {
  return {
    user,
    loading: false,
    login: async () => ({ ok: false, reason: 'invalid' }),
    register: async () => ({ ok: false, reason: 'invalid' }),
    logout: async () => {},
    refresh: async () => {},
  };
}

const findButton = (host: HTMLElement, text: string) =>
  Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(text)) as
    | HTMLButtonElement
    | undefined;

// ── 回忆卡 ────────────────────────────────────────────────────────

test('MemoriesCard:enabled=false → 需连后端空态,不拉数据', () => {
  let called = 0;
  const soc = fakeSocial({ getMemory: async () => { called++; return []; } });
  const { host, unmount } = mount(createElement(MemoriesCard, { social: soc, enabled: false }));
  assert.match(host.textContent ?? '', /需连后端/);
  assert.equal(called, 0);
  unmount();
});

test('MemoriesCard:无卡 → 空态 + 封存今天按钮', async () => {
  const { host, unmount } = mount(
    createElement(MemoriesCard, { social: fakeSocial(), enabled: true }),
  );
  await flush();
  assert.match(host.textContent ?? '', /还没有回忆/);
  assert.ok(findButton(host, '封存今天'), '空态应有封存今天');
  unmount();
});

test('MemoriesCard:有卡 → 概览 + 时间线(标题/数值/事件/线索)', async () => {
  const today = localDayKey();
  const soc = fakeSocial({
    getMemory: async () => [
      card(today, { reached: true, streak: 3 }),
      card('2026-10-13', { notable_events: [{ type: 'shake', ts: 1 }], body_cues: [{ cue: 'hurt', evidence: 'shake@1' }], turns_summary: '主人问过「早」' }),
    ],
  });
  const { host, unmount } = mount(createElement(MemoriesCard, { social: soc, enabled: true }));
  await flush();
  const text = host.textContent ?? '';
  assert.match(text, /共 2 天/);
  assert.match(text, /第 2 天/); // 一起第 2 天(今天 + 昨天各一张)
  assert.match(text, /达标的一天/);
  assert.match(text, /被摇了一下/);
  assert.match(text, /受了点惊/);
  assert.match(text, /主人问过「早」/);
  unmount();
});

test('MemoriesCard:那年今日 —— 往年同月同日单独高亮', async () => {
  const today = localDayKey();
  const lastYear = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;
  const soc = fakeSocial({
    getMemory: async () => [card(today, { reached: true }), card(lastYear, { reached: true })],
  });
  const { host, unmount } = mount(createElement(MemoriesCard, { social: soc, enabled: true }));
  await flush();
  assert.match(host.textContent ?? '', /那年今日/);
  unmount();
});

test('MemoriesCard:真实点击「封存今天」→ getMemory 收到 buildToday:true', async () => {
  const seen: (MemoryQuery | undefined)[] = [];
  const today = localDayKey();
  const soc = fakeSocial({
    getMemory: async (q) => {
      seen.push(q);
      return q?.buildToday ? [card(today, { reached: true })] : [];
    },
  });
  const { host, unmount } = mount(createElement(MemoriesCard, { social: soc, enabled: true }));
  await flush();
  click(findButton(host, '封存今天')!);
  await flush();
  assert.equal(seen[seen.length - 1]?.buildToday, true, '封存今天要带 buildToday');
  assert.match(host.querySelector('[role="status"]')!.textContent ?? '', /已封存/);
  unmount();
});

test('MemoriesCard:三档删除 —— 首点出确认,再点才真删(不手滑)', async () => {
  const deleted: string[] = [];
  const today = localDayKey();
  const soc = fakeSocial({
    getMemory: async () => [card(today)],
    deleteMemory: async (scope) => {
      deleted.push(scope);
      return true;
    },
  });
  const { host, unmount } = mount(createElement(MemoriesCard, { social: soc, enabled: true }));
  await flush();
  click(findButton(host, '清空全部')!);
  await flush();
  assert.deepEqual(deleted, [], '首点只出确认,不删');
  assert.ok(findButton(host, '确认清空「全部」'), '应出确认按钮');
  click(findButton(host, '确认清空「全部」')!);
  await flush();
  assert.deepEqual(deleted, ['all'], '确认后才删');
  unmount();
});

test('MemoriesCard:删除失败 → 报警,不误报成功', async () => {
  const today = localDayKey();
  const soc = fakeSocial({
    getMemory: async () => [card(today)],
    deleteMemory: async () => false,
  });
  const { host, unmount } = mount(createElement(MemoriesCard, { social: soc, enabled: true }));
  await flush();
  click(findButton(host, '清空那些日子')!);
  await flush();
  click(findButton(host, '确认清空「那些日子」')!);
  await flush();
  assert.match(host.querySelector('[role="alert"]')!.textContent ?? '', /删除失败/);
  unmount();
});

// ── 组合视图 ─────────────────────────────────────────────────────

test('MemoriesView:无后端源 → 账号卡与回忆卡都提示需连后端', () => {
  const { host, unmount } = mount(
    createElement(MemoriesView, { social: null, session: fakeSession() }),
  );
  const n = (host.textContent ?? '').split('需连后端').length - 1;
  assert.ok(n >= 2, `应有多处需连后端,实际 ${n}`);
  unmount();
});
