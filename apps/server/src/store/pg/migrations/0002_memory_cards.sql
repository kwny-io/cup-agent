-- ── 记忆卡（第 3 阶段）────────────────────────────────────────────
-- "每天的点滴"沉淀成一张卡：agent 可按需 recall 喂回自己，用户可三档删除（第 4 阶段）。
--
-- 为什么独立一张表而非塞进 daily_agg：daily_agg 是**数值 rollup**（drink/sample 驱动、热路径写）；
-- 记忆卡是**天翻页时一次性封存的叙事快照**（含事件、身体线索、当天对话蒸馏），
-- 写入时机与频率都不同。分开才不把"每天一次的封存"绑死在热路径上。
--
-- details 用 jsonb 存**整个 CardDetails 对象** —— 卡的字段将来会长（今天已有
-- notable_events / body_cues / turns_summary），jsonb 让加字段不必改表、也不会静默丢。
-- 单独列只放**主键 + 元数据**（供 upsert 与排序）。

CREATE TABLE IF NOT EXISTS memory_cards (
  cup_id   text   NOT NULL,
  -- 本地日 'YYYY-MM-DD'（与 daily_agg.date 同口径，dayKey() 产出）
  date     text   NOT NULL,
  -- MemoryCardDetails 整体（drank_ml/goal_ml/reached/streak/refill_count/temp_range/
  -- notable_events/body_cues/turns_summary/turn_count）
  details  jsonb  NOT NULL,
  -- 封存时刻（ms）
  built_at bigint NOT NULL,
  PRIMARY KEY (cup_id, date)
);
