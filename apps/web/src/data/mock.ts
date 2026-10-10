/**
 * 本地假数据源 —— 模拟器没开时也能看画面(?mock=1)。
 *
 * 走的是同一条 DataSource 接口、同一套契约类型,所以看板组件分不出来。
 * 真接上模拟器后,这个源可以留着做 demo / 离线开发。
 *
 * 演示节奏(**50Hz 快发**,验证 M3 水波物理的"同步感"):
 *   0–12s   静置(3s/8s 各喝一口 → 杯子 ~8s "得意"半眯眼)
 *   12–15s  摇杯(motion=shake,带 IMU 高频抖动 → 先皱眉再勉为其难)
 *   15–21s  缓慢倾斜到右倾 40° 再回正(液面流向低处)
 *   21–24s  向左倾斜 40° 再回正
 *   24s 起  不再喝,水位停在低位 → 持续 6s 后"蔫"(撇嘴 + 眼神飘走)
 *   之后循环;期间照旧有喝/续水与降温。
 *
 * 注意:M3 英雄功能靠 high-rate 的 motion/imu/tilt;模拟器实时档是 1Hz、
 * 不带 IMU,靠 motion 状态与差分斜率驱动(见 CupWidget)。
 */
import { Emitter, type AskResult, type DataSource, type DataSourceEvents, type GoalResult, type LiveFrame } from './source.ts';
import type { BaseTelemetry, CupEvent, LidTelemetry } from '@cup/contract';
import { parseGoal, saveGoal } from '../lib/goal.ts';

const CUP_ID = 'cup-WEB01';
const LID_ID = 'lid-WEB01';
const BASE_ID = 'base-WEB01';

/** 快发间隔:50Hz,和真固件实时档一个量级 */
const TICK_MS = 20;
/** 演示循环长度(秒),与上面注释的节奏对应 */
const CYCLE_S = 27;

export class MockSource implements DataSource {
  readonly kind = 'mock';
  private em = new Emitter();
  private timer: ReturnType<typeof setInterval> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  /** StrictMode 双挂载:cleanup 后必须让"连接中"的定时器作废,否则双份数据 */
  private stopped = false;
  private t0 = Date.now();
  private lastTickAt = 0;
  private seq = 0;
  private levelMl = 300;
  private tempC = 52;
  private events: CupEvent[] = [];
  /** 上一秒的整数秒,(s % 20 === 0) 这类节拍只在跨秒时触发一次 */
  private lastWholeSec = -1;

  connect(): void {
    this.stopped = false;
    this.em.emit('state', 'connecting');
    // 模拟"连上"的短延迟
    this.startTimer = setTimeout(() => {
      if (this.stopped) return; // 已被 cleanup 作废(双挂载的第一份)
      this.em.emit('state', 'open');
      this.t0 = Date.now();
      this.lastTickAt = this.t0;
      this.timer = setInterval(() => this.tick(), TICK_MS);
    }, 300);
  }

  disconnect(): void {
    this.stopped = true;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.em.emit('state', 'closed');
  }

  // 本源只发 frame/state;server 事件是 CloudSource 的事,这里实现成空订阅
  on<K extends keyof DataSourceEvents>(
    evt: K,
    cb: Parameters<DataSource['on']>[1],
  ): () => void {
    return this.em.on(evt, cb as never);
  }

  /**
   * 本地问答兜底 —— 没有后端时也能把对话 UI 跑通(CHAT-HANDOFF:先接 mock)。
   *
   * 用当前真实水位/水温拼一句傲娇口吻的答复(数字来自本机遥测,不编),
   * source 标 'fallback' 与后端的模板兜底同类。故意留一点延迟,能看到"杯子在想…"。
   * 契约与 CloudSource 一致:从不 reject,失败也 resolve 成 AskResult。
   */
  async ask(q: string): Promise<AskResult> {
    await new Promise((r) => setTimeout(r, 450));
    const pct = Math.round((this.levelMl / 400) * 100);
    const temp = Math.round(this.tempC);
    return {
      ok: true,
      answer: {
        text: mockAnswer(q, pct, temp),
        source: 'fallback',
        tools_used: [],
        turns: 1,
      },
    };
  }

  /**
   * 离线改目标 —— 没有后端,存本地即可(刷新不丢)。校验复用 lib/goal 的
   * parseGoal,与云源/后端同一个合法域,免得 mock 下能填出后端会拒的值。
   */
  async setGoal(goalMl: number): Promise<GoalResult> {
    const p = parseGoal(String(goalMl));
    if (!p.ok) return { ok: false, reason: 'invalid' };
    saveGoal(p.value);
    return { ok: true, goalMl: p.value };
  }

  private tick(): void {
    const now = Date.now();
    const dtMs = now - this.lastTickAt;
    this.lastTickAt = now;
    const s = (now - this.t0) / 1000;
    const whole = Math.floor(s);
    this.seq += 1;

    // 喝水 / 续水:按整秒节拍触发(50Hz tick 下不会重复)
    if (whole !== this.lastWholeSec) {
      this.lastWholeSec = whole;
      // 3s / 8s 各喝一口 → 30s 窗口内攒够两口,杯子在 ~8s "得意"一下
      if (whole === 3 || whole === 8 || whole === 18) {
        this.levelMl = Math.max(0, this.levelMl - 60);
        this.events.push(ev('drink', { amount_ml: 60, temp_c: this.tempC }));
      }
      // 18s 后不再喝:水位停在 30% 以下,持续 6s → 触发"被怠慢 → 蔫"
      if (whole === 18) this.tempC = 66; // 刚续过水,热乎乎的(顺带看蒸汽)
    }
    // 降温按真实 dt 走
    this.tempC = Math.max(24, this.tempC - 0.15 * (dtMs / 1000));

    const phase = s % CYCLE_S;
    const { motion, tiltDeg, tiltDir, shake } = phaseState(phase, this.t0, now);
    const tiltRad = (tiltDeg * Math.PI) / 180;
    const dirRad = (tiltDir * Math.PI) / 180;

    const levelPct = Math.round((this.levelMl / 400) * 100);
    const lid: LidTelemetry = {
      v: 1,
      device_id: LID_ID,
      cup_id: CUP_ID,
      ts: now,
      seq: this.seq,
      sample_ms: TICK_MS,
      temp_c: round1(this.tempC),
      level_mm: round1(this.levelMl * 0.325),
      level_pct: levelPct,
      motion,
      tilt_deg: round1(tiltDeg),
      tilt_dir: tiltDir,
      battery_pct: 78,
      charging: false,
      // 带 IMU:真实档才有;摇晃时叠加高频抖动
      imu: {
        ax: round3(Math.sin(tiltRad) * Math.cos(dirRad) + (shake ? gauss() * 1.6 : gauss() * 0.01)),
        ay: round3(Math.sin(tiltRad) * Math.sin(dirRad) + (shake ? gauss() * 1.6 : gauss() * 0.01)),
        az: round3(Math.cos(tiltRad) + (shake ? gauss() * 1.6 : gauss() * 0.01)),
        gx: round1(shake ? gauss() * 60 : gauss() * 0.5),
        gy: round1(shake ? gauss() * 60 : gauss() * 0.5),
        gz: round1(shake ? gauss() * 30 : gauss() * 0.5),
      },
    };
    const base: BaseTelemetry = {
      v: 1,
      device_id: BASE_ID,
      cup_id: CUP_ID,
      ts: now,
      seq: this.seq,
      weight_g: round1(285 + this.levelMl),
      stable: true,
      present: motion !== 'lifted',
      temp_c: round1(this.tempC),
      charging: true,
      battery_pct: 100,
    };

    const pending = this.events;
    this.events = [];
    this.em.emit('frame', { lid, base, events: pending } satisfies LiveFrame);
  }
}

/** 按循环相位给出 motion / 倾角 / 是否在摇 */
function phaseState(
  phase: number,
  _t0: number,
  _now: number,
): { motion: LidTelemetry['motion']; tiltDeg: number; tiltDir: number; shake: boolean } {
  // 12–15s:摇杯
  if (phase >= 12 && phase < 15) {
    return { motion: 'shake', tiltDeg: 0, tiltDir: 0, shake: true };
  }
  // 15–21s:从 0° 平滑倾到右倾 40°,再回到 0°
  if (phase >= 15 && phase < 21) {
    const k = phase - 15; // 0..6
    const tri = k < 3 ? k / 3 : (6 - k) / 3; // 0→1→0
    return { motion: 'tilt', tiltDeg: 40 * tri, tiltDir: 0, shake: false };
  }
  // 21–24s:向左倾 40° 再回正
  if (phase >= 21 && phase < 24) {
    const k = phase - 21; // 0..3
    const tri = k < 1.5 ? k / 1.5 : (3 - k) / 1.5;
    return { motion: 'tilt', tiltDeg: 40 * tri, tiltDir: 180, shake: false };
  }
  return { motion: 'idle', tiltDeg: 0, tiltDir: 0, shake: false };
}

/** 近似高斯噪声(Box-Muller),给 IMU 抖动用 */
function gauss(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function ev(type: CupEvent['type'], extra: Partial<CupEvent>): CupEvent {
  return {
    v: 1,
    cup_id: CUP_ID,
    device_id: LID_ID,
    ts: Date.now(),
    type,
    confidence: 0.95,
    derived_by: 'lid',
    ...extra,
  };
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** mock 下的"答复" —— 按问句关键词回,数字真实取自当前遥测 */
function mockAnswer(q: string, levelPct: number, tempC: number): string {
  const s = q.trim();
  if (/水|喝|渴/.test(s)) {
    return levelPct < 30
      ? `就剩 ${levelPct}%,你还问?……哼,再不续水我就渴着。`
      : `还有 ${levelPct}%,够你喝一阵的。水温 ${tempC}°C,别嫌。`;
  }
  if (/热|冷|温|烫/.test(s)) {
    return `现在 ${tempC}°C。${tempC >= 55 ? '有点烫,吹吹再喝。' : tempC <= 30 ? '温吞吞的,凑合。' : '正合适。'}`;
  }
  if (/你好|在吗|嗨|hi|hello/i.test(s)) {
    return '……在呢。有话快说,我忙着发光。';
  }
  return '这种问题,等我连上后端再认真答你。';
}
