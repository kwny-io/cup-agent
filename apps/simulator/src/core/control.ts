/**
 * 手动控制指令 —— 从 WS 控制通道进来的"导演"动作。
 *
 * 行为脚本按虚拟时间自动推进;手动控制是给演示/联调用的**外部触发**:
 * 前端开发者(或 curl/脚本)可以在任意时刻让假杯子"喝一口/摇一下/倒热水",
 * 不必等脚本轮到那一刻。
 *
 * 分两层,便于单测:
 *   parseControl —— 纯解析 + 边界收口(不可信输入一律在这里挡下)
 *   applyControl —— 把已解析的指令作用到 world/scheduler
 *
 * 协议(客户端 → 模拟器,JSON):
 *   {"type":"drink","ml":60}
 *   {"type":"refill","target_ml":320,"pour_c":55}
 *   {"type":"hot_water","target_ml":300,"pour_c":85}
 *   {"type":"shake","duration_ms":1500}
 *   {"type":"tilt","deg":50,"dir":90}   /  {"type":"idle"}
 *   {"type":"lift"} / {"type":"put_down"}
 *   {"type":"press","duration_ms":150}   盖顶按压(→ tap/long_press 手势)
 *   {"type":"set_temp","c":80}
 *   {"type":"pause"} / {"type":"resume"}
 */
import { CUP, clamp } from '@cup/contract';
import type { EngineContext } from './engine.ts';

export type ControlCommand =
  | { type: 'drink'; ml: number }
  | { type: 'refill'; targetMl: number; pourC: number }
  | { type: 'hot_water'; targetMl: number; pourC: number }
  | { type: 'shake'; durationMs: number }
  | { type: 'tilt'; deg: number; dir: number }
  | { type: 'idle' }
  | { type: 'lift' }
  | { type: 'put_down' }
  | { type: 'press'; durationMs: number }
  | { type: 'set_temp'; c: number }
  | { type: 'pause' }
  | { type: 'resume' };

export type ParseControlResult =
  | { ok: true; cmd: ControlCommand }
  | { ok: false; error: string };

export interface ControlOutcome {
  ok: boolean;
  detail: string;
  /** pause/resume 要改"脚本是否推进",由 engine 主循环消费 */
  loop?: 'pause' | 'resume';
}

/** 取一个有限的数字字段;非数字/非有限 → null(调用方判非法)。 */
function num(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 解析并收口一条控制消息。
 * 未知 type、缺字段、字段非有限数字 → 全部拒绝(返回原因,不抛)。
 * 数值字段只做**物理范围钳制**(如 deg 500→180),不静默接受垃圾类型。
 */
export function parseControl(raw: unknown): ParseControlResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: '不是对象' };
  }
  const o = raw as Record<string, unknown>;
  const type = o['type'];
  if (typeof type !== 'string') return { ok: false, error: '缺 type' };

  switch (type) {
    case 'drink': {
      const ml = num(o, 'ml');
      if (ml === null) return { ok: false, error: 'drink 需要数字 ml' };
      return { ok: true, cmd: { type: 'drink', ml: clamp(ml, 1, CUP.capacity_ml) } };
    }
    case 'refill': {
      const targetMl = num(o, 'target_ml');
      const pourC = num(o, 'pour_c');
      if (targetMl === null || pourC === null)
        return { ok: false, error: 'refill 需要数字 target_ml / pour_c' };
      return {
        ok: true,
        cmd: {
          type: 'refill',
          targetMl: clamp(targetMl, 0, CUP.capacity_ml),
          pourC: clamp(pourC, -10, 120),
        },
      };
    }
    case 'hot_water': {
      const targetMl = num(o, 'target_ml');
      const pourC = num(o, 'pour_c');
      if (targetMl === null || pourC === null)
        return { ok: false, error: 'hot_water 需要数字 target_ml / pour_c' };
      return {
        ok: true,
        cmd: {
          type: 'hot_water',
          targetMl: clamp(targetMl, 0, CUP.capacity_ml),
          pourC: clamp(pourC, -10, 120),
        },
      };
    }
    case 'shake': {
      const durationMs = num(o, 'duration_ms');
      if (durationMs === null) return { ok: false, error: 'shake 需要数字 duration_ms' };
      return { ok: true, cmd: { type: 'shake', durationMs: clamp(durationMs, 100, 60_000) } };
    }
    case 'press': {
      // 盖顶按压(手势):与 shake 同形,给出按压时长;
      // tap/long_press 的**分类**由 LidSensor 按接触时长决定,这里只管"按多久"。
      const durationMs = num(o, 'duration_ms');
      if (durationMs === null) return { ok: false, error: 'press 需要数字 duration_ms' };
      return { ok: true, cmd: { type: 'press', durationMs: clamp(durationMs, 1, 60_000) } };
    }
    case 'tilt': {
      const deg = num(o, 'deg');
      const dir = num(o, 'dir');
      if (deg === null) return { ok: false, error: 'tilt 需要数字 deg' };
      return {
        ok: true,
        cmd: {
          type: 'tilt',
          deg: clamp(deg, 0, 180),
          dir: clamp(dir ?? 0, 0, 359),
        },
      };
    }
    case 'idle':
      return { ok: true, cmd: { type: 'idle' } };
    case 'lift':
      return { ok: true, cmd: { type: 'lift' } };
    case 'put_down':
      return { ok: true, cmd: { type: 'put_down' } };
    case 'set_temp': {
      const c = num(o, 'c');
      if (c === null) return { ok: false, error: 'set_temp 需要数字 c' };
      return { ok: true, cmd: { type: 'set_temp', c: clamp(c, -10, 120) } };
    }
    case 'pause':
      return { ok: true, cmd: { type: 'pause' } };
    case 'resume':
      return { ok: true, cmd: { type: 'resume' } };
    default:
      return { ok: false, error: `未知 type: ${type}` };
  }
}

/**
 * 把已解析的指令作用到 world/scheduler。
 * "拿起来做一件事"类动作(drink/refill/hot_water/shake)会在几秒后自动放回底座,
 * 与行为脚本里的 drinkStep/refillStep 同语义;tilt/idle/lift/put_down 是持续姿态,不自动复位。
 */
export function applyControl(ctx: EngineContext, cmd: ControlCommand): ControlOutcome {
  const { world, scheduler, clock } = ctx;
  const now = clock.nowMs;

  switch (cmd.type) {
    case 'drink': {
      world.setOnBase(false);
      world.setMotion('lifted');
      const actual = world.drink(cmd.ml);
      scheduler.at(now + 3000, () => {
        world.setOnBase(true);
        world.setMotion('idle');
      }, '手动:放回底座');
      return { ok: true, detail: `喝 ${actual.toFixed(0)}ml` };
    }
    case 'refill': {
      world.setOnBase(false);
      world.setMotion('lifted');
      const { addedMl } = world.refill(cmd.targetMl, cmd.pourC);
      scheduler.at(now + 3000, () => {
        world.setOnBase(true);
        world.setMotion('idle');
      }, '手动:放回底座');
      return { ok: true, detail: `续杯 +${addedMl.toFixed(0)}ml @ ${cmd.pourC}°C` };
    }
    case 'hot_water': {
      world.setOnBase(false);
      world.setMotion('lifted');
      world.refillTo(cmd.targetMl, cmd.pourC);
      scheduler.at(now + 4000, () => {
        world.setOnBase(true);
        world.setMotion('idle');
      }, '手动:放回底座');
      return { ok: true, detail: `倒热水 ${cmd.pourC}°C 到 ${cmd.targetMl}ml` };
    }
    case 'shake': {
      world.setOnBase(false);
      world.setMotion('shake', 12, 90);
      scheduler.at(now + cmd.durationMs, () => world.setMotion('idle'), '手动:停止摇晃');
      scheduler.at(now + cmd.durationMs + 1000, () => world.setOnBase(true), '手动:放回底座');
      return { ok: true, detail: `摇杯 ${cmd.durationMs}ms` };
    }
    case 'tilt': {
      world.setMotion('tilt', cmd.deg, cmd.dir);
      return { ok: true, detail: `倾倒 ${cmd.deg}° 方向 ${cmd.dir}°` };
    }
    case 'idle': {
      world.setMotion('idle');
      return { ok: true, detail: '回正' };
    }
    case 'lift': {
      world.setOnBase(false);
      world.setMotion('lifted');
      return { ok: true, detail: '拿起' };
    }
    case 'put_down': {
      world.setOnBase(true);
      world.setMotion('idle');
      return { ok: true, detail: '放下' };
    }
    case 'press': {
      // 按住盖顶 durationMs 后松开;事件由 LidSensor 在松手时分类(与真固件同构)。
      world.setPress(200);
      scheduler.at(now + cmd.durationMs, () => world.setPress(0), '手动:松开盖顶');
      const kind = cmd.durationMs >= 600 ? 'long_press' : 'tap';
      return { ok: true, detail: `按压盖顶 ${cmd.durationMs}ms(→ ${kind})` };
    }
    case 'set_temp': {
      world.setTemp(cmd.c);
      return { ok: true, detail: `水温设为 ${cmd.c}°C` };
    }
    case 'pause':
      return { ok: true, detail: '脚本已暂停', loop: 'pause' };
    case 'resume':
      return { ok: true, detail: '脚本已恢复', loop: 'resume' };
  }
}
