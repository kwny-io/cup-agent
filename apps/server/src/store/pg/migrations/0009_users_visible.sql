-- ── users · 好友可见性开关(P4.4 隐私)─────────────────────────────────
-- 背景:`friendView`(http.ts)对绑了杯的好友无条件露 traits + streak。P4.4 补一个**账号级**开关,
-- 关掉后好友只看得到昵称(G6 缺口;比"解绑杯子"更细 —— 不必为隐身牺牲绑杯功能)。
--
-- `NOT NULL DEFAULT true`(设计稿 Q8:默认可见 —— 有量之前默认可见才有社交)。存量行自动 = true,
-- 语义与 `Account.visible` 缺省一致(`undefined` = 可见)。
--
-- 为什么独立列而非塞进 cup_settings:visible 是**账号级**、cup_settings 是**杯级**(且 deleteAccount
-- 不连带清 cup_settings);且它随用户注销整行删掉,与 users 同生命周期 —— 该在 users 上。
--
-- 不动接口签名、不改既有行:纯加列。`toAccount` 只在 `visible = false` 时出口该字段(缺省 = 可见)。

ALTER TABLE users ADD COLUMN IF NOT EXISTS visible boolean NOT NULL DEFAULT true;
