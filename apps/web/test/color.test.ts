/**
 * 水温配色测试。
 *
 * 这段曾出过真实的渲染崩溃:把 mix() 的输出(成了 'rgb(r,g,b)')再喂回
 * mix(),旧的解析只认 '#rrggbb',算出 NaN → canvas addColorStop 直接抛。
 * 这里钉住两件事:插值产物可再插值;整条色阶从头到尾都不产 NaN。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hex, mix, tempColor, TEMP_STOPS } from '../src/lib/color.ts';

const isColor = (s: string) => /^#[0-9a-f]{6}$|^rgb\(\d+,\d+,\d+\)$/i.test(s);

test('hex 同时认 #rrggbb 与 rgb(...)', () => {
  assert.deepEqual(hex('#7fd1dd'), [0x7f, 0xd1, 0xdd]);
  assert.deepEqual(hex('rgb(47,142,160)'), [47, 142, 160]);
});

test('mix 的产物可以再次 mix(不会 NaN)', () => {
  const once = mix('#7fd1dd', '#2f8ea0', 0.5); // 已成为 rgb(...)
  const twice = mix(once, '#2f8ea0', 0.85); // drawWater 底部渐变干的事
  assert.ok(!/NaN/.test(twice), `二次插值出 NaN:${twice}`);
  assert.ok(isColor(twice), `不是合法颜色:${twice}`);
});

test('温度色阶:全程无 NaN、取值合法、超出范围被夹住', () => {
  for (let t = -20; t <= 110; t += 0.5) {
    const c = tempColor(t);
    for (const k of ['fill', 'deep', 'foam'] as const) {
      assert.ok(isColor(c[k]), `t=${t} 的 ${k} 不合法:${c[k]}`);
    }
  }
  const lo = tempColor(-50);
  assert.deepEqual(lo, tempColor(TEMP_STOPS[0]!.t), '低于最低温应取首段纯色');
  const hi = tempColor(200);
  assert.deepEqual(hi, tempColor(TEMP_STOPS[TEMP_STOPS.length - 1]!.t), '高于最高温应取末段纯色');
});

test('冷热两端一眼可辨(暖冷分明的色差)', () => {
  const cold = hex(tempColor(6).fill);
  const hot = hex(tempColor(80).fill);
  // 暖色应比冷色红得多、蓝得少:红分量差足够大即"一眼可辨"
  assert.ok(hot[0]! - cold[0]! > 40, `冷热 fill 红分量差不够:${cold} vs ${hot}`);
  assert.ok(cold[2]! - hot[2]! > 20, `冷热 fill 蓝分量差不够:${cold} vs ${hot}`);
});
