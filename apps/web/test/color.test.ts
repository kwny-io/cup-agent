/**
 * 水温配色测试。
 *
 * 这段曾出过真实的渲染崩溃:把 mix() 的输出(成了 'rgb(r,g,b)')再喂回
 * mix(),旧的解析只认 '#rrggbb',算出 NaN → canvas addColorStop 直接抛。
 * 这里钉住两件事:插值产物可再插值;整条色阶从头到尾都不产 NaN。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hex,
  mix,
  tempColor,
  tempZone,
  heatAmount,
  TEMP_STOPS,
  TEMP_ZONE_EDGES,
} from '../src/lib/color.ts';

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

// ── 温度分区(「做区域切分」)────────────────────────────────

test('温度分区:边界向内归入低温那一档,不重叠不跳档', () => {
  const e = TEMP_ZONE_EDGES;
  assert.equal(tempZone(-10), 'cold');
  assert.equal(tempZone(e.cool - 0.1), 'cold');
  assert.equal(tempZone(e.cool), 'cool');
  assert.equal(tempZone(e.comfort - 0.1), 'cool');
  assert.equal(tempZone(e.comfort), 'comfort');
  assert.equal(tempZone(e.hot - 0.1), 'comfort');
  assert.equal(tempZone(e.hot), 'hot');
  assert.equal(tempZone(e.scalding - 0.1), 'hot');
  assert.equal(tempZone(e.scalding), 'scalding');
  assert.equal(tempZone(120), 'scalding');
});

test('温度分区:连续扫描 -20..120 恰好走一遍五档,不来回跳', () => {
  const seen: string[] = [];
  let prev = '';
  for (let t = -20; t <= 120; t += 0.5) {
    const z = tempZone(t);
    if (z !== prev) {
      seen.push(z);
      prev = z;
    }
  }
  assert.deepEqual(seen, ['cold', 'cool', 'comfort', 'hot', 'scalding']);
});

test('温度分区与颜色同源:高温区起点正好是金黄→暖橙那一段(52℃)', () => {
  assert.equal(TEMP_ZONE_EDGES.hot, 52);
  assert.ok(TEMP_STOPS.some((s) => s.t === TEMP_ZONE_EDGES.hot), '分区边界应落在色阶 stop 上');
  assert.equal(tempZone(51.9), 'comfort');
  assert.equal(tempZone(52), 'hot');
});

test('炎热强度:52℃ 起步为 0,65℃ 拉满为 1,超温恒为 1;区外恒 0', () => {
  assert.equal(heatAmount(TEMP_ZONE_EDGES.hot), 0);
  assert.equal(heatAmount(TEMP_ZONE_EDGES.scalding), 1);
  assert.equal(heatAmount(120), 1);
  assert.equal(heatAmount(20), 0);
  assert.equal(heatAmount(-5), 0);
  // 区间内单调、且严格介于 0..1
  let prev = -1;
  for (let t = 52; t <= 65; t += 1) {
    const a = heatAmount(t);
    assert.ok(a >= prev && a >= 0 && a <= 1, `t=${t} 强度不合法:${a}`);
    prev = a;
  }
  assert.ok(heatAmount(58.5) > 0.4 && heatAmount(58.5) < 0.6, '中点应约在半程');
});
