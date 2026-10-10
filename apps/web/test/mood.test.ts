/**
 * 心情状态机(傲娇宠物)的回归 —— 只验状态迁移,不碰渲染。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CupMood } from '../src/lib/mood.ts';

const DT = 1 / 120;

/** 往前推 n 秒 */
function run(m: CupMood, seconds: number, shaking: boolean, level: number): void {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) m.step(DT, shaking, level);
}

test('摇杯:先皱眉(refuse),再勉为其难(give)', () => {
  const m = new CupMood();
  run(m, 0.2, true, 0.5);
  assert.equal(m.current, 'refuse'); // 起手那一瞬是不耐烦
  run(m, 0.6, true, 0.5);
  assert.equal(m.current, 'give'); // 皱眉过后就"勉强接受"了
});

test('摇完回到常态,不会停在 give', () => {
  const m = new CupMood();
  run(m, 1.0, true, 0.5);
  assert.equal(m.current, 'give');
  run(m, 3, false, 0.5);
  assert.equal(m.current, 'idle');
});

test('被喝两口 → 得意,且会自己收', () => {
  const m = new CupMood();
  run(m, 1, false, 0.6);
  m.noteSip();
  run(m, 2, false, 0.6); // 隔开 2s(> 去抖),算实实在在的第二口
  assert.equal(m.current, 'idle'); // 一口还不够
  m.noteSip();
  assert.equal(m.current, 'smug'); // 第二口:哼,这才像话
  run(m, 5, false, 0.6); // 得意有时限
  assert.equal(m.current, 'idle');
});

test('同一口的重复触发不会被当成第二口(去抖)', () => {
  const m = new CupMood();
  m.noteSip();
  for (let i = 0; i < Math.round(0.5 / DT); i++) m.step(DT, false, 0.6);
  m.noteSip(); // 0.5s 后又一次 —— 同一口的抖,不该算第二口
  assert.equal(m.current, 'idle');
});

test('久置低水位 → 蔫(闹别扭)', () => {
  const m = new CupMood();
  run(m, 3, false, 0.2); // 还不到 6s
  assert.equal(m.current, 'idle');
  run(m, 4, false, 0.2); // 累计超过 6s
  assert.equal(m.current, 'sulk');
});

test('水位回到高位 → 不再蔫;摇晃优先于蔫', () => {
  const m = new CupMood();
  run(m, 8, false, 0.2);
  assert.equal(m.current, 'sulk');
  run(m, 1, false, 0.7); // 水位上来了
  assert.equal(m.current, 'idle');
  const m2 = new CupMood();
  run(m2, 8, false, 0.15); // 蔫着
  m2.step(DT, true, 0.15); // 这时被摇
  assert.equal(m2.current, 'refuse'); // 摇杯压过蔫
});

// ── 长期性格底色(M4)─────────────────────────────────────────────

test('长期性格:smug 底色 → 无事时一直是得意', () => {
  const m = new CupMood();
  m.setDisposition('smug');
  run(m, 1, false, 0.6); // 水位够高,不触发"被怠慢"
  assert.equal(m.current, 'smug');
});

test('长期性格:sulky 底色 → 无事时一直是蔫', () => {
  const m = new CupMood();
  m.setDisposition('sulky');
  run(m, 1, false, 0.6); // 水位高,不是"低水位才蔫"那条路径,纯靠底色
  assert.equal(m.current, 'sulk');
});

test('长期性格:瞬时事件压过底色(喝水照常得意)', () => {
  const m = new CupMood();
  m.setDisposition('sulky'); // 底色是蔫
  run(m, 1, false, 0.6);
  m.noteSip();
  run(m, 2, false, 0.6);
  m.noteSip(); // 第二口 → 瞬时得意
  assert.equal(m.current, 'smug'); // 底色被压过
});

test('长期性格:切回 normal → 无事时回到 idle', () => {
  const m = new CupMood();
  m.setDisposition('smug');
  run(m, 1, false, 0.6);
  assert.equal(m.current, 'smug');
  m.setDisposition('normal');
  run(m, 1, false, 0.6);
  assert.equal(m.current, 'idle');
});

test('长期性格:低水位持续仍会蔫,与底色无关', () => {
  const m = new CupMood();
  m.setDisposition('smug'); // 底色得意
  run(m, 8, false, 0.2); // 但水位一直低 → 物理性"被怠慢"更优先
  assert.equal(m.current, 'sulk');
});
