/**
 * @cup/server 公共出口 —— 供测试与其它包引用。
 */
export { createApp, type App, type AppOptions } from './app.ts';
export { Pipeline, type PipelineEvents } from './core/pipeline.ts';
export { CupFusion } from './core/fusion.ts';
export { Deduper, eventKey, type SeqKeyed } from './core/dedupe.ts';
export { CommandQueue, DEFAULT_DEVICE_TARGET } from './core/commands.ts';
export {
  computePersonality,
  warmthScore,
  refillHabit,
  warmthRemark,
  traitRecord,
  LOOKBACK_DAYS,
  type Disposition,
  type Personality,
  type TraitRecord,
} from './core/personality.ts';
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
export { setDayTimeZone, getDayTimeZone } from './core/day-boundary.ts';
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
export { FilePersistence, type PersistState, type ProfileRecord, atomicWriteJson } from './core/persist.ts';
export { JsonFile } from './core/persist-file.ts';
export {
  MemoryProfileStore,
  FileProfileStore,
  type ProfileStore,
} from './core/traits.ts';
export { MemoryAccountsStore, FileAccountsStore } from './core/social/accounts.ts';
// ── Postgres 存储层(第 2 阶段;pg 归窗口 B)──────────────────────
export { createPgPool, query, queryOne, withTransaction, type Pool } from './store/pg/pool.ts';
export { migrate, ensurePartitions, listPartitions, dropPartition } from './store/pg/migrate.ts';
export { PgStore } from './store/pg/store.ts';
export { PgChatStore } from './store/pg/chat.ts';
export { PgAccountsStore } from './store/pg/accounts.ts';
export { PgProfileStore } from './store/pg/profile.ts';
export { PgCupLlmStore } from './store/pg/cup-llm.ts';
export {
  register,
  login,
  logout,
  resolveSession,
  bearerToken,
  MIN_PASSWORD_LEN,
  type AuthDeps,
  type AuthResult,
  type RegisterInput,
} from './core/social/auth.ts';
export {
  hashPassword,
  verifyPassword,
  newSessionToken,
  SESSION_TTL_MS,
  type PasswordHash,
} from './core/social/crypto.ts';
export {
  normalizePack,
  makePack,
  PACK_THRESHOLD_KEYS,
  PACK_WAVE_KEYS,
  type PackDraft,
} from './core/social/packs.ts';
export { teamStreak, type TeamStreakResult } from './core/social/streak.ts';
export {
  ClaimService,
  normalizeClaim,
  hashClaim,
  claimHashEqual,
  resolveClaimPepper,
  CLAIM_ALPHABET,
  CLAIM_LEN,
  CLAIM_TTL_MS,
  CLAIM_MAX_FAILURES,
  CLAIM_LOCK_MS,
  type HelloFrame,
  type ClaimServiceOptions,
} from './core/social/claim.ts';
export {
  CupLlmService,
  MemoryCupLlmStore,
  FileCupLlmStore,
  cupLlmFilePath,
  encryptSecret,
  decryptSecret,
  resolveLlmEncKey,
  buildChatLlm,
  buildLlm,
  OpenAiChatLlm,
  toOpenAiMessages,
  toCupLlmPublic,
  isCupLlmProvider,
  DEFAULT_CHAT_URL,
  DEFAULT_CHAT_MODEL,
  type CupLlmConfig,
  type CupLlmPublic,
  type CupLlmProvider,
  type CupLlmStore,
  type CupLlmInput,
} from './core/cup-llm.ts';
export {
  normalizeEmail,
  friendPair,
  toPublicUser,
  toAdminUser,
  type Account,
  type AccountsStore,
  type AdminUser,
  type PublicUser,
  type PersonaPack,
  type Friendship,
  type Session,
  type Role,
  type PackStatus,
  type CupClaim,
} from './core/social/types.ts';
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
export {
  buildCardDetails,
  closeDayCard,
  maybeCloseDay,
  turnsSummary,
  MAX_NOTABLE_EVENTS,
  MAX_SUMMARY_CHARS,
} from './core/memory-cards.ts';
export type { DailyAgg, FusedSample, MemoryCard, MemoryCardDetails, TelemetryPoint } from './core/types.ts';
