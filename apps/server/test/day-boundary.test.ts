/**
 * 日界时区测试 —— 对应 09 路线文档"日界用本地时区(多时区用户需改)"。
 *
 * 关键保证:
 *   · 不配时区 → 与旧实现(本地)一致
 *   · 配了 IANA 时区 → dayKey/dayStart 按该时区算,且 dayStart 是那天真实的 00:00
 *   · shiftDay 是纯日历运算,与时区无关
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dayKey,
  dayStart,
  shiftDay,
  setDayTimeZone,
  getDayTimeZone,
} from '@cup/server';

// 每个用例后恢复默认(本地),避免相互污染(时区是模块级状态)
function withTz<T>(tz: string | null, fn: () => T): T {
  setDayTimeZone(tz);
  try {
    return fn();
  } finally {
    setDayTimeZone(null);
  }
}

test('dayTz:默认是服务器本地时区,可用 setDayTimeZone 设置与恢复', () => {
  setDayTimeZone(null);
  assert.equal(getDayTimeZone(), null);
  setDayTimeZone('Asia/Shanghai');
  assert.equal(getDayTimeZone(), 'Asia/Shanghai');
  setDayTimeZone(null);
  assert.equal(getDayTimeZone(), null);
});

test('dayTz:非法时区名抛错(启动期早失败)', () => {
  assert.throws(() => setDayTimeZone('Not/AZone'));
  setDayTimeZone(null); // 收尾
});

test('dayKey:UTC 时刻在 UTC+8 下的自然日', () => {
  // 2026-10-11 00:30 UTC = 2026-10-11 08:30 (+08) → 同一天
  const t1 = Date.UTC(2026, 9, 11, 0, 30, 0);
  assert.equal(withTz('Asia/Shanghai', () => dayKey(t1)), '2026-10-11');

  // 2026-10-10 17:00 UTC = 2026-10-11 01:00 (+08) → 已是次日
  const t2 = Date.UTC(2026, 9, 10, 17, 0, 0);
  assert.equal(withTz('Asia/Shanghai', () => dayKey(t2)), '2026-10-11');
  // 同一时刻在 UTC 下还是 10-10
  assert.equal(withTz('UTC', () => dayKey(t2)), '2026-10-10');
});

test('dayStart:返回该时区那天的 00:00(跨时区正确)', () => {
  const sh = withTz('Asia/Shanghai', () => dayStart('2026-10-11'));
  // 上海 2026-10-11 00:00 = 2026-10-10 16:00 UTC
  assert.equal(sh, Date.UTC(2026, 9, 10, 16, 0, 0));

  const utc = withTz('UTC', () => dayStart('2026-10-11'));
  assert.equal(utc, Date.UTC(2026, 9, 11, 0, 0, 0));

  // 往返一致:dayKey(dayStart(d)) === d
  assert.equal(withTz('Asia/Shanghai', () => dayKey(dayStart('2026-10-11'))), '2026-10-11');
});

test('dayStart:dayKey 往返在多个时区下都成立', () => {
  for (const tz of ['UTC', 'Asia/Shanghai', 'America/New_York', 'Europe/London', 'Asia/Kolkata']) {
    withTz(tz, () => {
      for (const d of ['2026-01-01', '2026-06-15', '2026-12-31']) {
        assert.equal(dayKey(dayStart(d)), d, `${tz} ${d}`);
      }
    });
  }
});

test('dayStart:有 DST 的时区在切换日仍落在当天 00:00', () => {
  // 美东 2026-03-08 是 DST 开始日(该日只有 23 小时)
  withTz('America/New_York', () => {
    const s = dayStart('2026-03-08');
    assert.equal(dayKey(s), '2026-03-08');
    // 当天正午落在同一天
    assert.equal(dayKey(s + 12 * 3600_000), '2026-03-08');
    // 前一日 23:59:59 仍在 03-07
    assert.equal(dayKey(s - 1000), '2026-03-07');
  });
});

test('shiftDay:纯日历加减,与时区无关', () => {
  assert.equal(shiftDay('2026-10-11', 1), '2026-10-12');
  assert.equal(shiftDay('2026-10-11', -1), '2026-10-10');
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
  // 配置了时区也不该改变日历结果
  assert.equal(withTz('Asia/Shanghai', () => shiftDay('2026-10-11', 3)), '2026-10-14');
  assert.equal(withTz('America/New_York', () => shiftDay('2026-10-11', 3)), '2026-10-14');
});
