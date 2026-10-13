/**
 * 保留策略(第 5 阶段)—— 纯逻辑部分,无需 DB。
 *
 * 钉的是"删哪些月分区"的**边界口径**,不是"删得爽不爽":
 *   · 只删**整段都早于 cutoff** 的月 → cutoff 落在某月中间时该月保留(宁多留不误删);
 *   · **绝不删当前月**(哪怕 retainDays=0);
 *   · 非 `YYYYMM` 形状的分区分区名(如 DEFAULT)一律不碰;
 *   · dropPartition 对非法表名/tag 先抛(白名单),不碰库;
 *   · retainDaysFromEnv:缺省/负/非数字 → 回退默认,不抛(配错值不该起不来)。
 *
 * 真跑(建库/删分区)由 pg 契约测试 / CI 服务容器负责(`CUP_PG_URL` 存在时才跑)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  partitionsToDrop,
  retainDaysFromEnv,
  dropPartition,
  DEFAULT_TELEMETRY_RETAIN_DAYS,
  DEFAULT_EVENTS_RETAIN_DAYS,
  DEFAULT_SERVER_LOGS_RETAIN_DAYS,
} from '@cup/server';

// 2026-10-13T00:00:00Z —— 固定基准,免得"今天"漂移把断言带跑
const NOW = Date.UTC(2026, 9, 13);
const day = 86_400_000;

test('遥测 90 天:cutoff 所在月(2026-07)保留,更早的整月删', () => {
  // NOW - 90d = 2026-07-15 → cutoffTag=202607 → 删 <202607
  const tags = ['202604', '202605', '202606', '202607', '202608', '202609', '202610'];
  assert.deepEqual(partitionsToDrop(tags, NOW, 90), ['202604', '202605', '202606']);
});

test('事件 395 天:只删 2025-09 以前的整月', () => {
  // NOW - 395d = 2025-09-13 → cutoffTag=202509 → 删 <202509
  const tags = ['202507', '202508', '202509', '202510', '202601'];
  assert.deepEqual(partitionsToDrop(tags, NOW, 395), ['202507', '202508']);
});

test('cutoff 恰落在某月 1 号:该月保留(整段不早于 cutoff)', () => {
  // now=2026-04-01,retain=90 → cutoff=2026-01-01 → cutoffTag=202601
  const now = Date.UTC(2026, 3, 1);
  const tags = ['202511', '202512', '202601', '202602'];
  // 202601 与 cutoffTag 相等 → 不删(该月起点不早于 cutoff)
  assert.deepEqual(partitionsToDrop(tags, now, 90), ['202511', '202512']);
});

test('绝不删当前月:retainDays=0 也只删上个月及更早', () => {
  const tags = ['202608', '202609', '202610']; // 202610 = 当前月
  assert.deepEqual(partitionsToDrop(tags, NOW, 0), ['202608', '202609']);
  // 当前月单独喂进去 → 一个不删
  assert.deepEqual(partitionsToDrop(['202610'], NOW, 0), []);
});

test('非 YYYYMM 形状的分区名(如 DEFAULT)一律不碰', () => {
  const tags = ['202601', 'DEFAULT', '2026', 'abcdef', '20260'];
  assert.deepEqual(partitionsToDrop(tags, NOW, 0), ['202601']);
});

test('空分区列表 → 空结果', () => {
  assert.deepEqual(partitionsToDrop([], NOW, 90), []);
  assert.deepEqual(partitionsToDrop(['202610'], NOW, 3650), []);
});

test('结果已排序(便于日志/断言稳定)', () => {
  const tags = ['202606', '202601', '202603'];
  assert.deepEqual(partitionsToDrop(tags, NOW, 90), ['202601', '202603', '202606']);
});

test('retainDaysFromEnv:缺省/非法 → 回退默认,不抛', () => {
  const def = DEFAULT_TELEMETRY_RETAIN_DAYS;
  assert.equal(DEFAULT_TELEMETRY_RETAIN_DAYS, 90);
  assert.equal(DEFAULT_EVENTS_RETAIN_DAYS, 395);
  assert.equal(DEFAULT_SERVER_LOGS_RETAIN_DAYS, 90);
  assert.equal(retainDaysFromEnv('X', def, {}), def);
  assert.equal(retainDaysFromEnv('X', def, { X: '' }), def);
  assert.equal(retainDaysFromEnv('X', def, { X: 'abc' }), def);
  assert.equal(retainDaysFromEnv('X', def, { X: '-5' }), def);
  assert.equal(retainDaysFromEnv('X', def, { X: '120' }), 120);
  assert.equal(retainDaysFromEnv('X', def, { X: '0' }), 0);
  assert.equal(retainDaysFromEnv('X', def, { X: '7.9' }), 7); // 取整
});

test('dropPartition:非法表名 / 非法 tag 先抛(白名单),不碰库', async () => {
  // 传 null 当 pool —— 若守卫失效会先撞上 pool 报错,而非我们期望的 Error
  await assert.rejects(() => dropPartition(null as never, 'users', '202601'), /非法分区名/);
  await assert.rejects(() => dropPartition(null as never, 'telemetry', 'DROP TABLE x'), /非法分区名/);
  await assert.rejects(() => dropPartition(null as never, 'telemetry', '20261'), /非法分区名/);
});
