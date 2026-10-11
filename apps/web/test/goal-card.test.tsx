/**
 * GoalCard 组件测试 —— 走真实按钮 click 提交(不合成 submit、不直接调 save),
 * 验:禁用态、非法输入被人话拦下、合法输入真调 onSave、按后端结果给不同反馈。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { GoalCard } from '../src/components/dashboard/GoalCard.tsx';
import { GOAL_MAX, GOAL_MIN } from '../src/lib/goal.ts';
import type { GoalResult } from '../src/data/source.ts';
import { mount, click, type as typeInto, flush } from './mount.tsx';

const input = (host: HTMLElement) => host.querySelector('input') as HTMLInputElement;
const button = (host: HTMLElement) => host.querySelector('button') as HTMLButtonElement;

test('GoalCard:onSave=null(纯模拟器)→ 输入与按钮禁用 + 不支持提示', () => {
  const { host, unmount } = mount(createElement(GoalCard, { goal: 1500, onSave: null }));
  assert.equal(input(host).disabled, true);
  assert.equal(button(host).disabled, true);
  assert.match(host.textContent ?? '', /不支持改目标/);
  unmount();
});

test('GoalCard:初值取自 goal;输入合法但与当前相同 → 按钮禁用(无可保存)', () => {
  const { host, unmount } = mount(
    createElement(GoalCard, { goal: 1500, onSave: async () => ({ ok: true, goalMl: 1500 }) }),
  );
  assert.equal(input(host).value, '1500');
  assert.equal(button(host).disabled, true, '未改动时不该能保存');
  unmount();
});

test('GoalCard:越界输入 → 真实点击保存 → 人话报错,不调 onSave', async () => {
  let calls = 0;
  const { host, unmount } = mount(
    createElement(GoalCard, {
      goal: 1500,
      onSave: async () => {
        calls++;
        return { ok: true, goalMl: 1500 };
      },
    }),
  );
  typeInto(input(host), String(GOAL_MAX + 1000));
  click(button(host));
  await flush();
  assert.equal(calls, 0, '非法输入不应走到 onSave');
  const alert = host.querySelector('[role="alert"]');
  assert.ok(alert, '应出现 alert');
  // lib/goal 的越界文案:"目标最多 10000 ml"
  assert.match(alert!.textContent ?? '', new RegExp(`最多 ${GOAL_MAX}`));
  assert.equal(input(host).getAttribute('aria-invalid'), 'true');
  unmount();
});

test('GoalCard:空输入 → 报错;小数被 lib/goal 当非整数拦下', async () => {
  const { host, unmount } = mount(
    createElement(GoalCard, { goal: 1500, onSave: async () => ({ ok: true, goalMl: 1500 }) }),
  );
  typeInto(input(host), '');
  click(button(host));
  await flush();
  assert.match(host.querySelector('[role="alert"]')!.textContent ?? '', /请输入目标值/);

  typeInto(input(host), '12.5');
  click(button(host));
  await flush();
  assert.match(host.querySelector('[role="alert"]')!.textContent ?? '', /整数/);
  unmount();
});

test('GoalCard:合法新值 → 真实点击保存 → onSave 收到新值,成功出 status', async () => {
  const seen: number[] = [];
  const { host, unmount } = mount(
    createElement(GoalCard, {
      goal: 1500,
      onSave: async (g: number): Promise<GoalResult> => {
        seen.push(g);
        return { ok: true, goalMl: g };
      },
    }),
  );
  typeInto(input(host), '2000');
  assert.equal(button(host).disabled, false);
  click(button(host));
  await flush();
  assert.deepEqual(seen, [2000]);
  const status = host.querySelector('[role="status"]');
  assert.ok(status, '成功应出 status');
  assert.match(status!.textContent ?? '', /已保存/);
  unmount();
});

test('GoalCard:后端返回 offline → 专属人话提示(不是笼统失败)', async () => {
  const { host, unmount } = mount(
    createElement(GoalCard, {
      goal: 1500,
      onSave: async (): Promise<GoalResult> => ({ ok: false, reason: 'offline' }),
    }),
  );
  typeInto(input(host), '1800');
  click(button(host));
  await flush();
  const alert = host.querySelector('[role="alert"]');
  assert.ok(alert);
  assert.match(alert!.textContent ?? '', /连不上后端/);
  unmount();
});

test('GoalCard:后端返回 invalid → 提示范围;timeout → 提示重试', async () => {
  const mk = (reason: 'invalid' | 'timeout') =>
    mount(
      createElement(GoalCard, {
        goal: 1500,
        onSave: async (): Promise<GoalResult> => ({ ok: false, reason }),
      }),
    );
  const a = mk('invalid');
  typeInto(input(a.host), '1600');
  click(button(a.host));
  await flush();
  assert.match(a.host.querySelector('[role="alert"]')!.textContent ?? '', /ml/);
  a.unmount();

  const b = mk('timeout');
  typeInto(input(b.host), '1700');
  click(button(b.host));
  await flush();
  assert.match(b.host.querySelector('[role="alert"]')!.textContent ?? '', /再试一次/);
  b.unmount();
});
