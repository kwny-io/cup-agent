/**
 * 手势语法 —— 创意备忘 §5.1 #1「手势语法取代聊天框」的**前端半**(窗口 A,`apps/web`)。
 *
 * 备忘把交互从"打字"变成"动作":摇=问它 / 倾斜=抗议 / 放下=闭嘴 / 连摇=撒娇 / 轻磕或长按=确认。
 * 每动作 → **≤1 句 + 1 个表情**(表情复用 lib/eyes.ts 的十二态词汇表,不另建一套)。
 *
 * 这个模块是**纯逻辑**:吃契约里已有的 `motion` / `tilt_deg` 遥测(无需新数据),
 * 边沿检测切出手势,再翻译成 `{ line, state }`。渲染交给 EyePreview(和眼睛同源)。
 *
 * **信号源(2026-10-14 接上)**:摇/连摇/倾斜/放下 全由**现有** `motion`/`tilt_deg`
 * 边沿推出,零契约改动;轻磕/长按(tap)原先是空 seam —— 现契约已加 `tap`/`long_press`
 * 事件(盖内压力传感器,`packages/contract` §4),由 `latestTapTs()` 从事件流挑出新的一次,
 * 喂给 `noteTap()`。两类事件都归为「确认」。
 * 与眼睛状态机同款:纯函数/纯状态机、零 DOM、可单测(web 无 jsdom 也能测)。
 */

import type { CupEvent, MotionState } from '@cup/contract';
import type { EyeState } from './eyes.ts';

/**
 * 手势词汇(备忘 §5.1 #1 那张表的前端可识别子集)。
 * `shakeTwice` 是"摇"的**升级**——同一窗口内的第二次起摇。
 */
export type Gesture = 'shake' | 'shakeTwice' | 'tilt' | 'putDown' | 'tap';

/** 每个手势的回应:**一句傲娇台词 + 一个眼睛表情**。表情名取自 lib/eyes.ts 的 EyeState。 */
export interface GestureResponse {
  line: string;
  state: EyeState;
}

// ── 阈值(均为 [待实测] 的工程默认) ──────────────────────────────
/** 同一窗口内的第二次摇 → 判"连摇(撒娇)" */
const DOUBLE_SHAKE_WINDOW_S = 1.8;
/** 倾斜判定:倾角超此值才算"抗议式歪倒"(与 eyes.ts TILT_DEG 同源) */
const TILT_DEG = 20;
/** 放下:从"拿起"回到静止后,再稳这么久才确认(免得只是晃一下) */
const PUT_DOWN_SETTLE_S = 1.0;
/** 全局去抖:两次手势至少隔这么久,避免同一动作触发两次 */
const GESTURE_DEBOUNCE_S = 0.4;

/**
 * 手势 → 回应表(备忘 §5.1 #1:"每动作 → ≤1 句 + 1 个表情")。
 * 语气沿用 D1 人设「傲娇宠物」(lib/mood.ts:嘴上嫌弃、其实在乎)。
 */
export const GESTURE_RESPONSES: Record<Gesture, GestureResponse> = {
  // 摇=问它
  shake: { line: '摇什么摇?直接问啊。', state: 'startled' },
  // 连摇=撒娇
  shakeTwice: { line: '又摇……行了行了,陪你玩还不行吗。', state: 'content' },
  // 倾斜=抗议
  tilt: { line: '歪这么狠,水都要洒了。', state: 'tilt' },
  // 放下=闭嘴
  putDown: { line: '好,我闭嘴。你忙你的。', state: 'idle' },
  // 轻磕/长按=确认(契约 seam,暂无信号源)
  tap: { line: '嗯?什么事?', state: 'look' },
};

/** 备忘 §5.1 #1 的中文名(预览/调试用) */
export const GESTURE_LABEL: Record<Gesture, string> = {
  shake: '摇(问它)',
  shakeTwice: '连摇(撒娇)',
  tilt: '倾斜(抗议)',
  putDown: '放下(闭嘴)',
  tap: '轻磕(确认)',
};

/** 手势识别的输入:契约遥测里**已有**的两个字段 */
export interface GestureInputs {
  /** 契约 motion;'idle'|'tilt'|'shake'|'lifted' */
  motion: MotionState;
  /** 倾角(度) */
  tiltDeg: number;
}

/**
 * 手势识别器:每帧喂 `step(dt, {motion, tiltDeg})`,命中手势则返回其名字,否则 null。
 *
 * 全是**边沿检测**(动作的"起手"那一瞬),不是电平检测 —— 否则持续倾斜会每帧喷手势。
 * 一次 step 至多返回一个手势(同帧多命中时按优先级取:连摇 > 摇 > 轻磕 > 放下 > 倾斜)。
 */
export class Gestures {
  private clock = 0;
  /** 上一次的 motion / 倾角(边沿检测用) */
  private lastMotion: MotionState = 'idle';
  /** 上一次"起摇"的时钟;null = 当前不在连摇窗口内 */
  private lastShakeAt: number | null = null;
  /** 截至目前这一"起摇"是否已被判成 shakeTwice(免得第三次又喷一遍) */
  private shakeBurstArmed = false;
  /** 放下:从 lifted 落到 idle 后开始计稳;null = 不在计时 */
  private settleT: number | null = null;
  /** 全局去抖:上次出手势的时钟 */
  private lastGestureAt = -Infinity;
  /** 手势事件的 pending(契约 tap/long_press 事件 → noteTap() 置位) */
  private tapPending = false;

  /**
   * **轻磕 / 长按 → 确认**。
   * 信号源:契约的 `tap`/`long_press` 事件(盖内压力传感器)。调用方(EyePreview)
   * 每帧用 `latestTapTs()` 挑出新事件后调本方法置位,下一帧 step 即吐出 `tap` 手势。
   */
  noteTap(): void {
    this.tapPending = true;
  }

  step(dt: number, inp: GestureInputs): Gesture | null {
    this.clock += dt;

    const candidates: Gesture[] = [];

    // ── 摇 → 连摇 ──────────────────────────────────────────────
    // 起摇边沿:非 shake → shake
    const shaking = inp.motion === 'shake';
    const wasShaking = this.lastMotion === 'shake';
    if (shaking && !wasShaking) {
      if (this.lastShakeAt !== null && this.clock - this.lastShakeAt <= DOUBLE_SHAKE_WINDOW_S) {
        // 窗口内的第二次起摇 → 撒娇(只报一次,第三次起不再重复报)
        if (!this.shakeBurstArmed) {
          candidates.push('shakeTwice');
          this.shakeBurstArmed = true;
        }
      } else {
        // 单次起摇 → 问它
        candidates.push('shake');
        this.shakeBurstArmed = false;
      }
      this.lastShakeAt = this.clock;
    }
    // 连摇窗口过期 → 复位,下一轮重新从"单摇"起算
    if (this.lastShakeAt !== null && this.clock - this.lastShakeAt > DOUBLE_SHAKE_WINDOW_S) {
      this.lastShakeAt = null;
      this.shakeBurstArmed = false;
    }

    // ── 倾斜 → 抗议 ────────────────────────────────────────────
    // 起倾边沿:倾角越过阈值而上一帧没有
    const tilted = inp.motion === 'tilt' || inp.tiltDeg >= TILT_DEG;
    const wasTilted = this.lastMotion === 'tilt';
    if (tilted && !wasTilted) candidates.push('tilt');

    // ── 放下 → 闭嘴 ────────────────────────────────────────────
    // 从 lifted 落到静止,再稳 PUT_DOWN_SETTLE_S 才确认
    if (inp.motion === 'lifted') {
      this.settleT = null; // 还拿着,不计
    } else if (this.lastMotion === 'lifted' && inp.motion === 'idle') {
      this.settleT = 0; // 刚放下,开始计稳
    } else if (this.settleT !== null) {
      if (inp.motion === 'idle') {
        this.settleT += dt;
        if (this.settleT >= PUT_DOWN_SETTLE_S) {
          candidates.push('putDown');
          this.settleT = null;
        }
      } else {
        this.settleT = null; // 又动了,放下不成立
      }
    }

    // ── 轻磕/长按(契约 seam)─────────────────────────────────
    if (this.tapPending) candidates.push('tap');

    this.lastMotion = inp.motion;

    if (candidates.length === 0) return null;
    // 全局去抖:窗口内**不消费** pending(否则一次真轻磕会被去抖静默吃掉)
    if (this.clock - this.lastGestureAt < GESTURE_DEBOUNCE_S) return null;

    const chosen = pickByPriority(candidates);
    if (chosen === 'tap') this.tapPending = false;
    this.lastGestureAt = this.clock;
    return chosen;
  }
}

/** 同帧多命中时取优先级最高者(连摇 > 摇 > 轻磕 > 放下 > 倾斜) */
const PRIORITY: Gesture[] = ['shakeTwice', 'shake', 'tap', 'putDown', 'tilt'];

function pickByPriority(cands: Gesture[]): Gesture | null {
  for (const g of PRIORITY) if (cands.includes(g)) return g;
  return cands[0] ?? null;
}

/**
 * 从事件流里挑出**比 `seenTs` 更新**的一次轻磕/长按,返回它的事件时间戳;没有则 null。
 *
 * 纯函数:调用方(EyePreview)持有上次的时间戳,每帧拿到事件列表就调一次 —— 多了一次
 * 新接触就 `noteTap()` 一次,同一事件因 `seenTs` 回传而不会被重复吃进。`tap`/`long_press`
 * 在契约里都归为「确认」,故不区分。
 */
export function latestTapTs(events: readonly CupEvent[], seenTs: number): number | null {
  let newest: number | null = null;
  for (const e of events) {
    if (e.type !== 'tap' && e.type !== 'long_press') continue;
    if (e.ts <= seenTs) continue;
    if (newest === null || e.ts > newest) newest = e.ts;
  }
  return newest;
}
