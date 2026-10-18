/**
 * 看板卡片组件测试 —— 真挂载,验"有数据 / 空态"两分支与关键数字/结构。
 * 覆盖:WeekTrend、TodayPanel、Streak、HistoryCard。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { WeekTrend } from '../src/components/dashboard/WeekTrend.tsx';
import { TodayPanel } from '../src/components/dashboard/TodayPanel.tsx';
import { Streak } from '../src/components/dashboard/Streak.tsx';
import { HistoryCard } from '../src/components/dashboard/HistoryCard.tsx';
import type { ServerSeries, ServerHistory } from '../src/data/source.ts';
import type { TodayStats, CupSnapshot } from '../src/lib/stats.ts';
import { mount } from './mount.tsx';

const stats: TodayStats = {
  intakeMl: 728,
  drinkCount: 3,
  refillCount: 1,
  shakeCount: 2,
  alerts: 0,
  tempMin: 40,
  tempMax: 52,
};

const snap: CupSnapshot = {
  levelPct: 60,
  tempC: 48.4,
  weightG: 420,
  batteryPct: 80,
  charging: false,
  online: true,
};

test('WeekTrend:有后端周桶 → 出 7 根柱 + 达标天数汇总', () => {
  const series: ServerSeries = {
    cup_id: 'cup-A1B2C3',
    range: 'week',
    buckets: [
      { label: '10-05', ts: 1, drank_ml: 1500, refill_ml: 0, temp_avg_c: null, last_volume_ml: null },
      { label: '10-06', ts: 2, drank_ml: 900, refill_ml: 0, temp_avg_c: null, last_volume_ml: null },
      { label: '10-07', ts: 3, drank_ml: 1600, refill_ml: 0, temp_avg_c: null, last_volume_ml: null },
    ],
  };
  const { host, unmount } = mount(createElement(WeekTrend, { series }));
  // 3 个桶 → 3 个 <g>(每柱一组 rect+text)
  assert.equal(host.querySelectorAll('svg g').length, 3);
  // 合计 4000,达标 2 天(≥1500)
  assert.match(host.textContent ?? '', /合计 4000 ml/);
  assert.match(host.textContent ?? '', /达标 2 天/);
  unmount();
});

test('WeekTrend:无后端(series=null)→ 空态,不画 SVG 柱', () => {
  const { host, unmount } = mount(createElement(WeekTrend, { series: null }));
  assert.match(host.textContent ?? '', /连上后端/);
  assert.equal(host.querySelectorAll('svg g').length, 0);
  unmount();
});

test('TodayPanel:目标进度百分比 + 三个统计格 + 水温取整', () => {
  const { host, unmount } = mount(createElement(TodayPanel, { stats, snap }));
  // 728 / 1500 ≈ 48.5% → 49%
  assert.match(host.textContent ?? '', /49%/);
  assert.match(host.textContent ?? '', /728/);
  // 水温 48.4 → 48
  assert.match(host.textContent ?? '', /48/);
  assert.equal(host.querySelectorAll('section').length, 1);
  unmount();
});

test('TodayPanel:水温为 null → 显示占位破折号,分区条不画游标', () => {
  const { host, unmount } = mount(
    createElement(TodayPanel, { stats, snap: { ...snap, tempC: null } }),
  );
  assert.match(host.textContent ?? '', /—/);
  // 五个分区名常在,null 时只是没有"当前落在哪"的高亮游标
  for (const z of ['冷', '凉', '舒适', '热', '烫']) {
    assert.ok(host.textContent?.includes(z), `分区条缺「${z}」`);
  }
  const bar = host.querySelector('.relative.flex.h-2\\.5');
  assert.ok(bar, '没画分区条');
  assert.equal(bar!.querySelectorAll('span').length, 0, 'null 温度不该有游标');
  unmount();
});

test('TodayPanel:分区条按 TEMP_ZONE_EDGES 切分,游标落在所属区段上', () => {
  const { host, unmount } = mount(createElement(TodayPanel, { stats, snap }));
  const segs = [...host.querySelectorAll<HTMLElement>('.relative.flex.h-2\\.5 > div')];
  assert.equal(segs.length, 5, '应有 5 段(冷/凉/舒适/热/烫)');
  // 80℃ 满量程:14/38/52/65 → 17.5% / 47.5% / 65% / 81.25%
  const widths = segs.map((s) => Number.parseFloat(s.style.width));
  const want = [17.5, 30, 17.5, 16.25, 18.75];
  widths.forEach((w, i) => {
    assert.ok(Math.abs(w - want[i]!) < 0.1, `第 ${i} 段宽度 ${w}% ≠ ${want[i]}%`);
  });
  // 48.4℃ 落在 comfort(38–52) → 游标 48.4/80 = 60.5%
  const dot = host.querySelector<HTMLElement>('.relative.flex.h-2\\.5 > span');
  assert.ok(dot, '有温度时应有游标');
  assert.ok(
    Math.abs(Number.parseFloat(dot!.style.left) - 60.5) < 0.1,
    `游标位置 ${dot!.style.left} ≠ 60.5%`,
  );
  // 当前分区名加粗(舒适),其余不加
  const active = [...host.querySelectorAll('span.font-semibold')].map((s) => s.textContent);
  assert.ok(active.includes('舒适'), `当前分区没高亮:${active.join(',')}`);
  unmount();
});

test('Streak:有后端天数 → 直接显数字,达标显示徽章', () => {
  const { host, unmount } = mount(createElement(Streak, { stats, streak: 5 }));
  assert.match(host.textContent ?? '', /5/);
  assert.match(host.textContent ?? '', /连续达标天数/);
  // 728 < 1500 → 未达标
  assert.match(host.textContent ?? '', /今日进行中/);
  unmount();
});

test('Streak:未接后端(streak=null)→ 占位破折号 + 提示', () => {
  const { host, unmount } = mount(createElement(Streak, { stats, streak: null }));
  assert.match(host.textContent ?? '', /—/);
  assert.match(host.textContent ?? '', /占位/);
  unmount();
});

test('Streak:达标时显示"已达标"且摇杯次数 > 0 时出徽章', () => {
  const { host, unmount } = mount(
    createElement(Streak, { stats: { ...stats, intakeMl: 1600 }, streak: 3 }),
  );
  assert.match(host.textContent ?? '', /今日已达标/);
  assert.match(host.textContent ?? '', /摇了 2 次/);
  unmount();
});

test('HistoryCard:有历史 → 逐日条 + 汇总;今天那行带"今天"标', () => {
  const p = (n: number) => String(n).padStart(2, '0');
  const d = new Date();
  const todayKey = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const history: ServerHistory = {
    cup_id: 'cup-A1B2C3',
    count: 2,
    days: [
      {
        date: todayKey,
        drank_ml: 1600,
        goal_ml: 1500,
        progress: 1.07,
        drink_count: 4,
        temp_min_c: 40,
        temp_max_c: 55,
        streak: 3,
        reached_goal: true,
        headline: '今天喝得很够。',
      },
      {
        date: '2000-01-01',
        drank_ml: 300,
        goal_ml: 1500,
        progress: 0.2,
        drink_count: 1,
        temp_min_c: null,
        temp_max_c: null,
        streak: 0,
        reached_goal: false,
        headline: '喝得有点少。',
      },
    ],
  };
  const { host, unmount } = mount(createElement(HistoryCard, { history }));
  assert.equal(host.querySelectorAll('li').length, 2);
  assert.match(host.textContent ?? '', /今天/);
  assert.match(host.textContent ?? '', /1600\/1500 ml/);
  assert.match(host.textContent ?? '', /合计 1900 ml/);
  unmount();
});

test('HistoryCard:无后端(history=null)→ 空态提示', () => {
  const { host, unmount } = mount(createElement(HistoryCard, { history: null }));
  assert.match(host.textContent ?? '', /连上后端/);
  assert.equal(host.querySelectorAll('li').length, 0);
  unmount();
});

test('HistoryCard:有后端但零记录 → "暂无记录"', () => {
  const { host, unmount } = mount(
    createElement(HistoryCard, {
      history: { cup_id: 'c', count: 0, days: [] },
    }),
  );
  assert.match(host.textContent ?? '', /暂无记录/);
  unmount();
});
