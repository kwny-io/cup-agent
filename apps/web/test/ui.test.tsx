/**
 * ui.tsx 通用小组件的 DOM 级测试 —— 真挂载、真事件(非浅渲染)。
 * 覆盖:Card 标题/action 优先于 hint、Stat 数字与强调色、Chip 两种 tone、
 * Bar 宽度百分比、Button 真实点击 + disabled 不触发、TextField 透传原生属性。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { Bar, Button, Card, Chip, Stat, TextField } from '../src/components/ui.tsx';
import { mount, click, type } from './mount.tsx';

test('Card:有 title 才渲染标题行;action 优先于 hint', () => {
  const { host, unmount } = mount(createElement(Card, { title: '今日', hint: '提示文案' }, '内容'));
  assert.equal(host.querySelector('h2')?.textContent, '今日');
  assert.match(host.textContent ?? '', /提示文案/);
  unmount();

  const withAction = mount(
    createElement(Card, { title: 'X', hint: '应被盖住', action: createElement('b', null, '徽标') }, 'c'),
  );
  assert.match(withAction.host.textContent ?? '', /徽标/);
  assert.doesNotMatch(withAction.host.textContent ?? '', /应被盖住/);
  withAction.unmount();

  // 无 title:不渲染 header
  const bare = mount(createElement(Card, null, '只有内容'));
  assert.equal(bare.host.querySelector('h2'), null);
  bare.unmount();
});

test('Stat:数字与单位分开渲染;accent 切强调色类', () => {
  const { host, unmount } = mount(createElement(Stat, { label: '已喝', value: 728, unit: 'ml', accent: true }));
  assert.match(host.textContent ?? '', /728/);
  assert.match(host.textContent ?? '', /ml/);
  // accent=true 走 cup-ember;false 走 cup-deep
  assert.ok(host.querySelector('.text-cup-ember'), 'accent 应上 ember 色');
  unmount();
});

test('Chip:默认 cool、tone=warm 切色', () => {
  const cool = mount(createElement(Chip, null, '进行中'));
  assert.ok(cool.host.querySelector('.text-cup-deep'));
  cool.unmount();
  const warm = mount(createElement(Chip, { tone: 'warm' }, '已达标'));
  assert.ok(warm.host.querySelector('.text-cup-ember'));
  warm.unmount();
});

test('Bar:value 映射到宽度百分比(0.4 → 40%)', () => {
  const { host, unmount } = mount(createElement(Bar, { value: 0.4 }));
  const fill = host.querySelector('[style]') as HTMLElement;
  assert.equal(fill.style.width, '40%');
  unmount();
});

test('Button:真实点击触发 onClick;disabled 时不触发', () => {
  let n = 0;
  const { host, unmount } = mount(createElement(Button, { onClick: () => n++ }, '喝一口'));
  const btn = host.querySelector('button')!;
  click(btn);
  assert.equal(n, 1);
  assert.equal(btn.textContent, '喝一口');
  unmount();

  let m = 0;
  const dis = mount(createElement(Button, { disabled: true, onClick: () => m++ }, '不可点'));
  click(dis.host.querySelector('button')!);
  assert.equal(m, 0, 'disabled 按钮不应触发 onClick');
  dis.unmount();
});

test('TextField:透传原生属性(type/placeholder/maxLength),受控输入实时更新', () => {
  let seen = '';
  const { host, unmount } = mount(
    createElement(TextField, {
      type: 'number',
      placeholder: '目标',
      maxLength: 5,
      onChange: (e) => {
        seen = e.target.value;
      },
    }),
  );
  const input = host.querySelector('input')!;
  assert.equal(input.type, 'number');
  assert.equal(input.placeholder, '目标');
  assert.equal(input.maxLength, 5);
  type(input, '2000');
  assert.equal(seen, '2000');
  unmount();
});
