/**
 * GetStartedCard 组件测试 —— 真挂载 + 真实 click(铁律)。
 *
 * 覆盖:空数据出现 sip / 点"去看杯子"回落地 / "以后再说"退场且落盘 /
 * coach 步点"知道了"退场 / 已退场过 → 直接不显示。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { GetStartedCard } from '../src/components/dashboard/GetStartedCard.tsx';
import { mount, click } from './mount.tsx';

const LS_KEY = 'cup.onboarding.done';

function reset() {
  localStorage.removeItem(LS_KEY);
}

const btnByText = (host: HTMLElement, text: string): HTMLButtonElement | null => {
  for (const b of host.querySelectorAll('button')) {
    if ((b.textContent ?? '').trim() === text) return b as HTMLButtonElement;
  }
  return null;
};

test('GetStartedCard:连上但空数据 → 出现 sip,点"去看杯子"触发回落地', () => {
  reset();
  let went = 0;
  const { host, unmount } = mount(
    createElement(GetStartedCard, {
      state: 'open',
      drankMl: 0,
      eventCountToday: 0,
      onGoCup: () => {
        went++;
      },
    }),
  );
  assert.match(host.textContent ?? '', /先喂它第一口水/);
  const cta = btnByText(host, '去看杯子');
  assert.ok(cta, '应有"去看杯子"按钮');
  click(cta!);
  assert.equal(went, 1);
  assert.ok(host.querySelector('section'), '点 CTA 不退场(只是去杯子)');
  unmount();
});

test('GetStartedCard:"以后再说" → 卡片消失且写入退场标记', () => {
  reset();
  const { host, unmount } = mount(
    createElement(GetStartedCard, {
      state: 'open',
      drankMl: 0,
      eventCountToday: 0,
      onGoCup: () => {},
    }),
  );
  const skip = btnByText(host, '以后再说');
  assert.ok(skip, '应有"以后再说"按钮');
  click(skip!);
  assert.equal(host.querySelector('section'), null, '点后退场:卡片从 DOM 移走');
  assert.equal(localStorage.getItem(LS_KEY), '1', '退场标记应落盘');
  unmount();
});

test('GetStartedCard:早上喝过了 → coach 步,"知道了"退场', () => {
  reset();
  const { host, unmount } = mount(
    createElement(GetStartedCard, {
      state: 'open',
      drankMl: 250,
      eventCountToday: 3,
      onGoCup: () => {},
    }),
  );
  assert.match(host.textContent ?? '', /它记住了这一口/);
  const ok = btnByText(host, '知道了');
  assert.ok(ok);
  click(ok!);
  assert.equal(host.querySelector('section'), null);
  assert.equal(localStorage.getItem(LS_KEY), '1');
  unmount();
});

test('GetStartedCard:退场标记已在 → 直接不渲染', () => {
  localStorage.setItem(LS_KEY, '1');
  const { host, unmount } = mount(
    createElement(GetStartedCard, {
      state: 'open',
      drankMl: 0,
      eventCountToday: 0,
      onGoCup: () => {},
    }),
  );
  assert.equal(host.querySelector('section'), null);
  reset();
  unmount();
});

test('GetStartedCard:未连上 → connect 步(无主 CTA,但"以后再说"能退场)', () => {
  reset();
  const { host, unmount } = mount(
    createElement(GetStartedCard, {
      state: 'connecting',
      drankMl: 0,
      eventCountToday: 0,
      onGoCup: () => {},
    }),
  );
  assert.match(host.textContent ?? '', /正在认识你的杯子/);
  // connect 步没有主 CTA(连接是后台在做),但**必须**有退场口 ——
  // 否则数据源连不上时这张卡永久占屏、关不掉。
  assert.equal(btnByText(host, '去看杯子'), null, 'connect 步无主 CTA');
  const skip = btnByText(host, '以后再说');
  assert.ok(skip, 'connect 步也要有"以后再说"');
  click(skip!);
  assert.equal(host.querySelector('section'), null, '点后退场');
  assert.equal(localStorage.getItem(LS_KEY), '1');
  unmount();
});
