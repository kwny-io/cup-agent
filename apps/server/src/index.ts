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
  type DeleteScope,
  type ForgetCounts,
} from './store/store.ts';
export { setDayTimeZone, getDayTimeZone } from './core/day-boundary.ts';
export {
  createLogger,
  parseLogLevel,
  parseLogFormat,
  LOG_LEVELS,
  consoleSink,
  type Logger,
  type LoggerOptions,
  type LogFields,
  type LogLevel,
  type LogEntry,
  type Redactor,
} from './core/logger.ts';
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
export {
  migrate,
  ensurePartitions,
  listPartitions,
  dropPartition,
  applyRetention,
  partitionsToDrop,
  retainDaysFromEnv,
  DEFAULT_TELEMETRY_RETAIN_DAYS,
  DEFAULT_EVENTS_RETAIN_DAYS,
  DEFAULT_SERVER_LOGS_RETAIN_DAYS,
  type RetentionOptions,
} from './store/pg/migrate.ts';
export { PgStore } from './store/pg/store.ts';
export { PgChatStore } from './store/pg/chat.ts';
export { PgAccountsStore } from './store/pg/accounts.ts';
export { PgProfileStore } from './store/pg/profile.ts';
export { PgCupLlmStore } from './store/pg/cup-llm.ts';
export { PgServerLogStore } from './store/pg/server-logs.ts';
// ── 服务日志端(结构化日志落库/落文件 + 管理页读写口)──────────────
export { MemoryServerLogStore, type MemoryServerLogOptions } from './store/memory-server-logs.ts';
export {
  LOG_PAGE_DEFAULT,
  LOG_PAGE_MAX,
  makeLogCursor,
  parseLogCursor,
  type LogRow,
  type LogQuery,
  type LogPage,
  type ServerLogStore,
} from './core/log-store.ts';
export {
  createLogPipeline,
  composeSinks,
  parseLogLine,
  LOG_FLUSH_INTERVAL_MS,
  LOG_MAX_BUFFER,
  LOG_MAX_BATCH,
  LOG_MAX_FILE_BYTES,
  type LogSinkHandle,
  type LogPipelineOptions,
  type FileSink,
} from './core/log-pipeline.ts';
export { redactFields, maskEmail, SENSITIVE_KEYS, REDACTED } from './core/redact.ts';
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
export {
  deriveGrowth,
  statsOf,
  stageFor,
  nextStageFor,
  STAGES,
  type Growth,
  type GrowthStats,
  type GrowthStage,
  type Milestone,
  type MilestoneKind,
} from './core/growth.ts';
export {
  makeGrowthNotifier,
  type GrowthNotifyStore,
  type GrowthNotifyDeps,
} from './core/growth-notify.ts';
export {
  decideSpeak,
  ignoredStreak,
  cooldownMsFor,
  type TimingInput,
  type TimingDecision,
  type TimingTurn,
  BASE_COOLDOWN_MS,
  BACKOFF_PER_IGNORE_MS,
  MAX_COOLDOWN_MS,
  ENGAGE_WINDOW_MS,
  USER_NOTCH_MS,
  JUST_DRANK_QUIET_MS,
} from './core/proactive-timing.ts';
