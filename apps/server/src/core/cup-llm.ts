/**
 * 每杯模型配置(BYOK:Bring Your Own Key)—— 用户登录后给自己那只杯**配模型 + 填自己的 key**。
 *
 * ── 为什么挂在"杯"上而不是"账号"上 ──────────────────────────────
 * 本项目数据(chat_turns / memory_cards / cup_traits / telemetry)全按 `cup_id` 存,
 * 天然"数据随杯走";模型配置同理按 `cup_id` —— 一个账号换杯、或一账号多杯,各自带各的模型。
 *
 * ── key 怎么存:密文,不是哈希 ───────────────────────────────────
 * 与 `claim_hash`(HMAC,**不可逆**、只用来比对)不同 —— 这里的 key 必须能**解出明文**去调 LLM,
 * 故用**可逆加密 AES-256-GCM**,密钥从 env `CUP_LLM_ENC_KEY`(base64)/ dataDir 派生(手法同
 * `resolveClaimPepper`)。**明文 key 绝不落盘、绝不回显**;出口视图只给 `has_key: true/false`。
 *
 *   ⚠️ 信任边界:服务端**能**解出用户 key。这是"体验好(不用每次用户在线)"的代价;
 *   要"零知识"就得走**用户 token 透传**(不落库),但那样每次对话都得用户在线。当前取前者。
 *
 * strip-only 约束:无 enum、无参数属性,全显式字段。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatLlm, ChatModelTurn, ChatToolCall, ChatTurn, ToolSpec } from './chat/types.ts';
import { FetchChatLlm } from './chat/anthropic.ts';
import { FetchLlm, type Llm } from './llm.ts';
import { atomicWriteJson } from './persist.ts';

// ── 类型 ─────────────────────────────────────────────────────────

export type CupLlmProvider = 'anthropic' | 'openai';

/** **存储形**(含密文 key)—— 只在 server 内部流转,绝不直接回给 HTTP */
export interface CupLlmConfig {
  cup_id: string;
  provider: CupLlmProvider;
  model: string;
  /** 覆盖端点;缺省按 provider 取默认(便于接 OpenAI 兼容的本地小模型 / 代理) */
  base_url?: string;
  /** 密文 key(见 encryptSecret);**永不回显** */
  key_enc: string;
  updated_at: number;
}

/** **出口视图**(给 HTTP / 前端)—— 绝不含 key(明文或密文) */
export interface CupLlmPublic {
  cup_id: string;
  provider: CupLlmProvider;
  model: string;
  base_url?: string;
  /** 是否配过 key(前端据此显示"已接入 / 未接入") */
  has_key: boolean;
  updated_at: number;
}

export function toCupLlmPublic(c: CupLlmConfig): CupLlmPublic {
  const p: CupLlmPublic = {
    cup_id: c.cup_id,
    provider: c.provider,
    model: c.model,
    has_key: c.key_enc.length > 0,
    updated_at: c.updated_at,
  };
  if (c.base_url) p.base_url = c.base_url;
  return p;
}

/** provider 默认端点(agent 用的对话端点) */
export const DEFAULT_CHAT_URL: Record<CupLlmProvider, string> = {
  anthropic: 'https://api.anthropic.com/v1/messages',
  openai: 'https://api.openai.com/v1/chat/completions',
};

/** provider 默认对话模型(用户没填时) */
export const DEFAULT_CHAT_MODEL: Record<CupLlmProvider, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o-mini',
};

export function isCupLlmProvider(x: unknown): x is CupLlmProvider {
  return x === 'anthropic' || x === 'openai';
}

// ── 存储口(接口 + 内存/文件两实现)─────────────────────────────

export interface CupLlmStore {
  get(cupId: string): Promise<CupLlmConfig | null>;
  set(cupId: string, cfg: CupLlmConfig): Promise<void>;
  /** 删除该杯配置(用户"取消接入");无行 → no-op */
  delete(cupId: string): Promise<void>;
  flush(): Promise<void>;
}

export class MemoryCupLlmStore implements CupLlmStore {
  private map = new Map<string, CupLlmConfig>();

  async get(cupId: string): Promise<CupLlmConfig | null> {
    return this.map.get(cupId) ?? null;
  }
  async set(cupId: string, cfg: CupLlmConfig): Promise<void> {
    this.map.set(cupId, cfg);
  }
  async delete(cupId: string): Promise<void> {
    this.map.delete(cupId);
  }
  async flush(): Promise<void> {
    // 内存实现无持久,no-op
  }
}

/**
 * 文件实现:cups 配置整体落 `cup-llm.json`(独立文件,与 state.json / social.json 同套原子写)。
 * 密文 key 就在这个文件里 —— 故该文件**含敏感数据**,别提交、别外传。
 */
export class FileCupLlmStore implements CupLlmStore {
  private readonly path: string;
  private readonly map: Map<string, CupLlmConfig>;

  constructor(path: string) {
    this.path = path;
    this.map = new Map();
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { cups?: Record<string, CupLlmConfig> };
      for (const [k, v] of Object.entries(raw.cups ?? {})) this.map.set(k, v);
    } catch {
      // 文件不存在 / 损坏 → 空起(不该让服务起不来)
    }
  }

  async get(cupId: string): Promise<CupLlmConfig | null> {
    return this.map.get(cupId) ?? null;
  }
  async set(cupId: string, cfg: CupLlmConfig): Promise<void> {
    this.map.set(cupId, cfg);
    this.save();
  }
  async delete(cupId: string): Promise<void> {
    if (this.map.delete(cupId)) this.save();
  }
  async flush(): Promise<void> {
    this.save();
  }
  private save(): void {
    atomicWriteJson(this.path, { cups: Object.fromEntries(this.map) });
  }
}

/** 文件实现的默认落点:`<dataDir>/cup-llm.json` */
export function cupLlmFilePath(dataDir: string): string {
  return join(dataDir, 'cup-llm.json');
}

// ── 加解密(AES-256-GCM;可逆,与 claim 的 HMAC 立场不同)──────────

const ENC_ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // GCM 推荐 96 bit

/** 加密:输出 `iv.tag.cipher`(各段 hex),单串便于落库 */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ENC_ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}.${tag.toString('hex')}.${enc.toString('hex')}`;
}

/** 解密:失败(篡改 / 换过密钥)→ null,由调用方按"没配"处理,不让请求炸 */
export function decryptSecret(blob: string, key: Buffer): string | null {
  const parts = blob.split('.');
  if (parts.length !== 3) return null;
  try {
    const iv = Buffer.from(parts[0]!, 'hex');
    const tag = Buffer.from(parts[1]!, 'hex');
    const data = Buffer.from(parts[2]!, 'hex');
    const decipher = createDecipheriv(ENC_ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * 解析服务端加密密钥:env `CUP_LLM_ENC_KEY`(base64,32 字节)优先;
 * 否则 dataDir 下落盘 `<dataDir>/llm-enc-key`;否则进程内一次性(重启即换 → 旧密文解不开,
 * 与"内存模式配置本就不跨重启"一致)。手法与 `resolveClaimPepper` 同款。
 */
export function resolveLlmEncKey(dataDir?: string): Buffer {
  const fromEnv = process.env.CUP_LLM_ENC_KEY;
  if (fromEnv) {
    const b = Buffer.from(fromEnv, 'base64');
    if (b.length === 32) return b;
  }
  if (!dataDir) return randomBytes(32);
  const path = join(dataDir, 'llm-enc-key');
  try {
    return readFileSync(path);
  } catch {
    const fresh = randomBytes(32);
    try {
      writeFileSync(path, fresh, { mode: 0o600 });
    } catch {
      /* 落盘失败 → 仍用本次的 fresh(不该让服务起不来) */
    }
    return fresh;
  }
}

// ── 工厂:配置 + 明文 key → ChatLlm / Llm ────────────────────────

/**
 * 该杯的配置 → 现造一个 `ChatLlm`。缺配置 / 解不出 key → null(调用方回退全局默认或模板句)。
 * `key` 是解密后的明文;**只在内存里活这一程**。
 */
export function buildChatLlm(cfg: CupLlmConfig, key: string): ChatLlm {
  const url = cfg.base_url ?? DEFAULT_CHAT_URL[cfg.provider];
  if (cfg.provider === 'anthropic') {
    return new FetchChatLlm({ apiKey: key, model: cfg.model, url });
  }
  return new OpenAiChatLlm({ apiKey: key, model: cfg.model, url });
}

/** 战报语气 LLM 的同款工厂(OpenAI 兼容形状;anthropic 走 messages 会不同,故只支持 openai 形状) */
export function buildLlm(cfg: CupLlmConfig, key: string): Llm {
  const url = cfg.base_url ?? DEFAULT_CHAT_URL[cfg.provider];
  return new FetchLlm({ url, apiKey: key, model: cfg.model, name: `${cfg.provider}:${cfg.model}` });
}

// ── OpenAI 兼容对话适配器(带 tool_calls;与 anthropic.ts 对称)────

interface OpenAiConfig {
  url: string;
  apiKey: string;
  model: string;
  headers?: Record<string, string>;
  name?: string;
}

interface OpenAiToolCallWire {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

/**
 * OpenAI 兼容的 `/chat/completions`(含 function calling)。
 * 为什么不复用 `FetchLlm`:那个只做"一次补全"、装不下多轮 tool_calls(同 anthropic.ts 的理由)。
 */
export class OpenAiChatLlm implements ChatLlm {
  readonly name: string;
  private readonly cfg: OpenAiConfig;

  constructor(cfg: OpenAiConfig) {
    this.cfg = cfg;
    this.name = cfg.name ?? `openai:${cfg.model}`;
  }

  async turn(req: {
    system: string;
    turns: ChatTurn[];
    tools: ToolSpec[];
    timeoutMs?: number;
    maxTokens?: number;
  }): Promise<ChatModelTurn> {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 15_000);
    try {
      const messages: unknown[] = [{ role: 'system', content: req.system }];
      for (const m of toOpenAiMessages(req.turns)) messages.push(m);
      const body: Record<string, unknown> = {
        model: this.cfg.model,
        messages,
        max_tokens: req.maxTokens ?? 400,
      };
      if (req.tools.length) {
        body.tools = req.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        }));
      }
      const res = await fetch(this.cfg.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.apiKey}`,
          ...this.cfg.headers,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`chat LLM HTTP ${res.status}`);
      const data = (await res.json()) as {
        choices?: { message?: { content?: string | null; tool_calls?: OpenAiToolCallWire[] }; finish_reason?: string }[];
        error?: { message?: string };
      };
      if (data.error?.message) throw new Error(`chat LLM: ${data.error.message}`);
      const choice = data.choices?.[0];
      const text = (choice?.message?.content ?? '').trim();
      const toolCalls: ChatToolCall[] = (choice?.message?.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        input: safeJson(tc.function.arguments),
      }));
      return {
        text: text.length ? text : null,
        toolCalls,
        stopReason: choice?.finish_reason ?? null,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** ChatTurn[] → OpenAI messages[](assistant.tool_calls / role:'tool' 的 tool_call_id 形状) */
export function toOpenAiMessages(turns: ChatTurn[]): unknown[] {
  const out: unknown[] = [];
  for (const t of turns) {
    if (t.role === 'user') {
      out.push({ role: 'user', content: t.text });
    } else if (t.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: t.text ?? null,
        ...(t.toolCalls.length
          ? {
              tool_calls: t.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      });
    } else {
      // role === 'tool':OpenAI 每一条 tool 结果单列一条消息(不像 Anthropic 要归并)
      out.push({
        role: 'tool',
        tool_call_id: t.callId,
        content: JSON.stringify(t.output ?? null),
      });
    }
  }
  return out;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ── 服务:把加解密收在一处,HTTP 层不碰 crypto ────────────────────

/** `set` 的入参:key 可省 —— 省 = 沿用已有密文(只改模型/端点时不逼用户重填 key) */
export interface CupLlmInput {
  provider: CupLlmProvider;
  model: string;
  base_url?: string;
  /** 明文 key;省或空串且已有配置 → 沿用旧 key_enc */
  key?: string;
}

/**
 * 每杯模型配置的门面:`CupLlmStore`(存)+ 加密密钥(解/密)。
 * 出口永远是 `CupLlmPublic`(无 key);`chatLlm()` 才在内存里短暂解出明文。
 */
export class CupLlmService {
  private readonly store: CupLlmStore;
  private readonly key: Buffer;

  constructor(opts: { store: CupLlmStore; key: Buffer }) {
    this.store = opts.store;
    this.key = opts.key;
  }

  async get(cupId: string): Promise<CupLlmPublic | null> {
    const c = await this.store.get(cupId);
    return c ? toCupLlmPublic(c) : null;
  }

  async set(cupId: string, input: CupLlmInput): Promise<CupLlmPublic> {
    const prev = await this.store.get(cupId);
    const plain = (input.key ?? '').trim();
    const keyEnc = plain ? encryptSecret(plain, this.key) : (prev?.key_enc ?? '');
    const cfg: CupLlmConfig = {
      cup_id: cupId,
      provider: input.provider,
      model: input.model,
      key_enc: keyEnc,
      updated_at: Date.now(),
    };
    if (input.base_url) cfg.base_url = input.base_url;
    await this.store.set(cupId, cfg);
    return toCupLlmPublic(cfg);
  }

  async clear(cupId: string): Promise<void> {
    await this.store.delete(cupId);
  }

  /** 现造该杯的 `ChatLlm`;无配置 / key 解不开 → null(调用方回退全局默认或模板句) */
  async chatLlm(cupId: string): Promise<ChatLlm | null> {
    const c = await this.store.get(cupId);
    if (!c || c.key_enc.length === 0) return null;
    const key = decryptSecret(c.key_enc, this.key);
    if (!key) return null;
    return buildChatLlm(c, key);
  }

  async flush(): Promise<void> {
    await this.store.flush();
  }
}

