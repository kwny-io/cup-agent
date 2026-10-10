/**
 * @cup/server 公共出口 —— 供测试与其它包引用。
 */
export { createApp, type App, type AppOptions } from './app.ts';
export { Pipeline, type PipelineEvents } from './core/pipeline.ts';
export { CupFusion } from './core/fusion.ts';
export { Deduper, eventKey, type SeqKeyed } from './core/dedupe.ts';
export { CommandQueue, DEFAULT_DEVICE_TARGET } from './core/commands.ts';
export { computePersonality, type Disposition, type Personality } from './core/personality.ts';
export {
  generateReport,
  templateHeadline,
  factsFrom,
  historyFacts,
  historyHeadline,
  dispositionTimeline,
  type DispositionDay,
  type Report,
  type ReportFacts,
} from './core/report.ts';
export { enrichReport, FetchLlm, NullLlm, type Llm, type LlmRequest } from './core/llm.ts';
export {
  MemoryStore,
  dayKey,
  dayStart,
  shiftDay,
  DEFAULT_GOAL_ML,
  type MemoryStoreOptions,
  type Store,
} from './store/store.ts';
export {
  runChat,
  dispatch,
  MAX_TURNS,
  type ChatDeps,
  type ChatRequest,
} from './core/chat/agent.ts';
export { toolSpecs, getTool, type ToolDef, type ToolCtx, type ToolResult } from './core/chat/tools.ts';
export { grounded, numbersIn, collectNumbers, type Grounding } from './core/chat/guard.ts';
export {
  MemoryChatStore,
  MAX_TURNS_PER_CUP,
  MAX_PROFILE_CHARS,
  capTurns,
  windowTurns,
  type ChatStore,
  type ChatTurnRecord,
} from './core/chat/memory.ts';
export { FileChatStore } from './core/chat/file-memory.ts';
export {
  distillProfile,
  distillDue,
  acceptProfile,
  templateProfile,
  transcript,
  DEFAULT_MIN_NEW_TURNS,
  type DistillDeps,
  type DistillRequest,
  type DistillResult,
} from './core/chat/distill.ts';
export { FilePersistence, type PersistState } from './core/persist.ts';
export { MockChatLlm, NullChatLlm, callTool, say } from './core/chat/mock.ts';
export {
  FetchChatLlm,
  toWireMessages,
  fromWireResponse,
  type FetchChatLlmConfig,
} from './core/chat/anthropic.ts';
export { CHAT_SYSTEM, PROACTIVE_PROMPT, BODY_PROMPT_INTRO, PROFILE_DISTILL_SYSTEM } from './core/chat/prompt.ts';
export {
  ABANDON_HOURS,
  bodyCueFromEvents,
  abandonedCue,
  bodyPrompt,
  type BodyCue,
  type BodyCueHit,
} from './core/chat/body.ts';
export type {
  ChatAnswer,
  ChatLlm,
  ChatLlmRequest,
  ChatModelTurn,
  ChatToolCall,
  ChatTurn,
  LogFn,
  ToolSpec,
} from './core/chat/types.ts';
export { ProactiveScheduler, type ProactiveDeps } from './core/proactive.ts';
export { LiveHub, type LiveFrame } from './api/live.ts';
export { createApiServer, type ApiDeps } from './api/http.ts';
export { startSimAdapter, type SimAdapterHandle, type SimAdapterOptions } from './ingest/sim-adapter.ts';
export {
  startMqttAdapter,
  UPLINK_TOPIC,
  downTopic,
  parseUplinkTopic,
  type MqttAdapterHandle,
  type MqttAdapterOptions,
} from './ingest/mqtt-adapter.ts';
export { createNodeMqttTransport, type NodeMqttTransportOptions } from './ingest/mqtt-node-transport.ts';
export type { MqttTransport, MqttTransportMessage } from './ingest/mqtt-transport.ts';
export type { DailyAgg, FusedSample, TelemetryPoint } from './core/types.ts';
