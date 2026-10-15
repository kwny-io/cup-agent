/**
 * P4.2 人格包 → 渲染参数 的映射回归(纯函数,不碰渲染)。
 *
 * 钉两件事:
 *   1. **不装包 = 逐帧与今天一致** —— 缺省参数逐字等于各模块的出厂常量(关键不变量,
 *      保证没包时渲染零回归);
 *   2. **装包时按键覆盖** —— 包里有哪个键就用哪个,缺的键回落出厂值(部分包不报全身)。
 * 另:脏值(非数 / NaN / Infinity)一律回落,不让一个坏包毁掉手感。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packRenderParams, DEFAULT_RENDER_PARAMS } from '../src/lib/pack-render.ts';
import { DEFAULT_WAVE_PARAMS } from '../src/lib/water.ts';
import { DEFAULT_MOOD_PARAMS } from '../src/lib/mood.ts';
import { DEFAULT_EYE_PARAMS } from '../src/lib/eyes.ts';
import type { PersonaPack } from '../src/data/source.ts';

/** 造一个最小可用包(只带要测的字段) */
function pack(thresholds: Record<string, number>, wave: Record<string, number> = {}): PersonaPack {
  return {
    pack_id: 'p1',
    author_user_id: 'u1',
    name: '测试包',
    tone: '简短',
    thresholds,
    wave,
    lines: [],
    status: 'approved',
    created_at: 0,
  };
}

test('无包(null/undefined)→ 出厂体质,逐字等于各模块默认常量', () => {
  assert.deepEqual(packRenderParams(null), DEFAULT_RENDER_PARAMS);
  assert.deepEqual(packRenderParams(undefined), DEFAULT_RENDER_PARAMS);
  // 三组默认值各自也逐字对齐(不依赖 DEFAULT_RENDER_PARAMS 自身正确)
  assert.deepEqual(DEFAULT_RENDER_PARAMS.wave, DEFAULT_WAVE_PARAMS);
  assert.deepEqual(DEFAULT_RENDER_PARAMS.mood, DEFAULT_MOOD_PARAMS);
  assert.deepEqual(DEFAULT_RENDER_PARAMS.eye, DEFAULT_EYE_PARAMS);
});

test('装包:三处阈值 + 三个波键都被包值覆盖', () => {
  const p = pack(
    { REFUSE_S: 1.2, SMUG_S: 8, SULK_LEVEL: 0.5, CONTENT_S: 3 },
    { k: 10, c: 200, damp: 1 },
  );
  const r = packRenderParams(p);
  assert.deepEqual(r.wave, { k: 10, c: 200, damp: 1 });
  assert.deepEqual(r.mood, { refuseS: 1.2, smugS: 8, sulkLevel: 0.5 });
  assert.deepEqual(r.eye, { contentS: 3 });
});

test('部分包:只报一部分键,缺的键回落出厂值(不报全身也不毁手感)', () => {
  const p = pack({ SMUG_S: 9 }, { k: 5 });
  const r = packRenderParams(p);
  assert.equal(r.mood.smugS, 9); // 有 → 用包的
  assert.equal(r.mood.refuseS, DEFAULT_MOOD_PARAMS.refuseS); // 缺 → 回落
  assert.equal(r.mood.sulkLevel, DEFAULT_MOOD_PARAMS.sulkLevel);
  assert.equal(r.eye.contentS, DEFAULT_EYE_PARAMS.contentS);
  assert.equal(r.wave.k, 5);
  assert.equal(r.wave.c, DEFAULT_WAVE_PARAMS.c);
  assert.equal(r.wave.damp, DEFAULT_WAVE_PARAMS.damp);
});

test('脏值(非数 / NaN / Infinity)→ 各自回落,绝不外泄坏数', () => {
  const dirty = pack(
    {
      REFUSE_S: NaN,
      SMUG_S: Infinity,
      SULK_LEVEL: 'oops' as unknown as number,
      CONTENT_S: 4,
    },
    { k: undefined as unknown as number, c: -Infinity },
  );
  const r = packRenderParams(dirty);
  assert.equal(r.mood.refuseS, DEFAULT_MOOD_PARAMS.refuseS);
  assert.equal(r.mood.smugS, DEFAULT_MOOD_PARAMS.smugS);
  assert.equal(r.mood.sulkLevel, DEFAULT_MOOD_PARAMS.sulkLevel);
  assert.equal(r.eye.contentS, 4); // 好值照用
  assert.equal(r.wave.k, DEFAULT_WAVE_PARAMS.k);
  assert.equal(r.wave.c, DEFAULT_WAVE_PARAMS.c);
});

test('前端不消费的包键(IDLE_S / SULK_STREAK)→ 映射里不出现,不误配', () => {
  const p = pack({ IDLE_S: 999, SULK_STREAK: 7 });
  const r = packRenderParams(p);
  // 这两键既不在 mood 也不在 eye、更不会溜进 wave
  assert.deepEqual(r.mood, DEFAULT_MOOD_PARAMS);
  assert.deepEqual(r.eye, DEFAULT_EYE_PARAMS);
  assert.deepEqual(r.wave, DEFAULT_WAVE_PARAMS);
});
