/**
 * @cup/simulator —— 假杯子(M0)。
 * 详见 architecture.md §7 / plan.md M0.2。
 */
export { Engine, step, drinkStep, refillStep, shakeStep, hotWaterStep, hhmm } from './core/engine.ts';
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
export { typicalDay, smoke } from './scenarios/day.ts';
export { createRng, gaussian, uniform } from './util/rng.ts';
