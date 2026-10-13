/**
 * 「回忆」卡 —— 长期记忆的**唯一消费者**(消费 `GET /cups/:id/memory` + `DELETE`)。
 *
 * 后端早就把"一天"封存成记忆卡,但一直没有界面。这张卡把它产品化成**能翻的回忆**:
 *   · 一起第 N 天 / 连续在场 N 天 / 共几天的回忆(纯前端从日键换算,见 lib/memories.ts);
 *   · 那年今日(同月同日的往年卡,挑出来高亮);
 *   · 封存今天(点一下按需补封今天的卡 —— 幂等,那天没数据就不建空卡);
 *   · 逐日时间线(新→旧):一句话标题 + 数值 + 显著事件 + 身体线索 + 对话蒸馏;
 *   · 导出回忆录(Canvas 2D 长图,零依赖,同养成卡);
 *   · 三档删除(聊过什么 / 那些日子 / 全部)—— 两步确认,不手滑。
 *
 * 数字全来自后端卡,前端只筛选 / 换算 / 起名。**不进看板** —— 它要登录 + 后端,
 * 与"看今天喝了多少"是两条线,故单独一屏(见 MemoriesView)。
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Card, Chip } from '../ui.tsx';
import { buildMemoirCard, cardHeight, CARD_W, drawCard, downloadCanvas } from '../../lib/card-render.ts';
import {
  buildMemoirLines,
  cardSummary,
  cardTitle,
  cueLabel,
  currentCardStreak,
  daysTogether,
  eventLabel,
  localDayKey,
  memoryDateLabel,
  onThisDay,
} from '../../lib/memories.ts';
import type { MemoryCard, SocialApi } from '../../data/source.ts';

type DeleteScope = 'conversation' | 'memory' | 'all';

const SCOPE_CN: Record<DeleteScope, string> = {
  conversation: '聊过什么',
  memory: '那些日子',
  all: '全部',
};

export function MemoriesCard({ social, enabled }: { social: SocialApi | null; enabled: boolean }) {
  const [cards, setCards] = useState<MemoryCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState<DeleteScope | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const today = localDayKey();

  useEffect(() => {
    if (!enabled || !social) return;
    let alive = true;
    setLoading(true);
    void social.getMemory({ all: true }).then((c) => {
      if (!alive) return;
      setCards(c);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [social, enabled]);

  if (!enabled || !social) {
    return (
      <Card title="回忆" hint="需连后端">
        <p className="py-6 text-center text-xs text-cup-ink-soft">
          回忆要后端封存的记忆卡和账号(用 ?cloud=1 连上并登录)
        </p>
      </Card>
    );
  }

  async function sealToday(): Promise<void> {
    if (!social) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const c = await social.getMemory({ all: true, buildToday: true });
      setCards(c);
      setNote(c.some((x) => x.date === today) ? '今天已封存进回忆' : '今天还没有可封存的事,先喝口水吧');
    } finally {
      setBusy(false);
    }
  }

  function exportMemoir(): void {
    const canvas = canvasRef.current;
    if (!canvas || cards.length === 0) return;
    const model = buildMemoirCard(buildMemoirLines(cards), memoryDateLabel(today));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = CARD_W;
    canvas.height = cardHeight(model);
    drawCard(ctx, model, CARD_W);
    downloadCanvas(canvas, `cup-memoir-${today}.png`);
  }

  async function doDelete(scope: DeleteScope): Promise<void> {
    if (!social) return;
    setBusy(true);
    setPending(null);
    try {
      const ok = await social.deleteMemory(scope);
      if (ok) {
        const c = await social.getMemory({ all: true });
        setCards(c);
        setNote(`已清空「${SCOPE_CN[scope]}」`);
      } else {
        setError('删除失败(可能未登录或后端拒绝)');
      }
    } finally {
      setBusy(false);
    }
  }

  const together = daysTogether(cards, today);
  const streak = currentCardStreak(cards, today);
  const memory = onThisDay(cards, today);

  return (
    <Card title="回忆" hint={cards.length > 0 ? `共 ${cards.length} 天` : '还没有'}>
      {loading ? (
        <p className="py-6 text-center text-xs text-cup-ink-soft">正在翻…</p>
      ) : cards.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <p className="text-xs text-cup-ink-soft">还没有回忆 —— 杯子喝几天水,后端每天封一张卡</p>
          <Button tone="ghost" disabled={busy} onClick={() => void sealToday()}>
            封存今天
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* 概览:一起第 N 天 / 连续在场 / 共几天 */}
          <div className="grid grid-cols-3 gap-2">
            <Stat label="一起" value={together !== null ? `第 ${together} 天` : '—'} />
            <Stat label="连续在场" value={`${streak} 天`} />
            <Stat label="回忆" value={`${cards.length} 天`} />
          </div>

          {/* 那年今日 */}
          {memory && (
            <div className="rounded-2xl bg-cup-warm/15 p-3 ring-1 ring-cup-warm/40">
              <div className="mb-1 flex items-center gap-2">
                <Chip tone="warm">那年今日</Chip>
                <span className="text-xs text-cup-ink-soft">{memoryDateLabel(memory.date)}</span>
              </div>
              <p className="text-sm font-medium text-cup-deep">{cardTitle(memory)}</p>
              <p className="mt-0.5 text-xs text-cup-ink-soft">{cardSummary(memory)}</p>
              {memory.details.turns_summary && (
                <p className="mt-1 text-xs text-cup-ink-soft">「{memory.details.turns_summary}」</p>
              )}
            </div>
          )}

          {/* 动作 */}
          <div className="flex flex-wrap items-center gap-2">
            <Button tone="ghost" disabled={busy} onClick={() => void sealToday()}>
              封存今天
            </Button>
            <Button tone="ghost" disabled={busy || cards.length === 0} onClick={exportMemoir}>
              导出回忆录
            </Button>
          </div>

          {note && (
            <p className="text-xs text-cup-aqua" role="status">
              {note}
            </p>
          )}
          {error && (
            <p className="text-xs text-cup-ember" role="alert">
              {error}
            </p>
          )}

          {/* 逐日时间线(新→旧) */}
          <ul className="flex flex-col gap-2 border-t border-cup-veil/60 pt-3">
            {cards.map((c) => (
              <MemoryDay key={c.date} card={c} today={today} />
            ))}
          </ul>

          {/* 三档删除(两步确认) */}
          <div className="flex flex-col gap-2 border-t border-cup-veil/60 pt-3">
            <span className="text-xs text-cup-ink-soft">清理(不可撤销)</span>
            <div className="flex flex-wrap items-center gap-2">
              {(['conversation', 'memory', 'all'] as DeleteScope[]).map((s) =>
                pending === s ? (
                  <Button key={s} disabled={busy} onClick={() => void doDelete(s)}>
                    确认清空「{SCOPE_CN[s]}」
                  </Button>
                ) : (
                  <Button key={s} tone="ghost" disabled={busy} onClick={() => setPending(s)}>
                    清空{SCOPE_CN[s]}
                  </Button>
                ),
              )}
            </div>
            {pending && (
              <button className="self-start text-xs text-cup-ink-soft underline" onClick={() => setPending(null)}>
                取消
              </button>
            )}
          </div>
        </div>
      )}

      <canvas ref={canvasRef} className="hidden" aria-hidden="true" />
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white/70 px-2 py-1.5 text-center ring-1 ring-cup-veil/50">
      <div className="text-[10px] text-cup-ink-soft">{label}</div>
      <div className="text-sm font-semibold text-cup-deep">{value}</div>
    </div>
  );
}

/** 时间线里的一天 */
function MemoryDay({ card, today }: { card: MemoryCard; today: string }) {
  const d = card.details;
  return (
    <li className="rounded-2xl bg-white/60 p-3 ring-1 ring-cup-veil/50">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-cup-deep">
          {memoryDateLabel(card.date)}
          {card.date === today && <span className="ml-1 text-cup-aqua">· 今天</span>}
        </span>
        <span className="text-[10px] text-cup-ink-soft">{cardSummary(card)}</span>
      </div>
      <p className="mt-0.5 text-sm text-cup-ink">{cardTitle(card)}</p>

      {d.notable_events.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {d.notable_events.map((e, i) => (
            <span key={i} className="rounded-full bg-cup-foam px-2 py-0.5 text-[10px] text-cup-ink-soft">
              {eventLabel(e.type)}
            </span>
          ))}
        </div>
      )}

      {d.body_cues.length > 0 && (
        <p className="mt-1 text-[10px] text-cup-ink-soft">
          它那天:{d.body_cues.map((c) => cueLabel(c.cue)).join('、')}
        </p>
      )}

      {d.turns_summary && (
        <p className="mt-1 text-xs text-cup-ink-soft">「{d.turns_summary}」</p>
      )}
      {d.refill_count > 0 && (
        <p className="mt-0.5 text-[10px] text-cup-ink-soft">续了 {d.refill_count} 次水</p>
      )}
    </li>
  );
}
