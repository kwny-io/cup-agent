/**
 * 128×128 单色点阵预览 —— "盖子上会是什么样"(创意备忘 §4.3 第 2 步)。
 *
 * 拿到真屏之前就把动画调好:面板 1:1 显示 128×128,黑底白线,
 * 输入与真机同源(同一份 eyes.ts 姿态 + eye-render.ts 点阵)。
 *
 * 与 CupWidget 同款:遥测/姿态走 ref,rAF 里读最新值,不让低频数据触发重渲染。
 */
import { useEffect, useRef, useState } from 'react';
import { Eyes, EYE_STATE_LABEL, type EyeState, type EyeDisposition, type EyeInputs, type FaceOwner } from '../lib/eyes.ts';
import { renderEyeGrid, EYE_W, EYE_H } from '../lib/eye-render.ts';
import { Gestures, GESTURE_RESPONSES, GESTURE_LABEL, latestTapTs, type Gesture } from '../lib/gesture.ts';
import { FIXED_DT } from '../lib/water.ts';
import { packRenderParams, type PackRenderParams } from '../lib/pack-render.ts';
import type { PersonaPack } from '../data/source.ts';
import type { BaseTelemetry, CupEvent, LidTelemetry } from '@cup/contract';

interface Props {
  lid?: LidTelemetry;
  base?: BaseTelemetry;
  /** 近期事件流 —— 供手势识别器挑出轻磕/长按(契约 tap/long_press) */
  events?: CupEvent[];
  /** 长期性格底色(后端战报给) */
  disposition?: EyeDisposition;
  /** 显示尺寸(CSS px);缺省 128 = 1:1 */
  size?: number;
  /** 当前生效的人格包(P4.2);缺省 / null → 出厂体质。只影响表情阈值(contentS) */
  pack?: PersonaPack | null;
}

/** 一个"喝了一口"的检测阈值(水位掉 ≥2 个百分点),与 CupWidget 的 noteSip 口径一致 */
const SIP_DROP = 2;

/** 手势台词 + 强制表情的展示时长(秒):与备忘"每动作 ≤1 句"同气口,数秒后自散 */
const GESTURE_HOLD_S = 3;

export function EyePreview({ lid, base, events, disposition = 'normal', size = EYE_W, pack = null }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const telemetry = useRef<{ lid?: LidTelemetry; base?: BaseTelemetry }>({ lid, base });
  telemetry.current = { lid, base };
  const eventsRef = useRef<CupEvent[]>(events ?? []);
  eventsRef.current = events ?? [];
  const dispRef = useRef<EyeDisposition>(disposition);
  dispRef.current = disposition;
  // 生效包走 ref:换包不重建画布,simulate 里换参数即可
  const paramsRef = useRef<PackRenderParams>(packRenderParams(pack));
  paramsRef.current = packRenderParams(pack);
  // 状态标签低频更新(只在状态变化时 setState,不随 rAF 抖)
  const [state, setState] = useState<EyeState>('idle');
  const stateRef = useRef<EyeState>('idle');
  // 手势语法 §5.1 #1:最近识别到的手势(驱动预览里的"它刚说了什么")
  const [gesture, setGesture] = useState<Gesture | null>(null);
  // 谁持有脸(交接协议 §1.3):true = 屏幕接管 → 盖子缓慢闭眼。手动切换以预览"签名时刻"
  const [toScreen, setToScreen] = useState(false);
  const ownerRef = useRef<FaceOwner>('lid');
  ownerRef.current = toScreen ? 'screen' : 'lid';

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = EYE_W * dpr;
    canvas.height = EYE_H * dpr;

    const eyes = new Eyes();
    const gestures = new Gestures();
    // 手势台词/强制表情的剩余展示时长;到点清空预览
    let gestureT = 0;
    // 事件计时:idleSec(距上次事件)/ forgotSec(距上次一线活跃)
    let idleSec = 0;
    let forgotSec = 0;
    let lastLevelPct: number | null = null;
    let lastMotion: string | null = null;
    let lastBattery: number | null = null;
    let lastTemp: number | null = null;
    // 轻磕/长按:已消费到的事件时间戳(契约 tap/long_press;避免同一事件每帧重复喂)
    let seenTapTs = 0;
    // 上一帧的 lid 快照,用来判"这一帧有没有新东西发生"
    let prevLid: LidTelemetry | undefined;
    let prevBase: BaseTelemetry | undefined;

    let raf = 0;
    let last = performance.now();
    let acc = 0;

    const simulate = (dt: number) => {
      const { lid: l, base: b } = telemetry.current;

      // 事件检测:遥测变了(新帧)→ 刷新 idle;有真事件则更明确
      const changed = l !== prevLid || b !== prevBase;
      prevLid = l;
      prevBase = b;
      if (changed) {
        idleSec = 0;
        forgotSec = 0;
      } else {
        idleSec += dt;
        forgotSec += dt;
      }

      // 被喝:水位掉一档 → 满足
      const pct = l?.level_pct ?? null;
      if (pct !== null && lastLevelPct !== null && lastLevelPct - pct >= SIP_DROP) eyes.noteDrink();
      if (pct !== null) lastLevelPct = pct;

      // 运动/电量突变也算"有动静"
      const motion = l?.motion ?? null;
      if (motion !== null && motion !== lastMotion && motion !== 'idle') {
        idleSec = 0;
        forgotSec = 0;
      }
      lastMotion = motion;
      const bat = l?.battery_pct ?? null;
      if (bat !== null && lastBattery !== null && Math.abs(bat - lastBattery) >= 1) {
        idleSec = 0;
        forgotSec = 0;
      }
      lastBattery = bat;

      // 水温突变也算"有动静"(续了杯热水 → 蒸汽纹;加分项)
      const temp = l?.temp_c ?? null;
      if (temp !== null && lastTemp !== null && Math.abs(temp - lastTemp) >= 1) {
        idleSec = 0;
        forgotSec = 0;
      }
      lastTemp = temp;

      // 手势语法 §5.1 #1:从**现有** motion/tilt 遥测边沿切出手势 → ≤1 句 + 1 个表情
      // 轻磕/长按(契约 tap/long_press 事件)先喂进识别器:挑出新的一次 → noteTap()
      const tapTs = latestTapTs(eventsRef.current, seenTapTs);
      if (tapTs !== null) {
        seenTapTs = tapTs;
        gestures.noteTap();
      }
      const gestureHit = gestures.step(dt, { motion: motion ?? 'idle', tiltDeg: l?.tilt_deg ?? 0 });
      if (gestureHit) {
        const resp = GESTURE_RESPONSES[gestureHit];
        eyes.noteExpression(resp.state, GESTURE_HOLD_S);
        gestureT = GESTURE_HOLD_S;
        setGesture(gestureHit);
      } else if (gestureT > 0) {
        gestureT = Math.max(0, gestureT - dt);
        if (gestureT === 0) setGesture(null);
      }

      const inp: EyeInputs = {
        owner: ownerRef.current,
        motion,
        tiltDeg: l?.tilt_deg ?? 0,
        tiltDir: l?.tilt_dir ?? 0,
        batteryPct: bat,
        charging: l?.charging ?? false,
        level01: (l?.level_pct ?? 0) / 100,
        tempC: temp,
        disposition: dispRef.current,
        idleSec,
        forgotSec,
      };
      eyes.setParams(paramsRef.current.eye);
      eyes.step(dt, inp);
      if (eyes.current !== stateRef.current) {
        stateRef.current = eyes.current;
        setState(eyes.current);
      }
    };

    const render = () => {
      const grid = renderEyeGrid(eyes.currentPose);
      const img = ctx.createImageData(EYE_W, EYE_H);
      for (let i = 0; i < grid.length; i++) {
        const v = grid[i] ? 235 : 18; // 白字 / 近黑底(冷青一档更贴设备)
        img.data[i * 4] = v;
        img.data[i * 4 + 1] = v;
        img.data[i * 4 + 2] = v;
        img.data[i * 4 + 3] = 255;
      }
      // 先画到离屏像素再放大,保证点阵边缘硬朗(1:1 时无缩放,直接 put)
      if (dpr === 1 && size === EYE_W) {
        ctx.putImageData(img, 0, 0);
      } else {
        const off = document.createElement('canvas');
        off.width = EYE_W;
        off.height = EYE_H;
        off.getContext('2d')!.putImageData(img, 0, 0);
        ctx.setTransform(dpr * (size / EYE_W), 0, 0, dpr * (size / EYE_W), 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(off, 0, 0);
      }
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      let dt = (now - last) / 1000;
      last = now;
      if (dt > 0.1) dt = 0.1;
      acc += dt;
      let steps = 0;
      while (acc >= FIXED_DT && steps < 16) {
        simulate(FIXED_DT);
        acc -= FIXED_DT;
        steps++;
      }
      if (steps >= 16) acc = 0;
      render();
    };

    simulate(FIXED_DT);
    render();
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <div className="flex flex-col items-center gap-2">
      <canvas
        ref={ref}
        style={{ width: size, height: size, imageRendering: 'pixelated' }}
        className="rounded-lg ring-1 ring-black/40"
        aria-label="杯盖眼睛预览"
      />
      <p className="text-xs text-cup-ink-soft">
        128×128 单色点阵 · {EYE_STATE_LABEL[state]}
      </p>
      <p className="min-h-[1.25rem] max-w-[16rem] text-center text-xs" aria-live="polite">
        {gesture ? (
          <>
            <span className="text-cup-aqua">{GESTURE_LABEL[gesture]}</span>
            <span className="text-cup-ink">「{GESTURE_RESPONSES[gesture].line}」</span>
          </>
        ) : (
          <span className="text-cup-ink-soft">摇一摇 / 歪一歪 / 拿起来再放下</span>
        )}
      </p>
      <button
        type="button"
        onClick={() => setToScreen((v) => !v)}
        className="rounded-full px-3 py-1 text-xs ring-1 ring-cup-veil/60 hover:bg-cup-veil/20"
        aria-pressed={toScreen}
      >
        {toScreen ? '脸在屏幕上(盖子闭眼中)' : '脸在盖子上(点我交接)'}
      </button>
    </div>
  );
}
