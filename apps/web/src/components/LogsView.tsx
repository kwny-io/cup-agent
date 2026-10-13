/**
 * 服务日志回看(admin / ops / reviewer)—— 独立 Tab,与「管理」平级。
 *
 * 所有接口走后端 `/admin/*`(会话 + 角色双守卫):读日志 admin/ops/reviewer 都可,
 * 触发保留(写)仅 admin/ops。**前端不做安全边界** —— 只做"不给按不动的按钮"的体验,
 * 真边界在服务端 403(与 AdminPanel 同口径)。
 *
 * 数据源走 SocialApi 假实现即可独立开发 + 测试(不必等服务端合入)。
 * 配色一律走 cup-* token,不硬编码颜色。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Chip, TextField } from './ui.tsx';
import type { LogLevel, LogPartition, LogRow, LogQuery, PublicUser, SocialApi } from '../data/source.ts';

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** error/warn 用 ember(warm)醒目,info/debug 中性(cool)—— 仍走 Chip 的两档 tone。 */
function LevelBadge({ level }: { level: LogLevel }) {
  return level === 'error' || level === 'warn' ? (
    <Chip tone="warm">{level}</Chip>
  ) : (
    <Chip>{level}</Chip>
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 本地时间 `YYYY-MM-DD HH:mm:ss`(固定格式,不吃 locale)。 */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/** `YYYY-MM-DD`(date 输入的值)→ 当天 00:00 的 unix ms;空/非法 → undefined(不入查询)。 */
function dayStartMs(s: string): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

/** 同理到当天 23:59:59.999 —— 选到某天即"含全天"。 */
function dayEndMs(s: string): number | undefined {
  const t = dayStartMs(s);
  return t === undefined ? undefined : t + 86_399_999;
}

export function LogsView({ social, role }: { social: SocialApi; role: PublicUser['role'] }) {
  // ops 可动手(触发保留 / 看分区);reviewer 只读 → 隐藏这些按钮
  const canRetain = role === 'admin' || role === 'ops';

  const [levels, setLevels] = useState<LogLevel[]>([]);
  const [src, setSrc] = useState('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [rows, setRows] = useState<LogRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [parts, setParts] = useState<LogPartition[] | null>(null);
  const [retainMsg, setRetainMsg] = useState<string | null>(null);

  /** 当前筛选 → LogQuery(空的筛选一律不带,避免把空串当条件发出去)。 */
  function makeQuery(): LogQuery {
    const f = dayStartMs(from);
    const t = dayEndMs(to);
    return {
      ...(levels.length > 0 ? { level: levels } : {}),
      ...(src ? { src } : {}),
      ...(q ? { q } : {}),
      ...(f !== undefined ? { from: f } : {}),
      ...(t !== undefined ? { to: t } : {}),
    };
  }

  const runQuery = useCallback(async () => {
    setErr(null);
    setBusy(true);
    const page = await social.adminListLogs({ ...makeQuery(), limit: 100 });
    if (page === null) {
      setErr('加载失败(需要 admin / ops / reviewer 会话)');
    } else {
      setRows(page.rows);
      setCursor(page.next_cursor);
    }
    setLoaded(true);
    setBusy(false);
    // makeQuery 读的是上面的筛选 state;显式列出作为依赖
  }, [social, levels, src, q, from, to]);

  const loadMore = useCallback(async () => {
    if (cursor === null) return;
    setBusy(true);
    const page = await social.adminListLogs({ ...makeQuery(), limit: 100, cursor });
    if (page !== null) {
      setRows((prev) => [...prev, ...page.rows]);
      setCursor(page.next_cursor);
    }
    setBusy(false);
  }, [social, cursor, levels, src, q, from, to]);

  const loadParts = useCallback(async () => {
    setParts(await social.adminLogPartitions());
  }, [social]);

  // 首次进页只拉一页(空筛选);之后靠「查询」按钮显式触发 —— 输关键词不打字即刷
  useEffect(() => {
    let alive = true;
    void (async () => {
      const page = await social.adminListLogs({ limit: 100 });
      if (!alive) return;
      if (page === null) setErr('加载失败(需要 admin / ops / reviewer 会话)');
      else {
        setRows(page.rows);
        setCursor(page.next_cursor);
      }
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, [social]);
  useEffect(() => {
    if (canRetain) void loadParts();
  }, [canRetain, loadParts]);

  function toggleLevel(lv: LogLevel): void {
    setLevels((prev) => (prev.includes(lv) ? prev.filter((x) => x !== lv) : [...prev, lv]));
  }

  async function retain(): Promise<void> {
    setRetainMsg(null);
    const dropped = await social.adminRetainLogs();
    if (dropped === null) {
      setRetainMsg('触发失败(需要 admin / ops 身份)');
    } else {
      setRetainMsg(dropped.length > 0 ? `已删除 ${dropped.length} 个过期分区` : '没有过期分区可删');
      await loadParts(); // 删完刷新占用
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      <h2 className="text-base font-bold text-cup-deep">服务日志</h2>
      {err && (
        <p className="text-xs text-cup-ember" role="alert">
          {err}
        </p>
      )}

      <Card title="筛选">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-cup-ink-soft">级别</span>
            {LEVELS.map((lv) => (
              <button
                key={lv}
                type="button"
                aria-pressed={levels.includes(lv)}
                onClick={() => toggleLevel(lv)}
                className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 transition ${
                  levels.includes(lv)
                    ? 'bg-cup-deep text-cup-mist ring-cup-deep'
                    : 'text-cup-ink-soft ring-cup-veil hover:bg-cup-foam'
                }`}
              >
                {lv}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <TextField
              aria-label="来源"
              placeholder="来源(src)"
              value={src}
              onChange={(e) => setSrc(e.target.value)}
            />
            <TextField
              aria-label="关键词"
              placeholder="关键词(msg)"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <TextField
              aria-label="起始时间"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <span className="text-xs text-cup-ink-soft">至</span>
            <TextField
              aria-label="结束时间"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
            <Button onClick={() => void runQuery()} disabled={busy}>
              查询
            </Button>
          </div>
        </div>
      </Card>

      <Card title="日志" hint={`${rows.length} 条`}>
        {loaded && rows.length === 0 ? (
          <p className="py-4 text-center text-xs text-cup-ink-soft">没有匹配的日志</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rows.map((r, i) => (
              <li
                key={`${r.ts}-${i}`}
                className="rounded-xl bg-white/70 px-3 py-2 ring-1 ring-cup-veil/50"
              >
                <div className="flex items-center gap-2">
                  <span className="tabular-nums text-xs text-cup-ink-soft">{fmtTime(r.ts)}</span>
                  <LevelBadge level={r.level} />
                  {r.src && <span className="truncate text-xs text-cup-ink-soft">{r.src}</span>}
                </div>
                <div className="mt-0.5 break-words text-sm text-cup-ink">{r.msg}</div>
                {Object.keys(r.payload).length > 0 && (
                  <div className="mt-1 break-all font-mono text-xs text-cup-ink-soft">
                    {JSON.stringify(r.payload)}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {cursor !== null && (
          <div className="mt-3 flex justify-center">
            <Button tone="ghost" onClick={() => void loadMore()} disabled={busy}>
              加载更多
            </Button>
          </div>
        )}
      </Card>

      {canRetain && (
        <Card title="运维" hint="分区与保留(90 天)">
          {parts === null ? (
            <p className="py-2 text-center text-xs text-cup-ink-soft">分区信息需连后端</p>
          ) : parts.length === 0 ? (
            <p className="py-2 text-center text-xs text-cup-ink-soft">暂无分区</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {parts.map((p) => (
                <li
                  key={p.name}
                  className="flex items-center justify-between rounded-xl bg-white/70 px-3 py-1.5 text-xs ring-1 ring-cup-veil/50"
                >
                  <span className="truncate font-mono text-cup-ink">{p.name}</span>
                  <span className="tabular-nums text-cup-ink-soft">{fmtBytes(p.bytes)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex items-center gap-3">
            <Button tone="ghost" onClick={() => void retain()}>
              触发保留清理
            </Button>
            {retainMsg && (
              <span className="text-xs text-cup-ink-soft" role="status">
                {retainMsg}
              </span>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
