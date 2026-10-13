/**
 * @cup/simulator —— 假杯子(M0)。
 * 详见 architecture.md §7 / plan.md M0.2。
 */
export {
  Engine,
  step,
  drinkStep,
  refillStep,
  shakeStep,
  gestureStep,
  hotWaterStep,
  hhmm,
} from './core/engine.ts';
export type { Frame, SimConfig, ScriptStep, EngineContext, Sink } from './core/engine.ts';
export { World } from './core/world.ts';
export { VirtualClock, dayStartMs, fmt } from './core/clock.ts';
export { Scheduler } from './core/scheduler.ts';
export { LidSensor } from './sensors/lid.ts';
export { BaseSensor } from './sensors/base.ts';
export { startWsServer, toFrames } from './ws/server.ts';
export type { WsHandle } from './ws/server.ts';
export { startMqttOutput, upTopic, downTopic } from './mqtt/server.ts';
export type { MqttOutput, MqttOutputOptions } from './mqtt/server.ts';
export { parseControl, applyControl } from './core/control.ts';
export type { ControlCommand, ParseControlResult, ControlOutcome } from './core/control.ts';
export { typicalDay, smoke } from './scenarios/day.ts';
export { buildBackfill, runBackfill, DEFAULT_GOAL_ML } from './scenarios/backfill.ts';
export type { BackfillDay, BackfillOptions, BackfillTier, RunBackfillOptions, RunBackfillResult } from './scenarios/backfill.ts';
export { createRng, gaussian, uniform, deriveSeed64 } from './util/rng.ts';
export { generateClaim, buildHello, CLAIM_ALPHABET, CLAIM_LEN } from './util/claim.ts';
export type { HelloFrame } from './util/claim.ts';
