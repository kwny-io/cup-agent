-- ── 好友图 · 反向查询索引 ──────────────────────────────────────────────
-- 背景：`friends` 表存**规范边**(a<b 只存一份,见 0001),故 PK = (a_user_id, b_user_id)。
-- 但"取某人的好友"是双向的:`SELECT ... WHERE a_user_id = $1 OR b_user_id = $1`。
-- PK 的**前导列**只覆盖 `a_user_id = $1` 那半支;`b_user_id = $1` 半支无索引 → **全表扫**。
-- `deleteAccount` 里的 `DELETE ... WHERE a_user_id = $1 OR b_user_id = $1` 同理。
--
-- 好友图小的时候无所谓;到了万级/百万级,任意一个"排在后面"的用户(其 id 大于所有对端,
-- 于是他的每条好友边里他都落在 b 侧)每次查好友都扫全表。补一个 b 侧索引,让 OR 两支
-- 各走各的索引(BitmapOr)。**不改任何接口签名、不改查询语句** —— 纯索引补齐。
--
-- 为什么单列 (b_user_id) 而非组合 (b_user_id, a_user_id):查询只需按 b_user_id 定位行,
-- 命中的 a_user_id 直接从堆行读(`SELECT CASE WHEN a_user_id=$1 THEN b_user_id ELSE a_user_id END`),
-- 不做 index-only scan,故无需把 a_user_id 并进索引 —— 单列足够,组合反而白占空间。

CREATE INDEX IF NOT EXISTS friends_b_user ON friends (b_user_id);
