/**
 * 硬件脸功耗估算面板(创意备忘 §4.3 第 3 步)。
 *
 * "今天这样用,电池几天" —— 按状态时长 × 各方案电流算出来,选型不再靠猜。
 * 纯展示:计算全在 lib/power.ts(已单测),这里只排版。
 */
import { useMemo, useState } from 'react';
import {
  estimateAll,
  defaultProfile,
  verdict,
  STATE_NAME,
  BATTERY_MAH,
  DEVICE_BUDGET_MAH_PER_DAY,
  type PowerBreakdown,
} from '../lib/power.ts';

const TONE_CLASS: Record<'dead' | 'poor' | 'ok' | 'great', string> = {
  dead: 'bg-red-100 text-red-800',
  poor: 'bg-amber-100 text-amber-800',
  ok: 'bg-sky-100 text-sky-800',
  great: 'bg-emerald-100 text-emerald-800',
};

function fmt(v: number): string {
  if (v === 0) return '0';
  if (v < 0.01) return v.toExponential(1);
  if (v < 1) return v.toFixed(2);
  return v.toFixed(1);
}

function Row({ r }: { r: PowerBreakdown }) {
  const v = verdict(r.days);
  return (
    <div className="flex items-center justify-between gap-2 border-b border-cup-veil/40 py-1.5 text-xs last:border-0">
      <div className="min-w-0">
        <p className="truncate font-medium text-cup-ink">{r.name}</p>
        <p className="truncate text-cup-ink-soft">{r.note}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-right tabular-nums text-cup-ink-soft">{fmt(r.dailyMah)} mAh/天</span>
        <span className={`rounded px-1.5 py-0.5 tabular-nums ${TONE_CLASS[v.tone]}`}>
          {r.days < 100 ? r.days.toFixed(1) : r.days.toFixed(0)} 天
        </span>
        {!r.canBlink && <span className="rounded bg-black/70 px-1 py-0.5 text-[10px] text-white">不能眨眼</span>}
      </div>
    </div>
  );
}

export function PowerPanel() {
  const profile = useMemo(() => defaultProfile(), []);
  const rows = useMemo(() => estimateAll(profile), [profile]);
  const [open, setOpen] = useState(false);

  // 默认等高亮 Memory LCD 那一行(向用户点出结论),不随每次重渲染抖
  const best = rows.find((r) => r.key === 'memory-lcd');

  const usedHours = Object.values(profile.hours).reduce((a, b) => a + b, 0);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-cup-ink-soft">
        按「{profile.name}」({usedHours.toFixed(1)}h 用脸)估算:
        设备基线 {DEVICE_BUDGET_MAH_PER_DAY} mAh/天({BATTERY_MAH}mAh ÷ 62 天)+ 本脸额外。
        <span className="text-cup-ink-soft/70"> 电流/刷新均为备忘估算,真机回填。</span>
      </p>
      <div className="rounded-lg bg-white/50 px-3 py-1 ring-1 ring-cup-veil/40">
        {rows.map((r) => (
          <Row key={r.key} r={r} />
        ))}
      </div>
      {best && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="self-start rounded text-xs text-cup-deep underline decoration-dotted hover:text-cup-ink"
        >
          {open ? '收起' : `展开「Memory LCD」逐状态拆解(结论:${best.days.toFixed(0)} 天)`}
        </button>
      )}
      {open && best && (
        <table className="w-full text-[11px] text-cup-ink">
          <thead>
            <tr className="text-cup-ink-soft">
              <th className="text-left font-medium">状态</th>
              <th className="text-right font-medium">时长 h</th>
              <th className="text-right font-medium">耗时 mAh</th>
            </tr>
          </thead>
          <tbody>
            {best.parts
              .filter((p) => p.hours > 0)
              .sort((a, b) => b.mah - a.mah)
              .map((p) => (
                <tr key={p.state}>
                  <td className="text-left">{STATE_NAME[p.state]}</td>
                  <td className="text-right tabular-nums">{p.hours.toFixed(2)}</td>
                  <td className="text-right tabular-nums">{fmt(p.mah)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
