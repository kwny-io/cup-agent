/**
 * 手势语法识别器(创意备忘 §5.1 #1)的回归 —— 纯逻辑,不碰 DOM。
 * 钉死:各手势的边沿检测、连摇 vs 单摇的窗口区分、放下的阈值+静止、响应表自洽。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Gestures,
  GESTURE_RESPONSES,
  GESTURE_LABEL,
  latestTapTs,
  type Gesture,
  type GestureInputs,
} from '../src/lib/gesture.ts';
import { EYE_STATE_LABEL, type EyeState } from '../src/lib/eyes.ts';
import type { CupEvent, MotionState } from '@cup/contract';

const DT = 1 / 120;

function g(): Gestures {
  return new Gestures();
}

/** 喂一个 motion 电平持续 seconds 秒;返回期间**首次**命中的手势(没有则 null) */
function feed(rec: Gestures, motion: MotionState, seconds: number, tiltDeg = 0): Gesture | null {
  let hit: Gesture | null = null;
  const steps = Math.round(seconds / DT);
  for (let k = 0; k < steps; k++) {
    const got = rec.step(DT, { motion, tiltDeg });
    if (got && !hit) hit = got;
  }
  return hit;
}

function idle(rec: Gestures, seconds: number): void {
  feed(rec, 'idle', seconds, 0);
}

// ── 单摇 → 问它 ────────────────────────────────────────────────

test('单次摇 → shake(问它)', () => {
  const r = g();
  assert.equal(feed(r, 'shake', 0.5), 'shake');
});

test('摇的**起手**才触发一次,持续摇不再喷(电平不触发)', () => {
  const r = g();
  feed(r, 'shake', 0.5); // 第一次
  // 持续摇(没有回落再起),不应再出手势
  assert.equal(feed(r, 'shake', 1.0), null);
});

// ── 连摇 → 撒娇 ────────────────────────────────────────────────

test('窗口内的第二次起摇 → shakeTwice(撒娇)', () => {
  const r = g();
  assert.equal(feed(r, 'shake', 0.4), 'shake');
  idle(r, 0.3); // 松手回落(短暂)
  assert.equal(feed(r, 'shake', 0.4), 'shakeTwice');
});

test('超出窗口的第二次摇 → 又是 shake(不算撒娇)', () => {
  const r = g();
  feed(r, 'shake', 0.4);
  idle(r, 3.0); // 远超 DOUBLE_SHAKE_WINDOW_S
  assert.equal(feed(r, 'shake', 0.4), 'shake');
});

test('连摇只在"第二次"报一次,第三次不再重复', () => {
  const r = g();
  feed(r, 'shake', 0.4);
  idle(r, 0.3);
  assert.equal(feed(r, 'shake', 0.4), 'shakeTwice');
  idle(r, 0.3);
  assert.equal(feed(r, 'shake', 0.4), null, '同一串连摇不应无限喷撒娇');
});

// ── 倾斜 → 抗议 ────────────────────────────────────────────────

test('motion=tilt → tilt(抗议)', () => {
  const r = g();
  assert.equal(feed(r, 'tilt', 0.3, 40), 'tilt');
});

test('倾角越过阈值也算 tilt(即便 motion 没标)', () => {
  const r = g();
  assert.equal(feed(r, 'idle', 0.3, 30), 'tilt');
});

test('持续倾斜只触发一次(起倾边沿)', () => {
  const r = g();
  feed(r, 'tilt', 0.3, 40);
  assert.equal(feed(r, 'tilt', 1.0, 40), null);
});

// ── 放下 → 闭嘴 ────────────────────────────────────────────────

test('拿起再放下并静止 → putDown(闭嘴)', () => {
  const r = g();
  feed(r, 'lifted', 0.5, 0);
  // 放回:落到 idle,需稳 PUT_DOWN_SETTLE_S(1.0s)
  assert.equal(feed(r, 'idle', 1.4, 0), 'putDown');
});

test('放下后马上又动 → 不判 putDown', () => {
  const r = g();
  feed(r, 'lifted', 0.5, 0);
  feed(r, 'idle', 0.4, 0); // 还没稳够
  assert.equal(feed(r, 'tilt', 0.3, 40), 'tilt', '又动了,应改判其它手势');
  assert.equal(feed(r, 'idle', 1.5, 0), null, '且不应补一个 putDown');
});

// ── 轻磕/长按(契约 tap/long_press 事件)────────────────────────

test('noteTap() → tap(确认)', () => {
  const r = g();
  assert.equal(feed(r, 'idle', 0.1), null);
  r.noteTap();
  assert.equal(feed(r, 'idle', 0.1), 'tap');
});

// ── latestTapTs:从事件流挑出新的轻磕/长按 ───────────────────────

/** 造一个最小 cup 事件(手势类带 duration_ms) */
function ev(type: CupEvent['type'], ts: number): CupEvent {
  return {
    v: 1,
    cup_id: 'cup-ABC123',
    device_id: 'lid-ABC123',
    ts,
    type,
    confidence: 1,
    derived_by: 'lid',
    ...(type === 'tap' || type === 'long_press' ? { duration_ms: 100 } : {}),
  } as CupEvent;
}

test('latestTapTs:无手势事件 → null', () => {
  assert.equal(latestTapTs([ev('drink', 10), ev('shake', 20)], 0), null);
});

test('latestTapTs:tap 比 seenTs 新 → 返回其 ts', () => {
  assert.equal(latestTapTs([ev('tap', 30)], 0), 30);
});

test('latestTapTs:≤ seenTs 的旧事件被忽略(同一事件不吃两次)', () => {
  assert.equal(latestTapTs([ev('tap', 30)], 30), null, '等于 seenTs 应忽略');
  assert.equal(latestTapTs([ev('tap', 30)], 31), null, '早于 seenTs 应忽略');
});

test('latestTapTs:tap 与 long_press 都算,取最新', () => {
  assert.equal(latestTapTs([ev('tap', 30), ev('long_press', 55), ev('tap', 40)], 0), 55);
});

test('latestTapTs:只取 seenTs 之后的最新一个(多事件同帧)', () => {
  assert.equal(latestTapTs([ev('tap', 30), ev('tap', 60)], 30), 60);
});

// ── 去抖 ────────────────────────────────────────────────────────

test('全局去抖:去抖窗口内轻磕不冒头,窗口过后才出', () => {
  const r = g();
  feed(r, 'tilt', 0.1, 40); // tilt(短喂,别吃掉整段去抖窗口)
  r.noteTap();
  // 去抖窗口(0.4s)内:tap 被按住,不冒头
  assert.equal(feed(r, 'idle', 0.2), null);
  // 过了去抖窗口,tap 才出来
  assert.equal(feed(r, 'idle', 0.3), 'tap');
});

// ── 响应表自洽(备忘:"每动作 → ≤1 句 + 1 个表情")──────────────

test('每个手势都有回应,且台词非空、≤40 字(≤1 句的克制)', () => {
  for (const key of Object.keys(GESTURE_RESPONSES) as Gesture[]) {
    const r = GESTURE_RESPONSES[key];
    assert.ok(r.line.length > 0, `${key} 应有台词`);
    assert.ok(r.line.length <= 40, `${key} 台词应克制(≤40 字)`);
    assert.ok(EYE_STATE_LABEL[r.state], `${key} 的表情应指向合法 EyeState`);
  }
});

test('五类手势都有中文名 + 回应(表齐)', () => {
  const all: Gesture[] = ['shake', 'shakeTwice', 'tilt', 'putDown', 'tap'];
  for (const key of all) {
    assert.ok(GESTURE_LABEL[key], `${key} 应有中文名`);
    assert.ok(GESTURE_RESPONSES[key], `${key} 应有回应`);
  }
});

test('表情指向的都是 eyes.ts 认识的态(拼写防呆)', () => {
  const known = new Set<EyeState>(Object.keys(EYE_STATE_LABEL) as EyeState[]);
  for (const key of Object.keys(GESTURE_RESPONSES) as Gesture[]) {
    assert.ok(known.has(GESTURE_RESPONSES[key].state), `${key}.state 拼写应正确`);
  }
});
