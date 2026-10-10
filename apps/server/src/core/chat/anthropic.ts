/**
 * 真实 Claude 的 tool use —— 手写 HTTP,**不引 SDK**。
 *
 * 为什么不用 SDK:与 03 文档刚立的「❌ LLM SDK」立场一致 —— 一个 POST + 内置
 * fetch 就够(P4)。SDK 会带进来整个依赖树,而我们只需要一个 `POST /v1/messages`
 * 与两个 JSON 形状的往返(见 FetchLlm:49-90 的同款手法)。
 *
 * 映射(Anthropic Messages 形状 ↔ 我们的 ChatModelTurn):
 *   · 出:ChatTurn[] → messages[];tool 轮 → 归并进 **前一条 user 消息** 的 tool_result 块
 *   · 入:content[] 块 → text 拼成一个字符串,tool_use 块 → ChatToolCall[]
 *
 * API key 只走 header(x-api-key),绝不进 URL / 日志。
 */
import type { ChatLlm, ChatLlmRequest, ChatModelTurn, ChatToolCall, ChatTurn, ToolSpec } from './types.ts';

export interface FetchChatLlmConfig {
  /** 完整端点,默认 https://api.anthropic.com/v1/messages */
  url?: string;
  apiKey: string;
  model: string;
  /** 额外请求头 */
  headers?: Record<string, string>;
  name?: string;
}

const DEFAULT_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 400;

// ── Anthropic 线上形状(只声明我们读到/写到的字段)───────────────

interface WireTextBlock {
  type: 'text';
  text: string;
}
interface WireToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
interface WireToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
type WireBlock = WireTextBlock | WireToolUseBlock | WireToolResultBlock;

interface WireMessage {
  role: 'user' | 'assistant';
  content: string | WireBlock[];
}

interface WireResponse {
  content?: WireBlock[];
  stop_reason?: string | null;
  error?: { message?: string };
}

function toWireTools(tools: ToolSpec[]): { name: string; description: string; input_schema: unknown }[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

/**
 * ChatTurn[] → Anthropic messages[]。
 *
 * 关键:Anthropic 要求**同一轮的多个 tool_result 合并进紧接着的一条 user 消息**,
 * 而不是每个 tool 一条消息。所以这里做一次"归并连续 tool 轮"。
 */
export function toWireMessages(turns: ChatTurn[]): WireMessage[] {
  const out: WireMessage[] = [];
  let i = 0;
  while (i < turns.length) {
    const t = turns[i]!;
    if (t.role === 'user') {
      out.push({ role: 'user', content: t.text });
      i++;
      continue;
    }
    if (t.role === 'assistant') {
      const blocks: WireBlock[] = [];
      if (t.text) blocks.push({ type: 'text', text: t.text });
      for (const c of t.toolCalls) {
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
      }
      out.push({ role: 'assistant', content: blocks });
      i++;
      continue;
    }
    // role === 'tool':把连续的一串 tool 轮并成一条 user 消息
    const results: WireBlock[] = [];
    while (i < turns.length && turns[i]!.role === 'tool') {
      const tr = turns[i] as Extract<ChatTurn, { role: 'tool' }>;
      results.push({
        type: 'tool_result',
        tool_use_id: tr.callId,
        content: JSON.stringify(tr.output ?? null),
        ...(tr.ok ? {} : { is_error: true }),
      });
      i++;
    }
    out.push({ role: 'user', content: results });
  }
  return out;
}

/** Anthropic content[] 块 → 我们的 ChatModelTurn */
export function fromWireResponse(res: WireResponse): ChatModelTurn {
  const blocks = res.content ?? [];
  const texts: string[] = [];
  const toolCalls: ChatToolCall[] = [];
  for (const b of blocks) {
    if (b.type === 'text') texts.push(b.text);
    else if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, input: b.input });
  }
  const text = texts.join('\n').trim();
  return {
    text: text.length ? text : null,
    toolCalls,
    stopReason: res.stop_reason ?? null,
  };
}

export class FetchChatLlm implements ChatLlm {
  readonly name: string;
  private readonly cfg: FetchChatLlmConfig;
  constructor(cfg: FetchChatLlmConfig) {
    this.cfg = cfg;
    this.name = cfg.name ?? `anthropic:${cfg.model}`;
  }

  async turn(req: ChatLlmRequest): Promise<ChatModelTurn> {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 15_000);
    try {
      const res = await fetch(this.cfg.url ?? DEFAULT_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.cfg.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          ...this.cfg.headers,
        },
        body: JSON.stringify({
          model: this.cfg.model,
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: req.system,
          tools: toWireTools(req.tools),
          messages: toWireMessages(req.turns),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`chat LLM HTTP ${res.status}`);
      const data = (await res.json()) as WireResponse;
      if (data.error?.message) throw new Error(`chat LLM: ${data.error.message}`);
      return fromWireResponse(data);
    } finally {
      clearTimeout(timeout);
    }
  }
}
