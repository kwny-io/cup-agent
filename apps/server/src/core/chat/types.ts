/**
 * 对话 agent 的类型骨架 —— 与 M4 的语气 LLM(llm.ts 的 `Llm`)分开的一层。
 *
 * 为什么不复用 `Llm`:`Llm.complete(req): Promise<string>` 结构上**装不下**
 * `tool_use` 块(要工具调用 + 多轮)。硬扩会让战报路径长出它并不想要的工具感知。
 * 所以这里另起一个 `ChatLlm`,只管"一轮对话模型回复"。
 *
 * 关键设计:**循环与模型无状态** —— 每轮把完整 `ChatTurn[]` 交回模型。
 * 这正是 `MockChatLlm` 能当纯脚本用、整套循环可确定性测试的原因。
 *
 * strip-only 约束:无 enum、无参数属性,全部显式字段。
 */
import type { LogLevel } from '../logger.ts';

/** 给模型看的工具说明(转成各家 API 的 tools 形状) */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema 形状 */
  inputSchema: Record<string, unknown>;
}

/** 模型发起的一次工具调用。`input` 是**不可信输入**,调用方必须校验 */
export interface ChatToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** 模型的一轮回复:要么有文本、要么有工具调用(或两者) */
export interface ChatModelTurn {
  text: string | null;
  toolCalls: ChatToolCall[];
  /** 原生 stop_reason(如 'tool_use' / 'end_turn'),仅诊断用 */
  stopReason?: string | null;
}

/** 对话历史里的一轮 —— 交给模型时序列化成各家格式 */
export type ChatTurn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ChatToolCall[] }
  | { role: 'tool'; callId: string; name: string; output: unknown; ok: boolean };

export interface ChatLlmRequest {
  system: string;
  turns: ChatTurn[];
  tools: ToolSpec[];
  timeoutMs?: number;
  maxTokens?: number;
}

/** 对话模型接口 —— Null* 恒抛错 → 调用方回退确定性答复(见 ADR T12 立场) */
export interface ChatLlm {
  readonly name: string;
  turn(req: ChatLlmRequest): Promise<ChatModelTurn>;
}

/**
 * 一次问答的产出。
 *   · text   最终给用户的话
 *   · source 'llm' = 模型说的(且过了数字守卫);'fallback' = 库里拼的确定性答复
 *   · tools_used 这次碰过哪些工具(诊断 / 前端可展示)
 *   · turns  循环跑了几轮
 */
export interface ChatAnswer {
  text: string;
  source: 'llm' | 'fallback';
  tools_used: string[];
  turns: number;
}

export type LogFn = (msg: string, level?: LogLevel) => void;
