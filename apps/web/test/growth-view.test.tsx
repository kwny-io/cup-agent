/**
 * 成长卡组件测试 —— 真挂载 + 真实 click(铁律)。
 *
 * 覆盖:未连后端空态(不拉数据)/ 拉取后阶段+阶梯/里程碑/庆祝横幅/无数据空态。
 * social 用假实现(可编排返回),不连真后端。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { GrowthCard } from '../src/components/dashboard/GrowthCard.tsx';
import { MemoriesView } from '../src/components/MemoriesView.tsx';
import type { Growth, GrowthSnapshot, SocialApi } from '../src/data/source.ts';
import { STAGES } from '../src/lib/growth.ts';
import type { Session } from '../src/data/useSession.ts';
import { mount, flush } from './mount.tsx';

function stage(key: string): Growth['stage'] {
  return STAGES.find((s) => s.key === key)!;
}

function snapshot(over: Partial<Growth> = {}): GrowthSnapshot {
  const s = over.stage ?? stage('newborn');
  const idx = STAGES.findIndex((x) => x.key === s.key);
  const next = idx >= 0 && idx + 1 < STAGES.length ? STAGES[idx + 1]! : null;
  return {
    cup_id: 'cup-X',
    today: '2026-10-14',
    growth: {
      days_together: 0,
      best_streak: 0,
      total_achieved_days: 0,
      total_refill_days: 0,
      stage: s,
      next_stage: next,
      milestones: [],
      next_milestone: null,
      celebrate: null,
      ...over,
    },
  };
}

function fakeSocial(over: Partial<SocialApi> = {}): SocialApi {
  const base = {
    me: async () => null,
    hasSession: () => false,
    getToken: () => null,
    getGrowth: async (): Promise<GrowthSnapshot | null> => null,
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

test('GrowthCard:enabled=false → 需连后端空态,不拉数据', () => {
  let called = 0;
  const soc = fakeSocial({ getGrowth: async () => { called++; return null; } });
  const { host, unmount } = mount(createElement(GrowthCard, { social: soc, enabled: false }));
  assert.match(host.textContent ?? '', /需连后端/);
  assert.equal(called, 0);
  unmount();
});

test('GrowthCard:有快照 → 阶段徽标 + 一起第 N 天 + 升阶进度文案', async () => {
  const soc = fakeSocial({
    getGrowth: async () => snapshot({ stage: stage('growing'), days_together: 10 }),
  });
  const { host, unmount } = mount(createElement(GrowthCard, { social: soc, enabled: true }));
  await flush();
  const text = host.textContent ?? '';
  assert.match(text, /一起第 10 天/);
  assert.match(text, /成长期/);
  assert.match(text, /还差 20 天升到「稳当」/);
  unmount();
});

test('GrowthCard:里程碑阶梯 —— 已达成 / 未达成 + 还差多少', async () => {
  const soc = fakeSocial({
    getGrowth: async () =>
      snapshot({
        stage: stage('growing'),
        days_together: 10,
        milestones: [
          { id: 'first_drop', label: '第一口水', kind: 'achieved', threshold: 1, value: 1, achieved: true, progress: 1 },
          { id: 'together_30', label: '一起满月', kind: 'together', threshold: 30, value: 10, achieved: false, progress: 10 / 30 },
        ],
        next_milestone: { id: 'together_30', label: '一起满月', kind: 'together', threshold: 30, value: 10, achieved: false, progress: 10 / 30 },
      }),
  });
  const { host, unmount } = mount(createElement(GrowthCard, { social: soc, enabled: true }));
  await flush();
  const text = host.textContent ?? '';
  assert.match(text, /第一口水/);
  assert.match(text, /已达成/);
  assert.match(text, /一起满月/);
  assert.match(text, /还差 20 天/);
  assert.match(text, /已解锁 1 \/ 2/);
  unmount();
});

test('GrowthCard:今天新解锁 → 出庆祝横幅', async () => {
  const soc = fakeSocial({
    getGrowth: async () =>
      snapshot({
        stage: stage('sprout'),
        days_together: 3,
        celebrate: { id: 'together_3', label: '一起 3 天', kind: 'together', threshold: 3, value: 3, achieved: true, progress: 1 },
      }),
  });
  const { host, unmount } = mount(createElement(GrowthCard, { social: soc, enabled: true }));
  await flush();
  const banner = host.querySelector('[role="status"]');
  assert.ok(banner, '应有庆祝横幅');
  assert.match(banner!.textContent ?? '', /解锁「一起 3 天」/);
  unmount();
});

test('GrowthCard:没跨坎 → 不出庆祝横幅', async () => {
  const soc = fakeSocial({ getGrowth: async () => snapshot({ stage: stage('growing'), days_together: 10 }) });
  const { host, unmount } = mount(createElement(GrowthCard, { social: soc, enabled: true }));
  await flush();
  assert.equal(host.querySelector('[role="status"]'), null);
  unmount();
});

test('GrowthCard:拿不到快照 → 空态(不空白/不报错)', async () => {
  const { host, unmount } = mount(
    createElement(GrowthCard, { social: fakeSocial({ getGrowth: async () => null }), enabled: true }),
  );
  await flush();
  assert.match(host.textContent ?? '', /还没连上后端|暂无/);
  unmount();
});

test('MemoriesView:无后端源 → 成长卡与回忆卡都提示需连后端', () => {
  const { host, unmount } = mount(
    createElement(MemoriesView, { social: null, session: fakeSession() }),
  );
  assert.match(host.textContent ?? '', /成长/);
  const n = (host.textContent ?? '').split('需连后端').length - 1;
  assert.ok(n >= 3, `账号/成长/回忆三处需连后端,实际 ${n}`);
  unmount();
});
