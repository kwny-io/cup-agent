/**
 * 反打卡立场(#5)表现层的纯函数回归 —— 只验逻辑,不碰渲染。
 *
 * 钉的是备忘那句立场:"它会生气,但**会原谅你**" —— 所以凡是往**指责/加重**
 * 方向偏的实现(永不原谅、或一口就满血)都会被这里判红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUBBLE_DULL_MAX,
  PEP_GAIN,
  dejectedness,
  dulled,
  pepEnvelope,
  pepIsFresh,
  soberBubbleCount,
} from '../src/lib/sulk.ts';

test('不蔫 → 低落度恒 0(无论多久没喝)', () => {
  assert.equal(dejectedness(false, null), 0);
  assert.equal(dejectedness(false, 0), 0);
  assert.equal(dejectedness(false, 999), 0);
});

test('蔫且久未喝 → 满低落;喝一口 → 被哄回一小半', () => {
  const sad = dejectedness(true, null);
  assert.equal(sad, 1);
  // 刚喝一口:提振 = PEP_GAIN,低落 = 1 - 0.6 = 0.4
  const pepped = dejectedness(true, 0);
  assert.equal(Math.round(pepped * 100) / 100, 1 - PEP_GAIN);
  assert.ok(pepped < sad, '喝了一口就该比没喝精神一点');
  assert.ok(pepped > 0, '但绝不满血复活 —— 傲娇是"勉强振作"');
});

test('提振会衰减:喝过之后越久越蔫回去,单调不减', () => {
  const a = dejectedness(true, 0);
  const b = dejectedness(true, 10);
  const c = dejectedness(true, 60);
  assert.ok(a < b && b < c, `应单调回升 ${a} < ${b} < ${c}`);
  assert.ok(c > 0.9, '过了很久应快回到全蔫');
});

test('pepEnvelope:起点 1、随时间单调降到 0,不冒负值', () => {
  assert.equal(pepEnvelope(0), 1);
  assert.equal(pepEnvelope(-5), 1, '负数(时钟毛刺)按起点算,不外推 >1');
  const seq = [0, 5, 10, 22, 60].map(pepEnvelope);
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i]! <= seq[i - 1]!, '必须单调不增');
  assert.ok(pepEnvelope(22) < 0.4, '一个衰减常数后应明显回落');
  assert.equal(pepEnvelope(1e6), 0, '极久应精确归零,不留浮点尾巴');
});

test('pepIsFresh:只在刚喝那一小段为真', () => {
  assert.equal(pepIsFresh(null), false);
  assert.equal(pepIsFresh(0), true);
  assert.equal(pepIsFresh(0.5), true);
  assert.equal(pepIsFresh(5), false);
});

test('dulled:按亮度灰点去饱和,不是混中灰(暖色不该被染脏)', () => {
  // 纯红去饱和后 R==G==B(成了灰阶),且亮度接近原红的 luma
  const g = dulled('#ff0000', 1);
  const [r, gg, b] = g.match(/\d+/g)!.map(Number);
  assert.equal(r, gg);
  assert.equal(gg, b);
  assert.equal(r, Math.round(0.299 * 255)); // luma 保持
  // amount=0 原样返回;输出恒为 rgb(...) 形状
  assert.equal(dulled('#7fd1dd', 0), 'rgb(127,209,221)');
  // 半程:界于原色与灰之间
  const half = dulled('rgb(255,0,0)', 0.5).match(/\d+/g)!.map(Number);
  assert.ok(half[0]! < 255 && half[0]! > Math.round(0.299 * 255));
});

test('soberBubbleCount:蔫则气泡变少,但至少留 1 个(不是死水)', () => {
  assert.equal(soberBubbleCount(5, 0), 5); // 不蔫:原数
  assert.equal(soberBubbleCount(5, 1), Math.max(1, Math.round(5 * (1 - BUBBLE_DULL_MAX)))); // 蔫到底
  assert.ok(soberBubbleCount(5, 1) < soberBubbleCount(5, 0.3), '越蔫越少');
  assert.equal(soberBubbleCount(2, 1), 1, '再蔫也留一个');
  assert.equal(soberBubbleCount(5, -1), 5, '负低落度夹到 0,不加戏');
  assert.equal(soberBubbleCount(5, 9), soberBubbleCount(5, 1), '超界夹到 1');
});
