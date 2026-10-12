-- 0001_init.sql —— 初始 schema（第 2 阶段）。
--
-- 口径对照（表 ↔ 现有内存/文件实现）：
--   users/sessions/packs/subscriptions/friends ↔ AccountsStore（memory.ts / accounts.ts）
--   cup_settings ↔ Store.goal/setGoal（cup_id → goal_ml）
--   cup_latest   ↔ Store.setLatestSample/latestSample（最新融合样本 jsonb）
--   daily_agg    ↔ Store.agg/recentAggs/applyEventToAgg/applySampleToAgg（PK cup_id,date）
--   telemetry    ↔ Store.appendTelemetry/telemetry（按 ts 月分区；只追加，无唯一键）
--   events       ↔ Store.appendEvent/events（按 ts 月分区；只追加，无唯一键）
--   chat_turns/chat_profile ↔ ChatStore（memory.ts）
--   cup_traits   ↔ ProfileStore（traits.ts）
--
-- 为什么 date 存 text 'YYYY-MM-DD'：复用 day-boundary.ts 的 dayKey()，零格式转换。
-- 为什么 telemetry/events 无主键：append 语义就是"只追加"，允许同 ts 并存（对齐内存版 push）。
-- 为什么 telemetry/events 要分区：十万用户下遥测约 58M 行/天，按月分区 + 删整分区做保留，
--   不逐行删（见计划的阶段 5）。分区由 migrate.ts 的 ensurePartitions() 滚动建。

-- ── 身份 / 社交（AccountsStore）──────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  user_id    text PRIMARY KEY,
  email      text NOT NULL,
  nickname   text NOT NULL,
  salt       text NOT NULL,
  hash       text NOT NULL,
  role       text NOT NULL DEFAULT 'user',
  created_at bigint NOT NULL,
  disabled   boolean NOT NULL DEFAULT false,
  cup_id     text
);
-- 唯一键口径 = normalizeEmail（小写去空格）；读/写都过它
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  token      text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS packs (
  pack_id        text PRIMARY KEY,
  author_user_id text NOT NULL,
  name           text NOT NULL,
  tone           text NOT NULL,
  thresholds     jsonb NOT NULL DEFAULT '{}'::jsonb,
  wave           jsonb NOT NULL DEFAULT '{}'::jsonb,
  lines          jsonb NOT NULL DEFAULT '[]'::jsonb,
  status         text NOT NULL DEFAULT 'pending',
  created_at     bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS packs_status ON packs (status, created_at DESC);

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id text NOT NULL,
  pack_id text NOT NULL,
  PRIMARY KEY (user_id, pack_id)
);

-- 好友：规范 (a<b) 存一份，避免重复（对齐 friendPair）
CREATE TABLE IF NOT EXISTS friends (
  a_user_id  text NOT NULL,
  b_user_id  text NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (a_user_id, b_user_id)
);

-- ── 杯子态（Store 的 durable 部分）───────────────────────────────

CREATE TABLE IF NOT EXISTS cup_settings (
  cup_id  text PRIMARY KEY,
  goal_ml integer NOT NULL
);

CREATE TABLE IF NOT EXISTS cup_latest (
  cup_id     text PRIMARY KEY,
  sample     jsonb NOT NULL,
  updated_at bigint NOT NULL
);

-- 日聚合：durable rollup。temp_sum/temp_n 是 temp_avg_c 的增量累计（不存样本数组）。
CREATE TABLE IF NOT EXISTS daily_agg (
  cup_id         text NOT NULL,
  date           text NOT NULL,
  drank_ml       double precision NOT NULL DEFAULT 0,
  refill_ml      double precision NOT NULL DEFAULT 0,
  drink_count    integer NOT NULL DEFAULT 0,
  goal_ml        integer NOT NULL DEFAULT 1500,
  temp_min_c     double precision,
  temp_max_c     double precision,
  temp_avg_c     double precision,
  temp_sum       double precision NOT NULL DEFAULT 0,
  temp_n         bigint NOT NULL DEFAULT 0,
  last_volume_ml double precision,
  streak         integer NOT NULL DEFAULT 0,
  event_count    integer NOT NULL DEFAULT 0,
  updated_at     bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (cup_id, date)
);

-- ── 高频只追加（按月分区）────────────────────────────────────────

-- id 是插入序（bigserial）：读取要按**插入序**回放，与内存版数组顺序一致；
-- 同 ts 的 tiebreak 靠它（memory 的 sort 稳定 → 同 ts 保插入序）。
CREATE TABLE IF NOT EXISTS telemetry (
  id        bigserial NOT NULL,
  cup_id    text NOT NULL,
  device_id text NOT NULL,
  kind      text NOT NULL,
  ts        bigint NOT NULL,
  seq       bigint NOT NULL,
  payload   jsonb NOT NULL
) PARTITION BY RANGE (ts);
-- PG 11+：主表建索引自动传播到现有分区与未来分区
CREATE INDEX IF NOT EXISTS telemetry_cup_ts ON telemetry (cup_id, ts);
CREATE INDEX IF NOT EXISTS telemetry_cup_id ON telemetry (cup_id, id);

CREATE TABLE IF NOT EXISTS events (
  id         bigserial NOT NULL,
  cup_id     text NOT NULL,
  device_id  text NOT NULL,
  ts         bigint NOT NULL,
  type       text NOT NULL,
  amount_ml  double precision,
  temp_c     double precision,
  confidence double precision NOT NULL,
  derived_by text NOT NULL,
  payload    jsonb NOT NULL
) PARTITION BY RANGE (ts);
CREATE INDEX IF NOT EXISTS events_cup_ts ON events (cup_id, ts);
CREATE INDEX IF NOT EXISTS events_cup_id ON events (cup_id, id);

-- ── 对话 / 画像 / 人格档案 ───────────────────────────────────────

-- id = 插入序（bigserial）：recentTurns / capTurns 的"最近 N 轮"按**插入序**取，
-- 与内存版数组 slice(-N) 一致（ts 未必单调，故不拿 ts 当顺序键）。
CREATE TABLE IF NOT EXISTS chat_turns (
  id         bigserial PRIMARY KEY,
  cup_id     text NOT NULL,
  ts         bigint NOT NULL,
  role       text NOT NULL,
  text       text NOT NULL,
  tools_used jsonb,
  source     text
);
CREATE INDEX IF NOT EXISTS chat_turns_cup_id ON chat_turns (cup_id, id DESC);

CREATE TABLE IF NOT EXISTS chat_profile (
  cup_id       text PRIMARY KEY,
  profile      text NOT NULL,
  distilled_at bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cup_traits (
  cup_id   text PRIMARY KEY,
  nickname text NOT NULL,
  traits   jsonb NOT NULL
);
