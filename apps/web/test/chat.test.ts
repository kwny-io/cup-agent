/**
 * 对话线纯函数的回归 —— 只验逻辑,不碰渲染(渲染交互另见 chat-panel.test.tsx)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_QUESTION,
  appendMsg,
  canSubmit,
  cupMsg,
  failedMsg,
  formatTime,
  pendingMsg,
  proactiveKey,
  proactiveMsg,
  resolvePending,
  userMsg,
  type ChatMsg,
} from '../src/lib/chat.ts';
import { isChatAnswer, isProactiveMessage, isServerSeries } from '../src/data/source.ts';
import type { ProactiveMessage } from '../src/data/source.ts';

test('canSubmit:空/纯空白/超长都不行,正常问句行', () => {
  assert.equal(canSubmit(''), false);
  assert.equal(canSubmit('   '), false);
  assert.equal(canSubmit('今天喝得怎么样?'), true);
  assert.equal(canSubmit('a'.repeat(MAX_QUESTION)), true); // 恰好上限
  assert.equal(canSubmit('a'.repeat(MAX_QUESTION + 1)), false); // 超一字符
});

test('userMsg 首尾去空白', () => {
  const m = userMsg('  喝水了吗  ', 1000, 'u1');
  assert.equal(m.text, '喝水了吗');
  assert.equal(m.role, 'user');
  assert.equal(m.ts, 1000);
});

test('appendMsg 超上限从头裁掉(旧的先走)', () => {
  let list: ChatMsg[] = [];
  for (let i = 0; i < 65; i++) {
    list = appendMsg(list, userMsg(`q${i}`, i, `u${i}`));
  }
  assert.equal(list.length, 60);
  assert.equal(list[0]?.text, 'q5'); // 前 5 条被裁
  assert.equal(list[list.length - 1]?.text, 'q64');
});

test('resolvePending 把占位换成最终答复', () => {
  const list = appendMsg(appendMsg([], userMsg('问', 1, 'u')), pendingMsg(1, 'p'));
  const resolved = resolvePending(
    list,
    'p',
    cupMsg({ text: '刚喝过啦', source: 'llm', tools_used: [], turns: 1 }, 2, 'p'),
  );
  assert.equal(resolved.length, 2);
  assert.equal(resolved[1]?.pending, undefined);
  assert.equal(resolved[1]?.text, '刚喝过啦');
  assert.equal(resolved[1]?.source, 'llm');
});

test('resolvePending 占位已被裁掉时,答复仍会追加(不退化为静默丢答)', () => {
  // 占位不在列表里(被慢回复期间的新消息挤出窗口)
  const list = appendMsg([], userMsg('问', 1, 'u'));
  const resolved = resolvePending(
    list,
    'p', // 这个 id 不在 list 里
    cupMsg({ text: '姗姗来迟', source: 'llm', tools_used: [], turns: 1 }, 2, 'p'),
  );
  assert.equal(resolved.length, 2);
  assert.equal(resolved[resolved.length - 1]?.text, '姗姗来迟'); // 答复没丢
});

test('failedMsg 是诚实的灰气泡,且按原因给不同措辞', () => {
  const m = failedMsg('offline', 5, 'p');
  assert.equal(m.failed, true);
  assert.equal(m.role, 'cup');
  // 四种原因两两不同(排障时能区分)
  const texts = new Set(
    (['offline', 'timeout', 'error', 'invalid'] as const).map((r) => failedMsg(r, 1, 'x').text),
  );
  assert.equal(texts.size, 4);
});

test('proactiveKey 按内容+时刻判重:同内容不同时刻算两条', () => {
  const a: ProactiveMessage = { text: '该喝水了', ts: 10, source: 'llm', facts: {} };
  const b: ProactiveMessage = { text: '该喝水了', ts: 20, source: 'llm', facts: {} };
  assert.notEqual(proactiveKey(a), proactiveKey(b));
  const c: ProactiveMessage = { text: '该喝水了', ts: 10, source: 'fallback', facts: {} };
  assert.equal(proactiveKey(c), proactiveKey(a)); // 同 ts 同文案 → 同键

  const m = proactiveMsg(a, 'p1'); // 主动搭话 → cup 气泡,时刻沿用消息自己的 ts
  assert.equal(m.role, 'cup');
  assert.equal(m.text, '该喝水了');
  assert.equal(m.ts, 10);
  assert.equal(m.source, 'llm');
});

test('formatTime 补零成 HH:MM', () => {
  const d = new Date(2026, 9, 8, 9, 5); // 09:05
  assert.equal(formatTime(d.getTime()), '09:05');
});

test('守卫:isChatAnswer 认合法、拒半截', () => {
  assert.equal(isChatAnswer({ text: 'hi', source: 'llm', tools_used: [], turns: 0 }), true);
  assert.equal(isChatAnswer({ text: 'hi', source: 'nope', tools_used: [], turns: 0 }), false);
  assert.equal(isChatAnswer({ text: 'hi', source: 'llm', turns: 0 }), false); // 缺 tools_used
  assert.equal(isChatAnswer(null), false);
});

test('守卫:isProactiveMessage 认合法、拒半截', () => {
  assert.equal(isProactiveMessage({ text: 'hi', ts: 1, source: 'fallback', facts: {} }), true);
  assert.equal(isProactiveMessage({ text: 'hi', ts: '1', source: 'fallback' }), false); // ts 非数
  assert.equal(isProactiveMessage({ text: 'hi',ts: 1, source: 'x' }), false);
  assert.equal(isProactiveMessage(undefined), false);
});

test('守卫:isServerSeries 认 7 桶、拒缺字段/非数组', () => {
  const bucket = { label: '10-09', ts: 1, drank_ml: 240, refill_ml: 0, temp_avg_c: null, last_volume_ml: null };
  assert.equal(isServerSeries({ cup_id: 'c', range: 'week', buckets: [bucket] }), true);
  assert.equal(isServerSeries({ buckets: [{ label: 'x', ts: 1 }] }), false); // 缺 drank_ml
  assert.equal(isServerSeries({ buckets: [{ label: 1, ts: 1, drank_ml: 0 }] }), false); // label 非字符串
  assert.equal(isServerSeries({ buckets: {} }), false); // 非数组
  assert.equal(isServerSeries(null), false);
});
