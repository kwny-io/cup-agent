/**
 * 一维水波物理测试 —— 把 M3 英雄功能的"看着对"固化成断言。
 *
 * 验收点(plan.md / HANDOFF §5):
 *   1. 摇杯 → 液面明显起伏,停手能静下来,且晃动不改变水量;
 *   2. 倾斜 → 液面流向低处,静下来水平**且带倾角**(约 tan(倾角));
 *   3. 数值稳定:极端驱动下不发散、不出 NaN;
 *   4. 固定步长:步长粗细不改变物理结果(输入 50Hz/渲染 60fps 不漂)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WaterWave,
  FIXED_DT,
  MAX_TAN,
  SHAKE_DRIVE_AMP,
  SHAKE_HZ,
  cupTiltFromSlope,
} from '../src/lib/water.ts';

const maxAbs = (a: Float32Array) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
const mean = (a: Float32Array) => a.reduce((s, x) => s + x, 0) / a.length;

/** 按 CupWidget 的真实驱动摇杯若干秒,返回期间波峰峰值。 */
function shakeFor(w: WaterWave, sec: number, amp: number): number {
  let phase = 0;
  let peak = 0;
  for (let t = 0; t < sec; t += FIXED_DT) {
    phase += FIXED_DT * Math.PI * 2 * SHAKE_HZ;
    w.drive(phase, amp * SHAKE_DRIVE_AMP, FIXED_DT);
    w.step(FIXED_DT);
    if (t > sec * 0.5) peak = Math.max(peak, maxAbs(w.h));
  }
  return peak;
}

test('摇杯:液面明显起伏,且没顶到幅值上限', () => {
  const w = new WaterWave();
  const peak = shakeFor(w, 6, 1.0); // amp=1 是 CupWidget 里 shake 时的基准
  assert.ok(peak > 18, `摇晃幅度太小,看不出来:|h|=${peak.toFixed(1)}px`);
  assert.ok(peak < 55, `摇晃顶到上限了,不像波:|h|=${peak.toFixed(1)}px`);
});

test('摇杯:停手后能静下来(不会永远晃)', () => {
  const w = new WaterWave();
  shakeFor(w, 6, 1.0);
  let settleT = -1;
  for (let t = 0; t < 6; t += FIXED_DT) {
    w.step(FIXED_DT);
    if (w.calm) {
      settleT = t;
      break;
    }
  }
  assert.ok(settleT >= 0, '停手后一直没静下来');
  assert.ok(settleT < 5, `静得太慢:${settleT.toFixed(2)}s`);
});

test('摇杯:晃动不改变水量(零均值)', () => {
  const w = new WaterWave();
  shakeFor(w, 6, 1.0);
  assert.ok(Math.abs(mean(w.h)) < 0.2, `水面整体偏移了:均值=${mean(w.h).toExponential(2)}`);
});

test('倾斜:稳态液面流向低处,且带约 40° 的倾角', () => {
  const w = new WaterWave();
  const tiltRad = (40 * Math.PI) / 180;
  // 用 1.2s 把倾角从 0 拉到 40°(模拟遥测变化),再保持 4s
  for (let t = 0; t < 1.5; t += FIXED_DT) {
    w.applyTilt(tiltRad * Math.min(1, t / 1.2), FIXED_DT);
    w.step(FIXED_DT);
  }
  for (let t = 0; t < 4; t += FIXED_DT) {
    w.applyTilt(tiltRad, FIXED_DT);
    w.step(FIXED_DT);
  }
  const n = w.n;
  const left = w.surfaceOffset(2);
  const right = w.surfaceOffset(n - 3);
  const spanPx = ((n - 5) / (n - 1)) * w.spanPx;
  const angleDeg = (Math.atan2(right - left, spanPx) * 180) / Math.PI;

  assert.ok(right - left > 40, `液面没明显流向低处:左=${left.toFixed(1)} 右=${right.toFixed(1)}px`);
  assert.ok(angleDeg > 28 && angleDeg < 42, `视觉倾角不对:≈${angleDeg.toFixed(1)}°`);

  const expectTan = Math.min(Math.tan(tiltRad) * 0.92, MAX_TAN);
  assert.ok(
    Math.abs(w.slopeTan - expectTan) < expectTan * 0.15,
    `倾斜幅度不符合目标:tan=${w.slopeTan.toFixed(3)} 目标=${expectTan.toFixed(3)}`,
  );
});

test('倾斜:静下来后波动消失(水平带倾角),且不改变水量', () => {
  const w = new WaterWave();
  const tiltRad = (40 * Math.PI) / 180;
  for (let t = 0; t < 6; t += FIXED_DT) {
    w.applyTilt(tiltRad, FIXED_DT);
    w.step(FIXED_DT);
  }
  assert.ok(maxAbs(w.h) < 0.6, `静置后还有残余波:${maxAbs(w.h).toFixed(3)}px`);
  assert.ok(Math.abs(mean(w.h)) < 0.2, `倾斜改变了水量:均值=${mean(w.h).toExponential(2)}`);
});

test('数值稳定:极端驱动下不发散、不出 NaN', () => {
  const w = new WaterWave();
  let phase = 0;
  for (let t = 0; t < 10; t += FIXED_DT) {
    phase += FIXED_DT * Math.PI * 2 * SHAKE_HZ;
    w.drive(phase, SHAKE_DRIVE_AMP * 2, FIXED_DT); // 2 倍强度施压
    w.applyTilt(Math.sin(t * 3) * 1.2, FIXED_DT); // 来回大幅倾斜
    w.step(FIXED_DT);
    const m = maxAbs(w.h);
    assert.ok(Number.isFinite(m) && m <= 400, `数值发散了:|h|=${m}`);
  }
});

test('固定步长:步长粗细不改变物理结果(帧率无关)', () => {
  const run = (dt: number) => {
    const w = new WaterWave();
    let phase = 0;
    for (let t = 0; t < 1.0; t += dt) {
      phase += dt * Math.PI * 2 * SHAKE_HZ;
      w.drive(phase, SHAKE_DRIVE_AMP, dt);
      w.step(dt);
    }
    for (let t = 0; t < 0.5; t += dt) w.step(dt); // 自由衰减
    return w;
  };
  const a = maxAbs(run(FIXED_DT).h);
  const b = maxAbs(run(FIXED_DT / 2).h);
  assert.ok(
    Math.abs(a - b) / Math.max(a, b) < 0.25,
    `步长影响了结果:粗=${a.toFixed(1)} 细=${b.toFixed(1)}`,
  );
});

// ── 杯体随倾斜旋转(「卡通杯没跟着倾斜」的修复)────────────────

test('杯体旋转角 = atan(液面 slope),与 tan 互逆', () => {
  for (const tan of [-0.5, -0.1, 0, 0.12, 0.4, 0.73]) {
    const rad = cupTiltFromSlope(tan);
    assert.ok(Math.abs(Math.tan(rad) - tan) < 1e-9, `tan=${tan} 反解不回去:${Math.tan(rad)}`);
  }
  assert.equal(cupTiltFromSlope(0), 0, '正立时不转');
});

test('杯体转过去、液面在世界上就是平的:斜率相加抵消', () => {
  const w = new WaterWave();
  const tiltRad = (30 * Math.PI) / 180;
  for (let t = 0; t < 5; t += FIXED_DT) {
    w.applyTilt(tiltRad, FIXED_DT);
    w.step(FIXED_DT);
  }
  const cupRad = cupTiltFromSlope(w.slopeTan);
  // 杯内液面相对杯体是 -atan(slopeTan)(右高 = y 更小);再叠上杯体转角
  // 得到世界倾角。tan(A+B),B = atan(-slopeTan) → 恰好抵消。
  const a = Math.tan(cupRad);
  const b = -w.slopeTan;
  const worldSlopeTan = (a + b) / (1 - a * b);
  assert.ok(Math.abs(worldSlopeTan) < 1e-9, `世界液面没被补偿平:${worldSlopeTan}`);
  assert.ok(Math.abs(cupRad) > 0.2, '杯体应确实转了(不是原地不动)');
});

test('倾斜回正:杯体角度跟着回到 0', () => {
  const w = new WaterWave();
  const tiltRad = (30 * Math.PI) / 180;
  for (let t = 0; t < 3; t += FIXED_DT) {
    w.applyTilt(tiltRad, FIXED_DT);
    w.step(FIXED_DT);
  }
  assert.ok(Math.abs(cupTiltFromSlope(w.slopeTan)) > 0.2, '前段应倾斜');
  for (let t = 0; t < 3; t += FIXED_DT) {
    w.applyTilt(0, FIXED_DT);
    w.step(FIXED_DT);
  }
  assert.ok(Math.abs(cupTiltFromSlope(w.slopeTan)) < 0.02, '回正后应几乎直立');
});
