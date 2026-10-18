/**
 * 屏幕卡通杯的脸型决议 —— 「身体事实 > 心情」的优先级。
 *
 * 这层单独拎出来,是因为它决定**什么时候杯子的脸不再跟着心情走**:
 * 空杯(干旱)、水烫(受不了)、被摇(发懵)都比"傲娇/蔫/得意"更该被看见。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faceMode, DROUGHT_LEVEL, FACE_MODE_LABEL } from '../src/lib/face-mode.ts';
import type { Mood } from '../src/lib/mood.ts';
import type { TempZone } from '../src/lib/color.ts';

const base = {
  shaking: false,
  level01: 0.6,
  zone: 'comfort' as TempZone,
  mood: 'idle' as Mood,
};

test('平顺且有水 → 心情脸(idle / smug / sulk)', () => {
  assert.equal(faceMode(base), 'normal');
  assert.equal(faceMode({ ...base, mood: 'smug' }), 'smug');
  assert.equal(faceMode({ ...base, mood: 'sulk' }), 'sulk');
  // refuse/give 是摇杯过程中的短瞬心情,没在摇时按 idle 处理
  assert.equal(faceMode({ ...base, mood: 'refuse' }), 'normal');
  assert.equal(faceMode({ ...base, mood: 'give' }), 'normal');
});

test('空杯 → 干旱,压过心情', () => {
  for (const mood of ['idle', 'smug', 'sulk'] as Mood[]) {
    assert.equal(faceMode({ ...base, level01: 0, mood }), 'drought');
    assert.equal(faceMode({ ...base, level01: DROUGHT_LEVEL, mood }), 'drought');
  }
  // 略高于阈值就不算干旱
  assert.equal(faceMode({ ...base, level01: DROUGHT_LEVEL + 0.001 }), 'normal');
});

test('高温区(热/烫)→ 受不了炎热,压过心情;舒适及以下不触发', () => {
  for (const zone of ['hot', 'scalding'] as TempZone[]) {
    for (const mood of ['idle', 'smug', 'sulk'] as Mood[]) {
      assert.equal(faceMode({ ...base, zone, mood }), 'heat');
    }
  }
  for (const zone of ['cold', 'cool', 'comfort'] as TempZone[]) {
    assert.equal(faceMode({ ...base, zone }), 'normal');
  }
});

test('优先级:摇杯 > 干旱 > 炎热 > 心情', () => {
  // 摇杯时即便空杯、再烫,也是发懵(摇的那一下最强烈)
  assert.equal(faceMode({ ...base, shaking: true, level01: 0, zone: 'scalding' }), 'shaking');
  // 空杯优先于炎热:没水时"烫"没有意义
  assert.equal(faceMode({ ...base, level01: 0, zone: 'scalding' }), 'drought');
  // 炎热优先于心情
  assert.equal(faceMode({ ...base, zone: 'hot', mood: 'sulk' }), 'heat');
});

test('每一档都有中文名(调试/验收可读)', () => {
  for (const m of ['shaking', 'drought', 'heat', 'sulk', 'smug', 'normal'] as const) {
    assert.ok(FACE_MODE_LABEL[m] && FACE_MODE_LABEL[m].length > 0);
  }
});
