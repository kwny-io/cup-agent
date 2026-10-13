-- 0004_cup_llm: 每杯模型配置(BYOK)—— 用户给自己那只杯配模型 + 填自己的 API key。
--
-- 为什么 PK = cup_id 而不是 user_id:数据(chat_turns/memory_cards/cup_traits)全按 cup_id 存,
-- 模型配置同理"随杯走";一账号多杯时各配各的。
--
-- key_enc 是 **AES-256-GCM 密文**(iv.tag.cipher,hex),不是明文、也不是哈希 —— 因为要能解出来
-- 去调 LLM(与 cup_claims.claim_hash 的 HMAC 立场不同)。解密密钥见 core/cup-llm.ts 的
-- resolveLlmEncKey(env CUP_LLM_ENC_KEY / dataDir 派生)。
--
-- base_url 可空:空 = 按 provider 取默认端点;给了 = 接 OpenAI 兼容的本地小模型 / 代理。
-- provider 收任意串(校验在 core/cup-llm.ts 的 isCupLlmProvider,DB 不设 CHECK 便于日后扩源)。

CREATE TABLE IF NOT EXISTS cup_llm (
  cup_id      TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  base_url    TEXT,
  key_enc     TEXT NOT NULL,
  updated_at  BIGINT NOT NULL
);
