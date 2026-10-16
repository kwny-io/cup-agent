/**
 * 杯子社交卡(#74 + P4.3 邀请 / P4.4 隐私)—— 好友互见 + 组队 streak + 分享卡 + 邀请。
 *
 * 隐私口径(与迁移码 / #72 档案同一套):好友之间**只互见派生性格 + streak + 昵称**,
 * 看不到对方的原始饮水曲线、聊天记录。后端出口视图(FriendView)就没有那些字段 ——
 * 前端不是"藏起来",而是**根本没拿到**。P4.4 的 visible 开关关掉后,后端连性格/streak
 * 都不给(变成"还没绑杯子"那一档),这是**服务端**的门,前端只是开关。
 *
 * 分享卡用与养成卡同一套 Canvas 2D 绘制助手(lib/card-render.ts 的 buildShareCard)。
 * P4.3:导出的卡默认带一行邀请码,收到卡的人打开落地页(免注册)先看你的杯子场景,
 * 再决定注册 —— 注册时带上这个码即记一条归属边(谁邀请的谁)。
 *
 * 真实 click 提交(铁律)。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, TextField } from '../ui.tsx';
import { buildShareCard, cardHeight, CARD_W, drawCard, downloadCanvas } from '../../lib/card-render.ts';
import { buildInviteLink } from '../../lib/invite.ts';
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
  // P4.3:本次会话生成/导出时铸的邀请码(前端记住它;store 无反向索引,列表接口答不了)
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // P4.4:好友可见性开关(服务端值;null = 还没读到 / 未启用)
  const [privacy, setPrivacyState] = useState<boolean | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const reload = useCallback(async () => {
    if (!social) return;
    const [fs, t, p] = await Promise.all([social.listFriends(), social.getTeam(), social.getPrivacy()]);
    setFriends(fs);
    setTeam(t);
    setPrivacyState(p);
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

  /** 铸一个新邀请码(P4.3);已铸过则复用(不刷屏)。 */
  async function ensureInvite(): Promise<string | null> {
    if (!social) return null;
    if (inviteCode) return inviteCode;
    const code = await social.mintInvite();
    if (code) setInviteCode(code);
    return code;
  }

  /** 当前邀请链接:在当前页 URL(?cloud=… 保留)上并入 ?invite=<code>。 */
  function linkFor(code: string): string {
    return buildInviteLink(code, location.search, location.origin, location.pathname);
  }

  async function generateInvite(): Promise<void> {
    setInviteCode(null);
    setCopied(false);
    const code = await ensureInvite();
    if (!code) setMsg({ ok: false, text: '生成邀请码失败(再试一次)' });
  }

  async function copyInvite(): Promise<void> {
    if (!inviteCode) return;
    try {
      await navigator.clipboard.writeText(linkFor(inviteCode));
      setCopied(true);
    } catch {
      // 无剪贴板权限 / 环境不支持:链接已显示在输入框里,可手动复制
      setCopied(false);
      setMsg({ ok: false, text: '复制不了,手动选中上面的链接复制' });
    }
  }

  async function exportShare(): Promise<void> {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const code = await ensureInvite(); // 分享卡默认带上邀请码(P4.3)
    const members = team?.members ?? friends.length + 1;
    const model = buildShareCard(
      { streak: team?.streak ?? 0, members, days: team?.days ?? [] },
      new Date().toISOString().slice(0, 10),
      code,
    );
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = CARD_W;
    canvas.height = cardHeight(model);
    drawCard(ctx, model, CARD_W);
    downloadCanvas(canvas, 'cup-share.png');
  }

  /** P4.4:删好友(单向,对方不受影响;要互删得对方也删)。 */
  async function removeFriend(friendUserId: string): Promise<void> {
    if (!social) return;
    const ok = await social.deleteFriend(friendUserId);
    if (ok) setFriends((prev) => prev.filter((f) => f.user_id !== friendUserId));
  }

  /** P4.4:好友可见性开关(关 → 好友看不到我的性格 / streak)。 */
  async function togglePrivacy(): Promise<void> {
    if (!social || privacy === null) return;
    const next = !privacy;
    const r = await social.setPrivacy(next);
    if (r !== null) setPrivacyState(r);
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
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button tone="ghost" onClick={() => void exportShare()}>
              导出分享卡
            </Button>
            {user && (
              <Button tone="ghost" onClick={() => void generateInvite()}>
                {inviteCode ? '重新生成邀请链接' : '生成邀请链接'}
              </Button>
            )}
          </div>
          {/* 邀请链接(P4.3):生成后显示,可复制;分享卡也会带上同一码 */}
          {inviteCode && (
            <div className="mt-2 flex items-center gap-2">
              <TextField
                readOnly
                aria-label="邀请链接"
                value={linkFor(inviteCode)}
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button tone="ghost" onClick={() => void copyInvite()}>
                {copied ? '已复制' : '复制'}
              </Button>
            </div>
          )}
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
                className="flex items-center justify-between gap-2 rounded-xl bg-white/70 px-3 py-2 ring-1 ring-cup-veil/50"
              >
                <span className="truncate text-sm text-cup-ink">{f.nickname || f.user_id}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="text-xs text-cup-ink-soft">
                    {f.traits ? `${dispositionCn(f.traits.disposition)} · 连续 ${f.streak ?? 0} 天` : '还没绑杯子'}
                  </span>
                  <button
                    type="button"
                    aria-label={`删除好友 ${f.nickname || f.user_id}`}
                    onClick={() => void removeFriend(f.user_id)}
                    className="rounded-full px-2 py-0.5 text-xs text-cup-ink-soft hover:bg-cup-ember/10 hover:text-cup-ember"
                  >
                    删
                  </button>
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

        {/* 隐私开关(P4.4):关掉后好友看不到我的性格 / streak */}
        {user && privacy !== null && (
          <label className="flex items-center gap-2 border-t border-cup-veil/60 pt-3 text-xs text-cup-ink-soft">
            <input
              type="checkbox"
              aria-label="好友可见"
              checked={privacy}
              onChange={() => void togglePrivacy()}
              className="h-4 w-4 accent-cup-deep"
            />
            好友可见我的杯子状态(性格 / streak)
          </label>
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
