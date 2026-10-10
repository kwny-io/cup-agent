/**
 * 对话 LLM 的桩实现 —— 测试与"未配置"两条路的落点。
 *
 * 与 `personality.test.ts` 里的 `GoodLlm`/`BrokenLlm` 同款:让循环的测试
 * 完全确定 —— 脚本给什么,模型就回什么,不联网、不随机(见 ADR T12 的立场)。
 *
 * `callTool` 是手写脚本时最常用的糖:造一个"只调一个工具"的模型轮。
 */
import type { ChatLlm, ChatLlmRequest, ChatModelTurn, ChatToolCall } from './types.ts';

/** 造一个"调一次工具"的模型轮(脚本常用) */
export function callTool(name: string, input: unknown, id = `call-${name}`): ChatModelTurn {
  const call: ChatToolCall = { id, name, input };
  return { text: null, toolCalls: [call], stopReason: 'tool_use' };
}

/** 造一个"直接说一句话"的模型轮 */
export function say(text: string): ChatModelTurn {
  return { text, toolCalls: [], stopReason: 'end_turn' };
}

/**
 * 脚本化模型:按序吐出预置的轮次。
 * 脚本用尽再被调用 → 抛错(循环会捕获并走确定性回退,正好覆盖那条路径)。
 */
export class MockChatLlm implements ChatLlm {
  readonly name = 'mock';
  private script: ChatModelTurn[];
  private i = 0;

  constructor(script: ChatModelTurn[]) {
    this.script = script;
  }

  async turn(_req: ChatLlmRequest): Promise<ChatModelTurn> {
    const t = this.script[this.i++];
    if (!t) throw new Error('script exhausted');
    return t;
  }
}

/** 未配置真实模型时的落点:一调就抛 → 循环回退到确定性模板句 */
export class NullChatLlm implements ChatLlm {
  readonly name = 'null';
  async turn(_req: ChatLlmRequest): Promise<ChatModelTurn> {
    throw new Error('未配置对话模型(CUP_CHAT_URL 为空)');
  }
}
