/**
 * 脾气变化史前端的纯函数回归 —— 只验逻辑,不碰渲染(渲染另见 dashboard.test.tsx)。
 *
 * 钉的是**展示层加工**:心情怎么印成中文/上什么色/柱多高、汇总天数与得意连击怎么算、
 * 趋势怎么从前后半段均分推出。心情本身由后端 computePersonality 逐日切出,这里不重算。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dispositionBlurb,
  dispositionDot,
  dispositionLabel,
  dispositionTone,
  dispositionWeight,
  moodTrend,
  summarizeMood,
  trendLabel,
} from '../src/lib/mood-history.ts';
import { isServerPersonalityHistory } from '../src/data/source.ts';
import type { DispositionDay, ServerPersonalityHistory } from '../src/data/source.ts';

const day = (date: string, disposition: DispositionDay['disposition'], reached = false): DispositionDay => ({
  date,
  disposition,
  reached_goal: reached,
});

test('心情 → 中文标签/短语', () => {
  assert.equal(dispositionLabel('sulky'), '蔫');
  assert.equal(dispositionLabel('normal'), '平常');
  assert.equal(dispositionLabel('smug'), '得意');
  assert.ok(dispositionBlurb('sulky').includes('蔫'));
});

test('心情 → 色调/圆点/柱高各不相同(三态可辨)', () => {
  const tones = [dispositionTone('sulky'), dispositionTone('normal'), dispositionTone('smug')];
  assert.equal(new Set(tones).size, 3, '三种色调互不相同');
  const dots = [dispositionDot('sulky'), dispositionDot('normal'), dispositionDot('smug')];
  assert.equal(new Set(dots).size, 3, '三种圆点色互不相同');
  // 柱高:蔫 < 平常 < 得意
  assert.ok(dispositionWeight('sulky') < dispositionWeight('normal'));
  assert.ok(dispositionWeight('normal') < dispositionWeight('smug'));
  assert.equal(dispositionWeight('smug'), 1, '得意满高');
});

test('summarizeMood:各心情天数 + 末尾得意连击', () => {
  const p: ServerPersonalityHistory = {
    cup_id: 'cup',
    count: 5,
    days: [
      day('2026-10-06', 'sulky'),
      day('2026-10-07', 'sulky'),
      day('2026-10-08', 'normal'),
      day('2026-10-09', 'smug'),
      day('2026-10-10', 'smug'),
    ],
  };
  assert.deepEqual(summarizeMood(p), { days: 5, sulky: 2, normal: 1, smug: 2, smugStreak: 2 });
  // 空 / null → 全零,不炸
  assert.deepEqual(summarizeMood(null), { days: 0, sulky: 0, normal: 0, smug: 0, smugStreak: 0 });
  assert.deepEqual(summarizeMood({ days: [] }), { days: 0, sulky: 0, normal: 0, smug: 0, smugStreak: 0 });
});

test('summarizeMood:得意连击只在末尾连续时计数(中间断了不算)', () => {
  const p = {
    days: [day('a', 'smug'), day('b', 'sulky'), day('c', 'smug'), day('d', 'smug')],
  };
  assert.equal(summarizeMood(p).smugStreak, 2, '只数末尾连续的两个,不看开头那个');
});

test('moodTrend:后半段比前半段好 → warming;差 → cooling;平 → steady', () => {
  // 旧→新:蔫 蔫 → 得意 得意
  const warming = { days: [day('1', 'sulky'), day('2', 'sulky'), day('3', 'smug'), day('4', 'smug')] };
  assert.equal(moodTrend(warming), 'warming');
  // 反过来
  const cooling = { days: [day('1', 'smug'), day('2', 'smug'), day('3', 'sulky'), day('4', 'sulky')] };
  assert.equal(moodTrend(cooling), 'cooling');
  // 一直平常
  const steady = { days: [day('1', 'normal'), day('2', 'normal'), day('3', 'normal'), day('4', 'normal')] };
  assert.equal(moodTrend(steady), 'steady');
});

test('moodTrend:天数 < 4 不给结论(样本太少 → steady)', () => {
  const short = { days: [day('1', 'sulky'), day('2', 'smug'), day('3', 'smug')] };
  assert.equal(moodTrend(short), 'steady');
  assert.equal(moodTrend(null), 'steady');
  assert.equal(moodTrend({ days: [] }), 'steady');
});

test('trendLabel:三档中文', () => {
  assert.equal(trendLabel('warming'), '最近比之前好');
  assert.equal(trendLabel('cooling'), '最近有点蔫');
  assert.equal(trendLabel('steady'), '一直挺稳');
});

test('守卫:isServerPersonalityHistory 认合法、拒半截/未知心情', () => {
  assert.equal(
    isServerPersonalityHistory({ cup_id: 'c', count: 1, days: [day('2026-10-10', 'smug')] }),
    true,
  );
  assert.equal(isServerPersonalityHistory({ cup_id: 'c', count: 0, days: [] }), true);
  // 缺 days
  assert.equal(isServerPersonalityHistory({ cup_id: 'c' }), false);
  // 未知心情值
  assert.equal(isServerPersonalityHistory({ days: [{ date: 'x', disposition: 'angry', reached_goal: false }] }), false);
  // 半截元素
  assert.equal(isServerPersonalityHistory({ days: [{ date: 'x' }] }), false);
  assert.equal(isServerPersonalityHistory(null), false);
});
