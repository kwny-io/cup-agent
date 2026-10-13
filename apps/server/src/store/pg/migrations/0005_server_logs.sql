-- 0005：服务日志表 server_logs —— 供技术人员（admin/ops/reviewer）回看。
--
-- 与 telemetry/events 同款：按月分区（PARTITION BY RANGE (ts)），**无主键**（append-only），
-- id 是插入序（bigserial，同 ts 的 tiebreak 与内存版稳定排序一致）。
-- 分区不在本文件声明 —— 由 migrate.ts 的 ensurePartitions 运行时建（{table}_{YYYYMM}），
-- 保留策略 applyRetention 按 DEFAULT_SERVER_LOGS_RETAIN_DAYS（90 天）删整月分区。
--
-- payload 存 ts/level/src/msg 之外的其余结构化字段（jsonb）。
CREATE TABLE IF NOT EXISTS server_logs (
  id      bigserial NOT NULL,
  ts      bigint NOT NULL,
  level   text NOT NULL,
  src     text,
  msg     text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
) PARTITION BY RANGE (ts);
-- PG 11+：主表建索引自动传播到现有分区与未来分区
CREATE INDEX IF NOT EXISTS server_logs_ts ON server_logs (ts DESC);
CREATE INDEX IF NOT EXISTS server_logs_level_ts ON server_logs (level, ts DESC);
