/**
 * 每日目标纯逻辑的回归 —— 只验逻辑,不碰渲染。
 * 范围边界与后端 PUT /goal 的校验逐条对齐(0/负值/超上限都拦)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GOAL_MAX, GOAL_MIN, parseGoal } from '../src/lib/goal.ts';

test('parseGoal:合法整数通过,首尾空白被容忍', () => {
  assert.deepEqual(parseGoal('1500'), { ok: true, value: 1500 });
  assert.deepEqual(parseGoal('  2000 '), { ok: true, value: 2000 });
  assert.deepEqual(parseGoal('1'), { ok: true, value: 1 }); // 下界
  assert.deepEqual(parseGoal('10000'), { ok: true, value: 10000 }); // 上界
});

test('parseGoal:空 / 纯空白 / 非数字被拦', () => {
  assert.equal(parseGoal('').ok, false);
  assert.equal(parseGoal('   ').ok, false);
  assert.equal(parseGoal('abc').ok, false);
  assert.equal(parseGoal('1500ml').ok, false); // 带单位不算数
  assert.equal(parseGoal('-100').ok, false); // 负号:非 ^\d+$
  assert.equal(parseGoal('+100').ok, false);
});

test('parseGoal:小数 / 科学计数法被拦(只认整数毫升)', () => {
  assert.equal(parseGoal('15.5').ok, false);
  assert.equal(parseGoal('1e3').ok, false);
});

test('parseGoal:越界被拦,且 0 与负值也非法(对齐后端 goal<=0 → 400)', () => {
  assert.equal(parseGoal('0').ok, false); // 后端也会 400
  assert.equal(parseGoal(String(GOAL_MIN - 1)).ok, false);
  assert.equal(parseGoal(String(GOAL_MAX + 1)).ok, false);
  assert.equal(parseGoal('99999').ok, false);
});

test('parseGoal:失败带一句可显示的原因', () => {
  const r = parseGoal('20000');
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.reason.includes(String(GOAL_MAX)), '原因里应点出上限');
});
