/**
 * 宽屏悬浮杯 —— 杯子浮在看板上,默认右下角,可拖,可收成小圆点。
 *
 * 交互(架构 §6.4):
 *   拖 body   移动;位置存 localStorage,刷新后还在
 *   拖 >6px   视为拖动,不触发点击(点击才收/展)
 *   点小圆点  弹回杯子
 *
 * 注意:这里只管"外壳行为";杯子的画法在 CupWidget 里,与悬浮无关。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CupWidget } from './CupWidget.tsx';
import type { Disposition } from '../lib/mood.ts';
import type { PersonaPack } from '../data/source.ts';
import type { BaseTelemetry, LidTelemetry } from '@cup/contract';

const POS_KEY = 'cup.widget.pos';
const SIZE = 180;
const DOT = 44;
const DRAG_SLOP = 6; // 位移超过这个像素才算拖动

interface Pos {
  x: number;
  y: number;
}

function loadPos(): Pos | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    return raw ? (JSON.parse(raw) as Pos) : null;
  } catch {
    return null;
  }
}

export function FloatingCup({
  lid,
  base,
  disposition,
  pack,
}: {
  lid?: LidTelemetry;
  base?: BaseTelemetry;
  /** 长期性格底色(透传给 CupWidget) */
  disposition?: Disposition;
  /** 当前生效人格包(透传给 CupWidget) */
  pack?: PersonaPack | null;
}) {
  const [pos, setPos] = useState<Pos | null>(loadPos);
  const [collapsed, setCollapsed] = useState(false);
  // 当前拖拽会话:pointerdown 的位置 + 是否已越过拖动阈值
  const drag = useRef<{ ox: number; oy: number; dx: number; dy: number } | null>(null);
  // 本次交互是否发生过拖动 —— 拖动过就吞掉随后的 click,避免误收/展
  const draggedRef = useRef(false);
  const posRef = useRef<Pos | null>(pos);
  posRef.current = pos;

  // 默认位置:右下角(挂载后按视口算一次)
  useEffect(() => {
    if (pos) return;
    setPos({ x: window.innerWidth - SIZE - 24, y: window.innerHeight - SIZE - 24 });
  }, [pos]);

  // 视口变化时把杯子夹回可见区
  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clampToViewport(p) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const start = posRef.current ?? { x: 0, y: 0 };
    draggedRef.current = false;
    drag.current = {
      ox: e.clientX,
      oy: e.clientY,
      dx: e.clientX - start.x,
      dy: e.clientY - start.y,
    };
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      // 指针已失效(如测试里的合成事件):不捕获也能拖,忽略
    }
    document.body.classList.add('cup-dragging');
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    // 以起点位移判定"是否真的在拖",而非看 clamp 结果
    if (Math.abs(e.clientX - d.ox) > DRAG_SLOP || Math.abs(e.clientY - d.oy) > DRAG_SLOP) {
      draggedRef.current = true;
    }
    if (!draggedRef.current) return;
    setPos(clampToViewport({ x: e.clientX - d.dx, y: e.clientY - d.dy }));
  }, []);

  const endDrag = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    document.body.classList.remove('cup-dragging');
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      // 未捕获过指针:忽略
    }
    if (d && draggedRef.current) {
      // 拖完了:落盘当前位置(用 ref,避免闭包里的 pos 过期)
      if (posRef.current) localStorage.setItem(POS_KEY, JSON.stringify(posRef.current));
      // 只吞掉"紧随这次拖动"的一个 click,之后自动复位
      setTimeout(() => {
        draggedRef.current = false;
      }, 0);
    }
  }, []);

  // 收/展走 click(而非 pointerup),这样鼠标、键盘、辅助技术都能触发
  const onClick = useCallback(() => {
    if (draggedRef.current) return; // 拖动末尾的那一次 click,忽略
    setCollapsed((c) => !c);
  }, []);

  if (!pos) return null;

  return (
    <div
      className="fixed z-40 select-none"
      style={{
        left: pos.x,
        top: pos.y,
        width: collapsed ? DOT : SIZE,
        height: collapsed ? DOT : SIZE,
        touchAction: 'none',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={onClick}
    >
      {collapsed ? (
        <div
          className="grid h-full w-full cursor-grab place-items-center rounded-full bg-white shadow-lg ring-1 ring-cup-veil"
          title="展开杯子"
        >
          <span className="text-lg">💧</span>
        </div>
      ) : (
        <div className="cursor-grab rounded-cup-lg bg-white/70 p-1 shadow-xl ring-1 ring-cup-veil/70 backdrop-blur">
          <CupWidget lid={lid} base={base} size={SIZE - 8} disposition={disposition} pack={pack} />
        </div>
      )}
    </div>
  );
}

function clampToViewport(p: Pos): Pos {
  return {
    x: Math.min(Math.max(0, window.innerWidth - SIZE), Math.max(0, p.x)),
    y: Math.min(Math.max(0, window.innerHeight - SIZE), Math.max(0, p.y)),
  };
}
