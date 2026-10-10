/**
 * 眼睛状态机 —— 硬件脸(杯盖双眼)的**纯逻辑内核**(创意备忘 §3 十二态词汇表)。
 *
 * 与 lib/mood.ts 的分工:
 *   mood   给**屏幕卡通杯**用(水波上的二次元脸:眼/嘴/腮)
 *   eyes   给**硬件脸**用(Memory LCD 128×128 单色点阵:只有眼睛)
 * 同一个灵魂:输入同源(IMU/tilt/shake/lifted/drink/battery/长期性格),
 * 输出姿态不同。这里只产出**姿态(pose)**,不碰 canvas —— 便于单测与"拿到屏之前先调好"。
 *
 * 渲染优先级(创意备忘 §1.3,从高到低):
 *   1. 系统态:交接(前端接管 → 闭眼)          ← 最高
 *   2. 本地物理:shake / tilt / lifted          ← 无延迟,直驱
 *   3. 身体态:低电虚弱                          ← 本地身体信号
 *   4. 瞬时事件:喝一口满足                      ← 短促,自收自散
 *   5. 环境态:被遗忘(抗议)/ 长期性格 / 打盹     ← 兜底
 *   6. 待机:眨眼 / 视线漂移
 *
 * 另有**加分项叠加**(备忘 §3,与上表正交):**水位低 → 眼神耷拉**、**水烫 → 蒸汽纹 + 眯眼**。
 *   它们**不改状态**,只在姿态上再叠一层 —— 数据直驱的环境量,故单色屏不能着色时用"蒸汽纹"表达"烫"。
 *
 * **交接是动作,不是切换**(备忘 §1.3):`owner` 由 'lid'↔'screen' 切换时,眼睑在 HANDOFF_S(≈0.4s)
 *   内**缓缓闭合/睁开**(上眼睑下压包络,不是直接灭屏)—— 这个 ~300ms 就是产品的"签名时刻"。
 *   状态名当帧即切(`sleep`),但**姿态平滑**;铁律"同一时刻只允许一处睁眼"由 handoff 包络兜住。
 * 记:备忘把"后端情绪"排在"本地待机"之上;这里让"被遗忘(抗议)"压过普通心情,
 *     因为它是明确的**抗议**语义(备忘 §3 #12 标为"本地+后端"),比一阵蔫更该被看见。
 *
 * 铁律(§4.1):**只传状态,绝不传像素**。本状态机在杯盖固件本地跑;
 * 下行 `face` 指令只给 emotion/intensity/gaze 几个字节,由这里程序化展开成眼型。
 */

import type { MotionState } from '@cup/contract';

export type EyeState =
  | 'nap' // 1 打盹:两条横线,极缓呼吸
  | 'sleep' // 2 睡觉(闭眼):交接给屏幕 / 夜间
  | 'idle' // 3 睁眼待机
  | 'blink' // 4 眨眼(瞬态)
  | 'look' // 5 看主人:瞳孔上看
  | 'startled' // 6 摇杯受惊:瞳孔放大 + 反向摆动
  | 'tilt' // 7 倾斜跟随:瞳孔随重力偏
  | 'content' // 8 喝一口满足:弧眼 + 慢眨
  | 'sulky' // 9 欠水蔫:上眼睑下垂,视线向下
  | 'smug' // 10 得意:微眯
  | 'weak' // 11 低电虚弱:半闭 + 瞳孔缩小
  | 'forgotten'; // 12 被遗忘(抗议):转开视线,不看你

/** 长期性格(M4,后端战报给),与 mood.ts 的 Disposition 同义,这里只取需要的三态 */
export type EyeDisposition = 'sulky' | 'normal' | 'smug';

/** 谁持有脸(交接协议 §1.3);'screen' = 前端接管 → 盖子闭眼 */
export type FaceOwner = 'lid' | 'screen';

export interface EyeInputs {
  /** 谁有脸;'screen' → 盖子闭眼(交接最高优先) */
  owner: FaceOwner;
  /** 契约 motion;null = 无遥测 */
  motion: MotionState | null;
  /** 倾角(度)与方向(度)—— 瞳孔随重力偏 */
  tiltDeg: number;
  tiltDir: number;
  /** 电量(0..100);null = 未知 */
  batteryPct: number | null;
  charging: boolean;
  /** 水位比例 0..1(加分项:水低 → 眼神耷拉) */
  level01: number;
  /** 水温(℃);null = 未知(加分项:水烫 → 蒸汽纹 + 眯眼,单色屏替代"眼底偏暖") */
  tempC: number | null;
  /** 长期性格底色 */
  disposition: EyeDisposition;
  /** 距上次**事件**的秒数(打盹触发) */
  idleSec: number;
  /** 距上次**前端连接/使用**的秒数(被遗忘触发) */
  forgotSec: number;
}

/**
 * 一帧眼部姿态 —— 渲染器唯一输入。128×128 单色点阵由 canvas 端按此展开。
 * 全是**归一化**量,与像素无关,屏幕端/预览端可任意缩放。
 */
export interface EyePose {
  state: EyeState;
  /** 眼睑开度 0..1(0=全闭,1=常态,>1=瞪大) */
  openness: number;
  /** 瞳孔在眼眶内的偏移(-1..1) */
  gazeX: number;
  gazeY: number;
  /** 瞳孔缩放(1=常态) */
  pupilScale: number;
  /** 整眼旋转(rad,随液面/重力) */
  rotate: number;
  /** 竖直位移(-1..1;正=下垂) */
  dropY: number;
  /** 笑眼弧(content) */
  arc: boolean;
  /** 上眼睑额外下压量 0..1(smug/蔫的眯眼) */
  squint: number;
  /** 水烫(加分项):叠加蒸汽纹 */
  hot: boolean;
  /** 蒸汽上升相位(rad);hot 时由时钟推进,渲染器据此画上飘的纹路 */
  steamPhase: number;
}

// ── 阈值(备忘 §3 触发栏;均为 [待实测] 的工程默认) ──────────────
/** 眨眼间隔(秒)上下界 —— "活着"的第一要素 */
const BLINK_MIN_S = 2;
const BLINK_MAX_S = 6;
/** 一次眨眼时长(秒):下压+抬起。备忘 §3 #4 写 100ms 下压,总动作留 ~180ms 更顺眼 */
const BLINK_S = 0.18;
/** 打盹:多久无事件 */
const NAP_AFTER_S = 30 * 60;
/** 被遗忘(抗议):多久没被连/用 */
const FORGOT_AFTER_S = 2 * 60 * 60;
/** 低电虚弱阈值(与后端 get_self 的 LOW_BATTERY_PCT 取同值 20,两张脸口径一致) */
const LOW_BATTERY_PCT = 20;
/** 喝一口满足持续(秒) */
const CONTENT_S = 3.5;
/** 受惊持续(秒) */
const STARTLED_S = 1.6;
/** 倾斜判定:倾角超此值就算"跟着倒"(与契约 tilt_deg=35 阈值同源) */
const TILT_DEG = 20;
/** 水位低 → 眼神耷拉(加分项) */
const LOW_LEVEL = 0.15;
/** 水烫 → 蒸汽纹 + 眯眼(加分项)。取备忘 §2 的 ~60℃ 量级;沿用屏幕卡通杯的显蒸汽阈值更连贯 */
const HOT_TEMP_C = 55;
/** 水烫叠加的眯眼量(0..1,比 smug 的 0.7 轻,别盖过表情) */
const HOT_SQUINT = 0.35;
/** 交接动作时长(秒):备忘 §1.3 —— 盖子"缓慢闭眼"(300–500ms 眼皮下压,不是直接灭屏) */
const HANDOFF_S = 0.4;
/** 低电虚弱:**三次慢眨**(备忘 §3 #11)。"慢" ≈ 常态眨眼(BLINK_S 0.18s)的 4 倍时长 */
const WEAK_BLINK_S = 0.7;
/** 三次慢眨彼此的间隔(秒) */
const WEAK_BLINK_GAP_S = 1.3;
const WEAK_BLINK_COUNT = 3;
/** 一轮三次眨完后的静息(秒),过后再起一轮 —— 免得虚弱的杯子从此僵住(眨眼是"活着"的第一要素) */
const WEAK_CYCLE_REST_S = 6;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 伪随机但确定:同一 seed 恒定,便于测试;用于眨眼间隔抖动 */
function jitter(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export class Eyes {
  private clock = 0;
  private state: EyeState = 'idle';
  /** 眨眼:距下次眨的倒计时(秒)与当前眨眼进度 */
  private blinkIn = BLINK_MIN_S;
  private blinkT = -1; // <0 = 不在眨
  /** 当前这次眨的时长(秒):常态 BLINK_S,低电慢眨 WEAK_BLINK_S */
  private blinkDur = BLINK_S;
  /** 受惊/满足剩余时长(秒);>0 即有效 */
  private startledT = 0;
  private contentT = 0;
  /** 摇头相位(受惊反向摆动) */
  private wobble = 0;
  /** 视线漂移相位(待机时轻微游走) */
  private drift = 0;
  /** 上一次收到的 motion(用于边沿检测:起摇那一瞬) */
  private wasShaking = false;
  /** 眨眼随机种子(每次眨完重掷) */
  private seed = 1;
  /** 本帧是否判为"水烫"(加分项;叠加态,非 EyeState) */
  private hotState = false;
  /** 蒸汽上升相位(rad);只在 hot 时推进 */
  private steamPhase = 0;
  /**
   * 交接闭眼包络 0..1:0 = 睁(lid 侧稳态),1 = 闭(screen 侧稳态)。
   * 备忘 §1.3:"交接是一个动作,不是一次切换" —— 眼睑在 HANDOFF_S 内缓动。
   */
  private handoff = 0;
  /** 低电虚弱的"三次慢眨"(备忘 §3 #11):本轮已眨次数 / 下眨倒计时 / 本轮后静息 */
  private weakBlinks = 0;
  private weakBlinkIn = WEAK_BLINK_GAP_S;
  private weakRestT = 0;
  /** 手势语法 §5.1 #1:一次性强制表情(压过本地物理之外的一切,但不越交接) */
  private exprState: EyeState | null = null;
  private exprT = 0;
  /** 最近计算的姿态(供 getter) */
  private pose: EyePose = idlePose();

  get current(): EyeState {
    return this.state;
  }

  get currentPose(): EyePose {
    return this.pose;
  }

  /** 外部事件:喝了一口(契约 drink 事件 / 水位掉档),喂一次 */
  noteDrink(): void {
    this.contentT = CONTENT_S;
  }

  /** 外部事件:受惊(契约 shake / 冲击)。通常由 step 的 motion 边沿自动触发,这是手动口 */
  noteStartled(): void {
    this.startledT = STARTLED_S;
    this.wobble = 0;
  }

  /**
   * 外部事件:**强制一次表情**(手势语法 §5.1 #1:"每动作 → 1 个表情")。
   * 有些手势的自然反应与要点亮的表情不一致(连摇 → 想给"满足"而不是"受惊"),故给一个
   * 一次性覆盖。优先级**仅次于交接**(handoff 的"同一时刻只允许一处睁眼"是铁律,不可越)。
   * 时长到点自动回落(同 noteDrink 的自收自散)。
   */
  noteExpression(state: EyeState, seconds: number): void {
    this.exprState = state;
    this.exprT = seconds;
  }

  /**
   * 每帧按固定步长推进(与 mood.ts 同款:调用方用 rAF 固定 dt 累加)。
   * 产出并缓存本帧姿态。
   */
  step(dt: number, inp: EyeInputs): void {
    this.clock += dt;
    this.drift += dt;

    // 加分项:水烫判定 + 蒸汽相位(与状态正交,叠加态)
    this.hotState = inp.tempC !== null && inp.tempC >= HOT_TEMP_C;
    if (this.hotState) this.steamPhase += dt * 2.4;

    // 边沿:起摇那一瞬直接受惊(即便调用方没喂事件,IMU 也在)
    const shaking = inp.motion === 'shake';
    if (shaking && !this.wasShaking) this.noteStartled();
    this.wasShaking = shaking;

    if (this.startledT > 0) this.startledT = Math.max(0, this.startledT - dt);
    if (this.contentT > 0) this.contentT = Math.max(0, this.contentT - dt);
    if (this.exprT > 0) {
      this.exprT = Math.max(0, this.exprT - dt);
      if (this.exprT === 0) this.exprState = null;
    }

    // 交接闭合度缓动(备忘 §1.3):屏幕持脸 → 渐闭;盖持脸 → 渐睁
    const target = inp.owner === 'screen' ? 1 : 0;
    const stepN = dt / HANDOFF_S;
    if (this.handoff < target) this.handoff = Math.min(target, this.handoff + stepN);
    else if (this.handoff > target) this.handoff = Math.max(target, this.handoff - stepN);

    // 眨眼计时(只在"看得见"的状态里走表)
    const s = this.resolveState(inp, shaking);
    this.runBlink(dt, s);

    this.state = s;
    this.pose = this.computePose(s, inp, dt);
  }

  /** 状态决议:按 §1.3 优先级自上而下第一个命中 */
  private resolveState(inp: EyeInputs, shaking: boolean): EyeState {
    // 1. 交接:前端有脸 → 盖子闭眼(最高)
    if (inp.owner === 'screen') return 'sleep';
    // 2. 本地物理
    if (shaking || this.startledT > 0) return 'startled';
    // 手势语法的**一次性强制表情**(§5.1 #1):压过其余一切,但不越交接(上面已 return)
    if (this.exprT > 0 && this.exprState !== null) return this.exprState;
    if (inp.motion === 'lifted') return 'look';
    if (inp.motion === 'tilt' || inp.tiltDeg >= TILT_DEG) return 'tilt';
    // 3. 身体态:低电虚弱(充电时不算,免得插着电还一副没劲样)
    if (inp.batteryPct !== null && inp.batteryPct <= LOW_BATTERY_PCT && !inp.charging) return 'weak';
    // 4. 瞬时事件:喝一口满足(有时限)
    if (this.contentT > 0) return 'content';
    // 5. 环境态:被遗忘(抗议)> 长期性格 > 打盹
    if (inp.forgotSec >= FORGOT_AFTER_S) return 'forgotten';
    if (inp.disposition === 'sulky') return 'sulky';
    if (inp.disposition === 'smug') return 'smug';
    if (inp.idleSec >= NAP_AFTER_S) return 'nap';
    // 6. 待机:眨眼是叠加在 idle 上的瞬态
    if (this.blinkT >= 0) return 'blink';
    return 'idle';
  }

  /** 眨眼排程:倒计时到 0 开眨,眨完重掷 2–6s;正在眨则推进进度
   *  · 正在眨(blinkT≥0):任何状态下都推进完(免得进 weak 时卡在半眨)
   *  · 低电虚弱(§3 #11)走**慢眨三连**独立排程,不用待机的 2–6s 随机
   *  · 其余"睁着"的状态才用待机随机眨眼(闭眼/睡眠/打盹/蔫不眨)
   */
  private runBlink(dt: number, s: EyeState): void {
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      if (this.blinkT >= this.blinkDur) {
        this.blinkT = -1;
        this.blinkDur = BLINK_S;
        this.seed += 1;
      }
      return;
    }
    if (s === 'weak') {
      this.runWeakBlink(dt);
      return;
    }
    // 离开 weak 时复位三连进度:下次入弱电再从头眨三下
    this.weakBlinks = 0;
    this.weakBlinkIn = WEAK_BLINK_GAP_S;
    this.weakRestT = 0;
    if (s === 'sleep' || s === 'nap' || s === 'sulky') return;
    this.blinkIn -= dt;
    if (this.blinkIn <= 0) {
      this.blinkT = 0;
      const span = BLINK_MAX_S - BLINK_MIN_S;
      this.blinkIn = BLINK_MIN_S + jitter(this.seed) * span;
    }
  }

  /** 低电虚弱:三次慢眨(间隔 WEAK_BLINK_GAP_S),一轮完静息 WEAK_CYCLE_REST_S 再起一轮 */
  private runWeakBlink(dt: number): void {
    if (this.weakRestT > 0) {
      this.weakRestT -= dt;
      if (this.weakRestT <= 0) {
        this.weakBlinks = 0;
        this.weakBlinkIn = 0;
      }
      return;
    }
    this.weakBlinkIn -= dt;
    if (this.weakBlinkIn <= 0) {
      this.blinkT = 0;
      this.blinkDur = WEAK_BLINK_S;
      this.weakBlinks += 1;
      if (this.weakBlinks >= WEAK_BLINK_COUNT) this.weakRestT = WEAK_CYCLE_REST_S;
      else this.weakBlinkIn = WEAK_BLINK_GAP_S;
    }
  }

  private computePose(s: EyeState, inp: EyeInputs, dt: number): EyePose {
    // 倾斜 → 视线朝低处偏;屏幕水平轴上的投影决定左右
    const dirRad = (inp.tiltDir * Math.PI) / 180;
    const lookX = clamp(Math.cos(dirRad), -1, 1);
    const tiltAmt = clamp(inp.tiltDeg / 45, 0, 1);
    // 待机轻微视线漂移(正弦,不走神过头)
    const driftX = Math.sin(this.drift * 0.5) * 0.12;
    const driftY = Math.sin(this.drift * 0.31 + 1.7) * 0.08;
    // 加分项:水烫 → 眯一眼(叠加在所有状态上;蒸汽纹由渲染器另画)
    const hotSquint = this.hotState ? HOT_SQUINT : 0;

    const base: EyePose = {
      state: s,
      openness: 1,
      gazeX: driftX,
      gazeY: driftY,
      pupilScale: 1,
      rotate: 0,
      dropY: 0,
      arc: false,
      squint: 0,
      hot: this.hotState,
      steamPhase: this.steamPhase,
    };

    const pose: EyePose = (() => {
      switch (s) {
        case 'sleep':
          // 闭眼开度**交给交接包络**(末尾 ×(1-`handoff`)):备忘 §1.3 的"缓慢闭眼"由此而来
          return { ...base, openness: 1, gazeX: 0, gazeY: 0, squint: hotSquint };
        case 'nap': {
          // 打盹:极低开度 + 每 8s 极缓 1px 呼吸位移
          const breathe = Math.sin(this.clock * (Math.PI * 2) / 8) * 0.015;
          return { ...base, openness: 0.05, dropY: breathe, gazeX: 0, gazeY: 0, squint: hotSquint };
        }
        case 'blink': {
          // 眨眼曲线:0→1→0 的半正弦,最低点闭眼。时长用 blinkDur(低电慢眨更长)
          const p = clamp(this.blinkT / this.blinkDur, 0, 1);
          return { ...base, openness: Math.abs(Math.cos(p * Math.PI)), squint: hotSquint };
        }
        case 'startled': {
          // 受惊:瞳孔放大 + 反向摆动(带阻尼,越晃越小)
          this.wobble += dt * Math.PI * 2 * 6;
          const damp = this.startledT / STARTLED_S;
          return {
            ...base,
            openness: 1.15,
            pupilScale: 1.5,
            gazeX: Math.sin(this.wobble) * 0.35 * damp,
            gazeY: 0,
            squint: hotSquint,
          };
        }
        case 'look':
          // 看主人:瞳孔上看(略偏"你"那侧)
          return { ...base, gazeY: -0.45, gazeX: clamp(lookX * 0.3 + driftX, -1, 1), squint: hotSquint };
        case 'tilt':
          // 倾斜跟随:视线朝低处,整眼微转,慢一拍
          return {
            ...base,
            gazeX: clamp(lookX * 0.55 + driftX * 0.4, -1, 1),
            gazeY: 0.1 * tiltAmt,
            rotate: -lookX * tiltAmt * 0.18,
            dropY: 0.05 * tiltAmt,
            squint: hotSquint,
          };
        case 'content':
          // 满足:两眼弯成弧 + 微抬(慢眨由 openness 缓抬表现)
          return { ...base, arc: true, openness: 0.92, gazeY: -0.1, squint: hotSquint };
        case 'sulky': {
          // 蔫:上眼睑下垂 60%,视线向下;水越低越耷拉(加分项)
          const droop = 0.4 - clamp(inp.level01 / 0.4, 0, 1) * 0.06;
          return { ...base, openness: 1 - 0.6, squint: droop + hotSquint, gazeY: 0.4, gazeX: driftX * 0.5 };
        }
        case 'smug':
          // 得意:眼底平直、微眯
          return { ...base, openness: 0.75, squint: 0.7 + hotSquint, gazeY: -0.12, gazeX: driftX * 0.5 };
        case 'weak': {
          // 低电:半闭 + 瞳孔缩小。§3 #11 的"三次慢眨"在此态内下压眼睑 ——
          // 状态名仍是 weak(半闭是常驻),慢眨只是把开度在 0.42 基线上下压到闭合再抬回。
          const blink = this.blinkT >= 0
            ? Math.abs(Math.cos(clamp(this.blinkT / this.blinkDur, 0, 1) * Math.PI))
            : 1;
          return { ...base, openness: 0.42 * blink, pupilScale: 0.68, dropY: 0.15, squint: hotSquint };
        }
        case 'forgotten':
          // 抗议:视线坚决转开一侧,不看你
          return { ...base, openness: 0.9, gazeX: -0.72, gazeY: 0.12, squint: hotSquint };
        case 'idle':
        default: {
        // 水位过低 → 眼神轻微耷拉(与 sulky 同向,较弱)
        const levelDrop = clamp((LOW_LEVEL - inp.level01) / LOW_LEVEL, 0, 1) * 0.25;
        return { ...base, openness: 1 - levelDrop, gazeY: driftY + levelDrop * 0.2, squint: hotSquint };
      }
      }
    })();

    // 交接包络:上眼睑按 `handoff` 下压(1 → 全闭)。`sleep` 已在分支里设为 openness=1,
    // 由此变成"逐渐闭合";回到 lid 侧时同样逐渐睁开 → 备忘 §1.3 的"缓慢闭眼/睁眼"签名时刻。
    if (this.handoff > 0) pose.openness = pose.openness * (1 - this.handoff);
    pose.squint = Math.min(1, pose.squint + this.handoff);
    return pose;
  }
}

function idlePose(): EyePose {
  return {
    state: 'idle',
    openness: 1,
    gazeX: 0,
    gazeY: 0,
    pupilScale: 1,
    rotate: 0,
    dropY: 0,
    arc: false,
    squint: 0,
    hot: false,
    steamPhase: 0,
  };
}

/** 备忘 §3 的中文名(预览面板/调试用) */
export const EYE_STATE_LABEL: Record<EyeState, string> = {
  nap: '打盹',
  sleep: '睡觉',
  idle: '待机',
  blink: '眨眼',
  look: '看主人',
  startled: '受惊',
  tilt: '倾斜跟随',
  content: '满足',
  sulky: '欠水蔫',
  smug: '得意',
  weak: '低电虚弱',
  forgotten: '被遗忘',
};
