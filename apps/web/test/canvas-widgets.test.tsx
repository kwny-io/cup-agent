/**
 * 画布类组件测试 —— CupWidget / EyePreview。
 *
 * 像素验不了(jsdom 无 canvas,getContext 是 setup.mjs 里的惰性桩);能且值得验的是:
 *   组件能真挂载并跑起 rAF 循环(不抛)、外壳 DOM 正确、交互回传对、卸载不残留。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { CupWidget } from '../src/components/CupWidget.tsx';
import { EyePreview } from '../src/components/EyePreview.tsx';
import { mount, click, flush } from './mount.tsx';

test('CupWidget:挂载即出画布,按 size 定尺寸与 aria 标签,rAF 循环不抛', async () => {
  const { host, unmount } = mount(createElement(CupWidget, { size: 180 }));
  const canvas = host.querySelector('canvas')!;
  assert.ok(canvas, '应有 canvas');
  assert.equal(canvas.getAttribute('aria-label'), '水杯');
  assert.equal(canvas.style.width, '180px');
  // 跑几帧 rAF,确认绘制循环在桩 context 下不抛
  await flush();
  unmount();
});

test('CupWidget:size 变化后画布尺寸随之更新', async () => {
  const { host, render, unmount } = mount(createElement(CupWidget, { size: 120 }));
  const canvas = host.querySelector('canvas')!;
  assert.equal(canvas.style.width, '120px');
  render(createElement(CupWidget, { size: 240 }));
  assert.equal(host.querySelector('canvas')!.style.width, '240px');
  await flush();
  unmount();
});

test('CupWidget:卸载后画布从文档移除(rAF 已取消,不残留)', () => {
  const { host, unmount } = mount(createElement(CupWidget, { size: 100 }));
  assert.equal(document.body.contains(host), true);
  unmount();
  assert.equal(document.body.contains(host), false);
});

test('EyePreview:出画布 + 状态标签 + 手势提示占位', () => {
  const { host, unmount } = mount(createElement(EyePreview, { size: 128 }));
  const canvas = host.querySelector('canvas')!;
  assert.equal(canvas.getAttribute('aria-label'), '杯盖眼睛预览');
  assert.match(host.textContent ?? '', /128×128 单色点阵/);
  // 无手势时的引导语
  assert.match(host.textContent ?? '', /摇一摇/);
  unmount();
});

test('EyePreview:交接按钮真实点击切换文案与 aria-pressed', () => {
  const { host, unmount } = mount(createElement(EyePreview, { size: 128 }));
  const btn = host.querySelector('button')!;
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  assert.match(btn.textContent ?? '', /脸在盖子上/);

  click(btn);
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  assert.match(btn.textContent ?? '', /脸在屏幕上/);

  click(btn);
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  assert.match(btn.textContent ?? '', /脸在盖子上/);
  unmount();
});

/** 造一个只带阈值的市场包(P4.2) */
const demoPack = {
  pack_id: 'p1',
  author_user_id: 'u1',
  name: '急性子',
  tone: '简短',
  thresholds: { REFUSE_S: 0.1, SMUG_S: 9, SULK_LEVEL: 0.5, CONTENT_S: 8 },
  wave: { k: 8, c: 220, damp: 1.2 },
  lines: [],
  status: 'approved' as const,
  created_at: 0,
};

test('CupWidget:带 pack 挂载照常出画布、跑循环不抛(注入口不掉链子)', async () => {
  const { host, render, unmount } = mount(createElement(CupWidget, { size: 160, pack: demoPack }));
  assert.ok(host.querySelector('canvas'), '带包也应有 canvas');
  await flush();
  // 换包:同一画布实例换参,不重建(host 里还是那张 canvas)
  const before = host.querySelector('canvas');
  render(createElement(CupWidget, { size: 160, pack: null }));
  assert.equal(host.querySelector('canvas'), before, '换包不该重建画布');
  await flush();
  unmount();
});

test('EyePreview:带 pack 挂载照常出画布与标签', async () => {
  const { host, unmount } = mount(createElement(EyePreview, { size: 128, pack: demoPack }));
  assert.equal(host.querySelector('canvas')!.getAttribute('aria-label'), '杯盖眼睛预览');
  await flush();
  unmount();
});
