/**
 * 首启激活引导 —— 纯函数决策测试(零 DOM / 零时钟)。
 *
 * 钉死"哪一步、什么时候退场":关过永不显示;未连上先教连接;连上没动静
 * 喊喝一口;有动静就收尾。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onboardingView, type OnboardingInput } from '../src/lib/onboarding.ts';

const base = (over: Partial<OnboardingInput> = {}): OnboardingInput => ({
  state: 'open',
  eventCountToday: 0,
  drankMl: 0,
  dismissed: false,
  ...over,
});

test('引导:关过 → 永不显示', () => {
  assert.equal(onboardingView(base({ dismissed: true })).show, false);
  assert.equal(onboardingView(base({ dismissed: true, state: 'connecting' })).show, false);
});

test('引导:未连上 → connect(只说明,无 CTA)', () => {
  const v = onboardingView(base({ state: 'connecting' }));
  assert.equal(v.step, 'connect');
  assert.equal(v.cta, null);
  const e = onboardingView(base({ state: 'error' }));
  assert.equal(e.step, 'connect');
});

test('引导:连上但今天没动静 → sip(有"去看杯子"CTA)', () => {
  const v = onboardingView(base({ state: 'open' }));
  assert.equal(v.step, 'sip');
  assert.equal(v.cta, '去看杯子');
});

test('引导:今天喝过 → coach(收尾,CTA 是"知道了")', () => {
  assert.equal(onboardingView(base({ drankMl: 200 })).step, 'coach');
  // 只喝 0ml 但有事件(如摔杯)→ 也算"有动静"
  assert.equal(onboardingView(base({ eventCountToday: 1 })).step, 'coach');
  assert.equal(onboardingView(base({ drankMl: 250 })).cta, '知道了');
});
