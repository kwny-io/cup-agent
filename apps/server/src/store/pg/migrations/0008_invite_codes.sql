-- 0008：分享卡「邀请码 → 归属边」—— D4 单边裂变的最小地基（设计稿 §3.3）。
--
-- ── 为什么独立表、独立码表,不复用 claim ──────────────────────────────
-- `claim` 与 `invite` 是**两个不同目的**(设计稿 Q6 已拍「不共用」):
--   · claim code:设备**可信绑定**用 —— 单向哈希、**不透明**(明文码只给设备,服务端只存 HMAC)。
--   · invite code:分享**拉新**用 —— 必须**可读、可粘贴、可解析**(印在卡上、拼进 URL)。
-- 目的不同 → 形状不同(哈希 vs 明文短码)→ 共用一套只会两头拧巴,故各立一张表。
--
-- ── 为什么两张表(code 与 join 分开)───────────────────────────────
--   · `invite_codes`:一个邀请人**可以有多枚码**(每次分享生成一枚 → 可追踪"哪次分享带来的"),
--     故 PK = code,`inviter_user_id` 是普通列(非唯一)。
--   · `invite_joins`:被邀请人**一生只算一次归因**(首触归因,防重复注册刷转化率),故 PK = invitee_user_id。
--     `code` 保留是审计用(哪枚码带来的),也便于"这枚码带来了谁"。
--
-- ── 隐私(设计稿 §3.3「可查可删」)──────────────────────────────────
-- 归属边是**敏感**的:被邀请人不知情地被标记"谁邀请的"。故本表只存关系,出口层须明示;
-- 账号注销时由 `deleteAccount` 连带清(inviter 与 invitee 两侧都要清,否则悬垂)。
--
-- 无外键:与 subscriptions/friends/cup_active_pack 同款(见 0001 注释),社交域不挂 users 外键,
-- 清理由调用方显式做。
CREATE TABLE IF NOT EXISTS invite_codes (
  code            text PRIMARY KEY,
  inviter_user_id text NOT NULL,
  created_at      bigint NOT NULL
);
-- 「我发过哪些码」(inviter 侧)按邀请人查 —— 无索引时全表扫。
CREATE INDEX IF NOT EXISTS invite_codes_inviter ON invite_codes (inviter_user_id);

CREATE TABLE IF NOT EXISTS invite_joins (
  invitee_user_id text PRIMARY KEY,
  code            text NOT NULL,
  inviter_user_id text NOT NULL,
  joined_at       bigint NOT NULL
);
-- 转化率分子 = `SELECT count(*) WHERE inviter_user_id=$1` → 建索引。
CREATE INDEX IF NOT EXISTS invite_joins_inviter ON invite_joins (inviter_user_id);
