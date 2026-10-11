/**
 * 历史战报前端的纯函数回归 —— 只验逻辑,不碰渲染(渲染另见 dashboard.test.tsx)。
 *
 * 钉的是**展示层加工**:日期键怎么裁成 `MM-DD 周X`、汇总怎么算、进度怎么夹紧。
 * 每天的一句话(headline)由后端给,这里不测文案(那是后端的事)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayLabel, dayProgress, isToday, summarize } from '../src/lib/history.ts';
import { isServerHistory } from '../src/data/source.ts';
import type { ServerHistory } from '../src/data/source.ts';

test('dayLabel:YYYY-MM-DD → MM-DD 周X(按本地时区,不当 UTC 解析)', () => {
  // 2026-10-10 是星期六
  assert.equal(dayLabel('2026-10-10'), '10-10 周六');
  // 2026-10-11 是星期日
  assert.equal(dayLabel('2026-10-11'), '10-11 周日');
  // 形状不对 → 原样返回,不编
  assert.equal(dayLabel('not-a-date'), 'not-a-date');
  assert.equal(dayLabel('2026/10/10'), '2026/10/10');
});

test('isToday:只认同一个日键', () => {
  assert.equal(isToday('2026-10-10', '2026-10-10'), true);
  assert.equal(isToday('2026-10-09', '2026-10-10'), false);
});

test('summarize:合计/天数/达标天数全由逐日数字算', () => {
  const h: ServerHistory = {
    cup_id: 'cup',
    count: 3,
    days: [
      { date: '2026-10-10', drank_ml: 1500, goal_ml: 1500, progress: 100, drink_count: 5, temp_min_c: null, temp_max_c: null, streak: 1, reached_goal: true, headline: '达标了' },
      { date: '2026-10-09', drank_ml: 800, goal_ml: 1500, progress: 53, drink_count: 3, temp_min_c: null, temp_max_c: null, streak: 0, reached_goal: false, headline: '过半' },
      { date: '2026-10-08', drank_ml: 1600, goal_ml: 1500, progress: 100, drink_count: 6, temp_min_c: null, temp_max_c: null, streak: 1, reached_goal: true, headline: '达标了' },
    ],
  };
  assert.deepEqual(summarize(h), { days: 3, hitDays: 2, totalMl: 3900 });
  // null → 全零,不炸
  assert.deepEqual(summarize(null), { days: 0, hitDays: 0, totalMl: 0 });
});

test('dayProgress:0–1 夹紧,goal=0 不除零', () => {
  assert.equal(dayProgress({ drank_ml: 750, goal_ml: 1500 }), 0.5);
  assert.equal(dayProgress({ drank_ml: 2000, goal_ml: 1500 }), 1); // 超了也夹到 1
  assert.equal(dayProgress({ drank_ml: 0, goal_ml: 1500 }), 0);
  assert.equal(dayProgress({ drank_ml: 500, goal_ml: 0 }), 0); // 不除零
});

test('守卫:isServerHistory 认合法、拒半截', () => {
  const day = {
    date: '2026-10-10',
    drank_ml: 1500,
    goal_ml: 1500,
    progress: 100,
    drink_count: 5,
    temp_min_c: null,
    temp_max_c: null,
    streak: 1,
    reached_goal: true,
    headline: '达标了',
  };
  assert.equal(isServerHistory({ cup_id: 'c', days: [day], count: 1 }), true);
  assert.equal(isServerHistory({ cup_id: 'c', days: [], count: 0 }), true); // 空是正常态
  assert.equal(isServerHistory({ days: [{ date: 'x', drank_ml: 1 }] }), false); // 缺 headline
  assert.equal(isServerHistory({ days: [{ date: 1, drank_ml: 1, headline: 'h' }] }), false); // date 非字符串
  assert.equal(isServerHistory({ days: {} }), false); // 非数组
  assert.equal(isServerHistory(null), false);
});
