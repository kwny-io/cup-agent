/**
 * 人格包钳制 —— UGC 安全边(前端那道)。
 * 钉:越界值钳到边界、未知键丢弃、长文本截断、坏值不崩。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeThresholds, describeWave, sanitizeDraft, sanitizePack } from '../src/lib/pack-apply.ts';
import type { PersonaPack } from '../src/data/source.ts';

function mk(over: Partial<PersonaPack> = {}): PersonaPack {
  return {
    pack_id: 'p1',
    author_user_id: 'u1',
    name: '温柔包',
    tone: '柔柔的',
    thresholds: {},
    wave: {},
    lines: ['你好'],
    status: 'approved',
    created_at: 1,
    ...over,
  };
}

test('sanitizePack:越界阈值钳到语义边界', () => {
  const p = sanitizePack(mk({ thresholds: { SULK_LEVEL: 5, REFUSE_S: 0.0001, SMUG_S: 9999 } }));
  assert.equal(p.thresholds.SULK_LEVEL, 1, 'SULK_LEVEL 上限 1');
  assert.equal(p.thresholds.REFUSE_S, 0.05, 'REFUSE_S 下限 0.05');
  assert.equal(p.thresholds.SMUG_S, 30, 'SMUG_S 上限 30');
});

test('sanitizePack:水波参数钳制;负数被拉到下限', () => {
  const p = sanitizePack(mk({ wave: { k: -5, c: 1e9, damp: 0 } }));
  assert.equal(p.wave.k, 1, 'k 下限 1(负会让波发散)');
  assert.equal(p.wave.c, 800, 'c 上限 800');
  assert.equal(p.wave.damp, 0.1, 'damp 下限 0.1');
});

test('sanitizePack:未知键 / 非数值 全部丢弃', () => {
  const p = sanitizePack(
    mk({
      thresholds: { SULK_LEVEL: 0.5, EVIL: 1, NaNKey: NaN } as Record<string, number>,
      wave: { k: 42, x: 9 },
    }),
  );
  assert.deepEqual(Object.keys(p.thresholds), ['SULK_LEVEL']);
  assert.deepEqual(Object.keys(p.wave), ['k']);
});

test('sanitizePack:台词去空 / 截断 / 封顶 20 句;语气截断', () => {
  const long = 'x'.repeat(200);
  const many = Array.from({ length: 30 }, (_, i) => `台词${i}`);
  const p = sanitizePack(
    mk({ lines: ['', '  ', long, ...many], tone: 'y'.repeat(500) }),
  );
  assert.equal(p.lines.length, 20, '封顶 20 句');
  assert.equal(p.lines[0]!.length, 80, '单句截到 80');
  assert.equal(p.tone.length, 200, '语气截到 200');
  assert.ok(p.lines.every((l) => l.length > 0), '空句已被滤掉');
});

test('sanitizeDraft:与 sanitizePack 同口径(发后端前预夹)', () => {
  const d = sanitizeDraft({
    name: 'z'.repeat(100),
    tone: 'ok',
    thresholds: { SULK_STREAK: 999 },
    wave: { damp: 999 },
    lines: ['a'],
  });
  assert.equal(d.name.length, 40);
  assert.equal(d.thresholds.SULK_STREAK, 60);
  assert.equal(d.wave.damp, 40);
});

test('describeThresholds / describeWave:按固定键序、丢未知键', () => {
  const rows = describeThresholds({ SMUG_S: 4, SULK_LEVEL: 0.3, EVIL: 1 } as Record<string, number>);
  assert.deepEqual(
    rows.map((r) => r.key),
    ['SMUG_S', 'SULK_LEVEL'],
    '按后端键序(SMUG_S 在 SULK_LEVEL 前)',
  );
  assert.deepEqual(describeWave({ c: 1 }).map((r) => r.key), ['c']);
});
