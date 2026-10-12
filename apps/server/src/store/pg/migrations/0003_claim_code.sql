-- ── 可信绑定 · 设备一次性 claim code（第 4 阶段的硬前置，风险 R18）──────────
-- 背景：`POST /social/cup` 原来只校验 cup_id 形状、不验调用者是否真拥有该杯 ——
-- 任何登录账号传任意 cup_id 就绑上了。若拿它当破坏性删除（scope=all / 账号级）的闸，
-- 等于没闸：A 可绑走 B 的杯再删掉 B 的数据。补法是要求绑定方出示**只可能来自真设备**
-- 的一枚码：设备上线时在 MQTT hello 帧里报码，服务端记哈希；用户从串口/App 抄下码，
-- 绑定时一并提交。
--
-- 为什么 PK 是 device_id 而**不是** cup_id —— 本项目是**双形体**：一只杯一个灵魂两具
-- 身体（杯盖 + 底座），二者**共用同一个 cup_id、device_id 不同**（见 base/sdkconfig.defaults
-- 只覆盖 device_id 前缀）。两具身体都会在 hello 里报各自那枚码；若 cup_id 作 PK，
-- 后配网的那具会**覆盖**另一具那行，被覆盖的码永久报废、绑定随机失败 —— 是设计内常态，
-- 不是边缘 case。故按 device_id 分行；绑定查表按 cup_id 命中**任一行**即可（盖抄或底座
-- 抄都能绑同一物理套装，安全上无碍）。
--
-- claim_hash 只存哈希（服务端 pepper 的 HMAC-SHA256），**明文绝不落盘、绝不出响应**。
-- expires_at 由**服务端 now() + 24h** 算出 —— 不信设备自报的 issued_at（hello 是未认证
-- 通道，伪造到未来 = 永生码）；issued_at 仅留审计/展示。
--
-- 兜底（服务端 hello 分支落实）：该 device 已有 `used_at IS NULL` 的未用码时**忽略**
-- 后续 hello（不覆盖哈希）；只有已用/已过期才接受新码。防"知道 cup_id 就灌 hello 覆盖
-- 待绑码"的拒绝服务。

CREATE TABLE IF NOT EXISTS cup_claims (
  device_id   text   PRIMARY KEY,
  -- 该设备所属逻辑杯（盖/底座同值）；绑定按它查
  cup_id      text   NOT NULL,
  -- HMAC-SHA256(claim, server_pepper) 的十六进制；明文不落库
  claim_hash  text   NOT NULL,
  -- 设备自报签发时刻（ms）—— 仅审计/展示，**不参与判定**
  issued_at   bigint NOT NULL,
  -- 服务端 now + 24h 算出的失效时刻（ms）
  expires_at  bigint NOT NULL,
  -- 一次性：绑定成功即置位（ms）；已用不再接受
  used_at     bigint
);

-- 绑定查表：按 cup_id 找未用且未过期的码（命中任一行即候选）。
CREATE INDEX IF NOT EXISTS cup_claims_cup_active
  ON cup_claims (cup_id)
  WHERE used_at IS NULL;
