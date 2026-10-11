/**
 * 杯子社交卡(#74)—— 好友互见 + 组队 streak + 分享卡。
 *
 * 隐私口径(与迁移码 / #72 档案同一套):好友之间**只互见派生性格 + streak + 昵称**,
 * 看不到对方的原始饮水曲线、聊天记录。后端出口视图(FriendView)就没有那些字段 ——
 * 前端不是"藏起来",而是**根本没拿到**。
 *
 * 分享卡用与养成卡同一套 Canvas 2D 绘制助手(lib/card-render.ts 的 buildShareCard)。
 * 真实 click 提交(铁律)。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, TextField } from '../ui.tsx';
import { buildShareCard, cardHeight, CARD_W, drawCard, downloadCanvas } from '../../lib/card-render.ts';
import type { PublicUser, SocialApi } from '../../data/source.ts';
import type { FriendView, TeamState } from '../../data/source.ts';

export function FriendsCard({
  social,
  enabled,
  user,
}: {
  social: SocialApi | null;
  enabled: boolean;
  user: PublicUser | null;
}) {
  const [friends, setFriends] = useState<FriendView[]>([]);
  const [team, setTeam] = useState<TeamState | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const reload = useCallback(async () => {
    if (!social) return;
    const [fs, t] = await Promise.all([social.listFriends(), social.getTeam()]);
    setFriends(fs);
    setTeam(t);
  }, [social]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!enabled || !social) {
    return (
      <Card title="杯子社交" hint="需连后端">
        <p className="py-4 text-center text-xs text-cup-ink-soft">
          好友与组队要连后端(?cloud=1)
        </p>
      </Card>
    );
  }

  async function addFriend(): Promise<void> {
    if (!social) return;
    setMsg(null);
    const e = email.trim();
    if (!e) {
      setMsg({ ok: false, text: '填好友的邮箱' });
      return;
    }
    setBusy(true);
    try {
      const f = await social.addFriend(e);
      if (f) {
        setMsg({ ok: true, text: `已加上 ${f.nickname || e}` });
        setEmail('');
        await reload();
      } else {
        setMsg({ ok: false, text: '加好友失败(对方没注册?或没登录)' });
      }
    } finally {
      setBusy(false);
    }
  }

  function exportShare(): void {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const members = team?.members ?? (friends.length + 1);
    const model = buildShareCard(
      { streak: team?.streak ?? 0, members, days: team?.days ?? [] },
      new Date().toISOString().slice(0, 10),
    );
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = CARD_W;
    canvas.height = cardHeight(model);
    drawCard(ctx, model, CARD_W);
    downloadCanvas(canvas, 'cup-share.png');
  }

  return (
    <Card title="杯子社交" hint={team ? `组队连续 ${team.streak} 天` : '需登录'}>
      <div className="flex flex-col gap-3">
        {/* 组队 streak */}
        <div className="rounded-2xl bg-cup-foam/60 p-3">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold tabular-nums text-cup-deep">
              {team?.streak ?? 0}
            </span>
            <span className="text-xs text-cup-ink-soft">
              天组队连续达标 · {team?.members ?? 1} 只杯子
            </span>
          </div>
          {team && team.days.length > 0 && (
            <div className="mt-1 text-[10px] text-cup-ink-soft">
              {team.days[0]} → {team.days[team.days.length - 1]}
            </div>
          )}
          <div className="mt-2">
            <Button tone="ghost" onClick={exportShare}>
              导出分享卡
            </Button>
          </div>
        </div>

        {/* 好友列表 */}
        {friends.length === 0 ? (
          <p className="text-xs text-cup-ink-soft">
            还没有好友 —— 加上好友后互相能看到对方的杯子和 streak
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {friends.map((f) => (
              <li
                key={f.user_id}
                className="flex items-center justify-between rounded-xl bg-white/70 px-3 py-2 ring-1 ring-cup-veil/50"
              >
                <span className="truncate text-sm text-cup-ink">{f.nickname || f.user_id}</span>
                <span className="shrink-0 text-xs text-cup-ink-soft">
                  {f.traits ? `${dispositionCn(f.traits.disposition)} · 连续 ${f.streak ?? 0} 天` : '还没绑杯子'}
                </span>
              </li>
            ))}
          </ul>
        )}

        {/* 加好友 */}
        {user ? (
          <form
            className="flex items-center gap-2 border-t border-cup-veil/60 pt-3"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void addFriend();
            }}
          >
            <TextField
              type="email"
              placeholder="好友邮箱"
              aria-label="好友邮箱"
              value={email}
              disabled={busy}
              onChange={(e) => {
                setEmail(e.target.value);
                setMsg(null);
              }}
            />
            <Button type="submit" disabled={busy}>
              {busy ? '加中…' : '加好友'}
            </Button>
          </form>
        ) : (
          <p className="border-t border-cup-veil/60 pt-3 text-xs text-cup-ink-soft">
            登录后才能加好友
          </p>
        )}
        {msg && (
          <p className={`text-xs ${msg.ok ? 'text-cup-aqua' : 'text-cup-ember'}`} role="status">
            {msg.text}
          </p>
        )}
      </div>

      <canvas ref={canvasRef} className="hidden" aria-hidden="true" />
    </Card>
  );
}

function dispositionCn(d: 'sulky' | 'normal' | 'smug'): string {
  return d === 'smug' ? '得意' : d === 'sulky' ? '蔫' : '平常';
}
