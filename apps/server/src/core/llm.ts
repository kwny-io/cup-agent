/**
 * LLM 封装 —— provider 无关 + **降级到模板**(M4)。
 *
 * 立场(ADR T12):**LLM 是增益,不是依赖。**
 *   · 模板 + 真实数字是主路径(见 report.ts);LLM **只润色语气**
 *   · 数字一律来自 Report.facts,LLM **不许产生数字**
 *   · 出错 / 超时 / 输出里出现"对不上的数字" → 原样退回模板
 *
 * 为什么不用 SDK:一个 POST + 内置 fetch 就够(原则 P4)。换 provider 只需改
 * LlmConfig 里的 url/headers/body —— 甚至能换成"本地小模型"或"MockLlm"。
 */
import type { Report } from './report.ts';

export interface LlmRequest {
  system: string;
  prompt: string;
  /** 超时(ms),默认 6000 */
  timeoutMs?: number;
}

export interface Llm {
  readonly name: string;
  /** 返回补全文本;失败应抛错(由调用方降级) */
  complete(req: LlmRequest): Promise<string>;
}

/** 关掉 LLM 时的实现:永远抛错 → 调用方恒回退模板 */
export class NullLlm implements Llm {
  readonly name = 'null';
  async complete(): Promise<string> {
    throw new Error('LLM 未配置');
  }
}

export interface FetchLlmConfig {
  /** 完整端点,如 https://api.openai.com/v1/chat/completions */
  url: string;
  apiKey: string;
  model: string;
  /** 额外的请求头 */
  headers?: Record<string, string>;
  name?: string;
}

/**
 * 走 HTTP 的通用实现(OpenAI 兼容的 /chat/completions 形状)。
 * 用 Node 内置 fetch,不引 SDK。
 */
export class FetchLlm implements Llm {
  readonly name: string;
  private readonly cfg: FetchLlmConfig;
  constructor(cfg: FetchLlmConfig) {
    this.cfg = cfg;
    this.name = cfg.name ?? `fetch:${cfg.model}`;
  }

  async complete(req: LlmRequest): Promise<string> {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 6000);
    try {
      const res = await fetch(this.cfg.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.apiKey}`,
          ...this.cfg.headers,
        },
        body: JSON.stringify({
          model: this.cfg.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.prompt },
          ],
          temperature: 0.8,
          max_tokens: 200,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error('LLM 返回为空');
      return text;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** 出题给 LLM 的系统提示 —— 语气由 D1(傲娇宠物)定,但**只改语气,不许改数字** */
export const TONE_SYSTEM = [
  '你是一只傲娇的智能水杯的角色语气润色器。',
  '性格:嘴上嫌弃、其实在乎。台词要口语、俏皮、短短的。',
  '铁律:',
  '1. 只许改语气,不许改变、添加、编造任何数字(数字必须原样保留)。',
  '2. 只输出一句话,不要解释、不要引号、不要换行。',
  '3. 保持与原句相同的数字与事实。',
].join('\n');

/** 把模板战报交给 LLM 润色语气;任何问题都退回模板 */
export async function enrichReport(report: Report, llm: Llm | null): Promise<Report> {
  if (!llm) return report;
  try {
    const out = await llm.complete({
      system: TONE_SYSTEM,
      prompt:
        `今天的数字:已喝 ${report.facts.drank_ml}ml,目标 ${report.facts.goal_ml}ml,` +
        `喝了 ${report.facts.drink_count} 次,连续达标 ${report.facts.streak} 天。\n` +
        `当前杯子心情:${report.mood_line}。\n` +
        `把这句话润色得更傲娇俏皮(数字原样保留):「${report.headline}」`,
    });
    if (!safeTone(out, report)) return report;
    return { ...report, headline: out, source: 'llm' };
  } catch {
    // 超时 / 出错 / 网络不通 —— 静默退回模板,前端永远有东西
    return report;
  }
}

/**
 * 数字守卫:LLM 的输出若**丢掉了原句里的数字**,退回模板。
 *
 * 以**模板原句里出现的数字**为准 —— 它们必须全部还在。不检查"有没有多出数字"
 * (会误伤"第 1 天"这类无关数字),而漏掉数字是更严重的错误(验收 2:数字不能瞎编)。
 */
function safeTone(text: string, report: Report): boolean {
  if (text.length === 0 || text.length > 120) return false;
  if (/[\n\r]/.test(text)) return false; // 只要一句话
  const must = report.headline.match(/\d+/g) ?? [];
  const got = new Set(text.match(/\d+/g) ?? []);
  return must.every((n) => got.has(n));
}
