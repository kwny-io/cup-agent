-- 0007：每杯"当前生效的人格包" —— `cup_id → pack_id`（一只杯穿一件）。
--
-- ── 为什么**独立表**而不复用 cup_settings ─────────────────────────
-- 设计稿 Q5 曾"倾向复用 cup_settings(少一张表)",核代码后改判独立表,三条理由：
--
--   1. 复用会踩 `forget`。`forget(scope='all')` 删 `cup_settings` 是**整行**删
--      (DELETE FROM cup_settings WHERE cup_id=$1) —— 目标列塞进去,「清空全部」会
--      **顺手把生效包也卸掉**,一条静默丢配置的耦合。独立表则删除域彼此干净。
--   2. 列名撒谎。`cup_settings.goal_ml` 是**设备**目标(走 PUT /goal + x-api-key,设备也读),
--      `active_pack_id` 是**账号**选择(走会话 + 归属)。同一行混两种鉴权域,后面谁也说不清。
--   3. 成本极低:一张两列表,照 setGoal / cup_llm 的 upsert 样板即可。
--
-- ── 语义边界（别与 subscriptions 混）───────────────────────────────
-- `subscriptions` 是 per-USER(「我订了 5 个包」);本表是 per-CUP(「我这只杯穿着哪件」)。
-- 「订了」≠「穿着」。PUT 只落本表一行,**不写回 subscriptions**(那是另一条关系)。
--
-- 无外键:与 subscriptions/friends 同款(见 0001 注释),杯子态表不挂 users 外键;
-- 账号注销时若要清,由调用方显式删(见 accounts.deleteAccount 的手法)。
CREATE TABLE IF NOT EXISTS cup_active_pack (
  cup_id  text PRIMARY KEY,
  pack_id text NOT NULL
);
