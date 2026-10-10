import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PANEL_OPTIONS,
  BATTERY_MAH,
  DEVICE_BUDGET_MAH_PER_DAY,
  STATE_REFRESH_HZ,
  defaultProfile,
  estimateDaily,
  estimateAll,
  verdict,
} from '../src/lib/power.ts';
import type { EyeState } from '../src/lib/eyes.ts';

function opt(key: string) {
  const o = PANEL_OPTIONS.find((p) => p.key === key);
  assert.ok(o, `缺面板 ${key}`);
  return o!;
}

test('估算器:可眨眼方案里 Memory LCD 续航最好且达标 62 天量级', () => {
  const rows = estimateAll(defaultProfile()).filter((r) => r.canBlink);
  assert.equal(rows[0].key, 'memory-lcd');
  assert.ok(rows[0].days > 45, `期望 >45 天,得 ${rows[0].days}`);
});

test('估算器:电子纸虽然省电但被排除在"可用"之外', () => {
  const rows = estimateAll(defaultProfile());
  const epaper = rows.find((r) => r.key === 'epaper')!;
  // 它续航好,但 canBlink=false → 不该被当成"可交付方案"
  assert.ok(epaper.days > 45);
  assert.equal(epaper.canBlink, false);
  assert.equal(rows[0].key, 'epaper'); // 原始排序里它第一(诚实呈现:省电但不能眨眼)
});

test('估算器:常亮 IPS 直接死(<3 天)', () => {
  const r = estimateDaily(opt('ips-bright'), defaultProfile());
  assert.ok(r.days < 3, `期望 <3 天,得 ${r.days}`);
  assert.equal(verdict(r.days).tone, 'dead');
});

test('估算器:唤醒式 IPS 续航接近基线(唯一代价是"眼睛不在")', () => {
  const r = estimateDaily(opt('ips-duty'), defaultProfile());
  assert.ok(r.days > 45, `期望接近基线,得 ${r.days}`);
  // 每天点亮 300s → 额外耗电应为个位数 mAh
  assert.ok(r.dailyMah < 10, `唤醒式额外耗电应小,得 ${r.dailyMah}`);
});

test('估算器:电子纸判死(做不了眨眼)', () => {
  const r = estimateDaily(opt('epaper'), defaultProfile());
  assert.equal(r.canBlink, false);
});

test('估算器:电源基线本身 = 1500/62 天(记忆口径一致)', () => {
  // 加一个零耗电面板 → 天数应回到基线 62.5
  const zero = { key: 'zero', name: '零', note: '', holdMa: 0, refreshMah: 0, dutyCycle: 1, canBlink: true };
  const r = estimateDaily(zero, defaultProfile());
  assert.ok(Math.abs(r.days - BATTERY_MAH / DEVICE_BUDGET_MAH_PER_DAY) < 1e-9);
  assert.equal(r.totalMahPerDay, DEVICE_BUDGET_MAH_PER_DAY);
});

test('估算器:整机每天 = 基线 + 本脸额外', () => {
  const r = estimateDaily(opt('oled'), defaultProfile());
  assert.ok(Math.abs(r.totalMahPerDay - (DEVICE_BUDGET_MAH_PER_DAY + r.dailyMah)) < 1e-9);
  assert.ok(Math.abs(r.overBudget - r.totalMahPerDay / DEVICE_BUDGET_MAH_PER_DAY) < 1e-9);
});

test('估算器:时长翻倍 → 该状态耗电翻倍(线性)', () => {
  const base = defaultProfile();
  const doubled = defaultProfile();
  doubled.hours.idle *= 2;
  const o = opt('memory-lcd');
  const a = estimateDaily(o, base);
  const b = estimateDaily(o, doubled);
  const idleA = a.parts.find((p) => p.state === 'idle')!.mah;
  const idleB = b.parts.find((p) => p.state === 'idle')!.mah;
  assert.ok(Math.abs(idleB - idleA * 2) < 1e-12);
});

test('估算器:零时长状态耗电为 0', () => {
  const p = defaultProfile();
  (Object.keys(p.hours) as EyeState[]).forEach((k) => (p.hours[k] = 0));
  p.hours.idle = 1;
  const r = estimateDaily(opt('oled'), p);
  const zero = r.parts.filter((x) => x.hours === 0);
  assert.ok(zero.every((x) => x.mah === 0));
});

test('估算器:发光型刷新耗电为 0(电流已计入保持)', () => {
  const r = estimateDaily(opt('ips-bright'), defaultProfile());
  assert.equal(r.refreshMah, 0);
});

test('估算器:反射型刷新是唯一开销,保持极小', () => {
  const r = estimateDaily(opt('memory-lcd'), defaultProfile());
  assert.ok(r.refreshMah > r.holdMah, '刷新应大于静态保持');
  assert.ok(r.dailyMah < 1, `Memory LCD 本脸耗电应 <1mAh,得 ${r.dailyMah}`);
});

test('估算器:每个状态都有刷新频率定义(不遗漏)', () => {
  const states: EyeState[] = [
    'nap', 'sleep', 'idle', 'blink', 'look', 'startled',
    'tilt', 'content', 'sulky', 'smug', 'weak', 'forgotten',
  ];
  for (const s of states) assert.equal(typeof STATE_REFRESH_HZ[s], 'number', `缺 ${s}`);
});

test('续航分档:四档边界', () => {
  assert.equal(verdict(1).tone, 'dead');
  assert.equal(verdict(10).tone, 'poor');
  assert.equal(verdict(30).tone, 'ok');
  assert.equal(verdict(60).tone, 'great');
});

test('估算器:估算按续航从好到坏排序', () => {
  const rows = estimateAll(defaultProfile());
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].days >= rows[i].days, '降序被破坏');
  }
});
