/**
 * 账号卡(#72/#73/#74 的地基)—— 注册 / 登录 / 登出。
 *
 * 「真账号体系」的**入口**:没有它,市场投稿、加好友、管理台都无处依附。
 * 会话镜像在 useSession(令牌在 CloudSocial 的 sessionStorage 里,这里只拿用户视图)。
 *
 * 真实 click 提交(铁律);口令错误由后端给**人话**(如"邮箱或口令不对"),前端原样显示。
 * 零依赖:表单就是受控 input + 原生 click,不引表单库。
 */
import { useState } from 'react';
import { Button, Card, TextField } from '../ui.tsx';
import type { Session } from '../../data/useSession.ts';

type Mode = 'login' | 'register';

export function AccountCard({
  session,
  enabled,
  invite,
  defaultMode = 'login',
}: {
  session: Session;
  enabled: boolean;
  /** 分享卡邀请码(P4.3):落地页注册时带上 → 后端记一条归属边 */
  invite?: string;
  /** 初始形态;落地页直接开在注册(默认登录) */
  defaultMode?: Mode;
}) {
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 无后端源:不摆一个按不动的表单,直接说清为什么
  if (!enabled) {
    return (
      <Card title="账号" hint="需连后端">
        <p className="py-4 text-center text-xs text-cup-ink-soft">
          账号 / 市场 / 社交要连后端(?cloud=1);模拟器与 mock 源没有账号体系
        </p>
      </Card>
    );
  }

  if (session.loading) {
    return (
      <Card title="账号" hint="读取中…">
        <p className="py-4 text-center text-xs text-cup-ink-soft">正在确认登录状态…</p>
      </Card>
    );
  }

  // 已登录:显示身份 + 登出
  if (session.user) {
    const roleLabel =
      session.user.role === 'admin'
        ? '管理员'
        : session.user.role === 'ops'
          ? '运维'
          : session.user.role === 'reviewer'
            ? '审核'
            : '已登录';
    return (
      <Card title="账号" hint={roleLabel}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-cup-ink">
              {session.user.nickname || session.user.email}
            </span>
            <span className="truncate text-xs text-cup-ink-soft">{session.user.email}</span>
          </div>
          <Button
            tone="ghost"
            onClick={() => {
              void session.logout();
            }}
          >
            登出
          </Button>
        </div>
      </Card>
    );
  }

  async function submit(): Promise<void> {
    setError(null);
    // 轻量前端校验:只挡明显空的,其余交给后端(口令强度是后端的事)
    if (!email.trim() || !password) {
      setError('邮箱与口令都要填');
      return;
    }
    setBusy(true);
    try {
      const out =
        mode === 'login'
          ? await session.login(email.trim(), password)
          : await session.register(email.trim(), password, nickname.trim() || undefined, invite);
      if (!out.ok) {
        setError(
          out.error ??
            (out.reason === 'offline'
              ? '连不上后端'
              : out.reason === 'timeout'
                ? '后端没及时回,再试一次'
                : '登录 / 注册失败'),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="账号" hint={mode === 'login' ? '登录' : '注册'}>
      <form
        className="flex flex-col gap-2"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          type="email"
          autoComplete="username"
          placeholder="邮箱"
          aria-label="邮箱"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setError(null);
          }}
        />
        <TextField
          type="password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          placeholder="口令"
          aria-label="口令"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(null);
          }}
        />
        {mode === 'register' && (
          <TextField
            placeholder="昵称(可留空)"
            aria-label="昵称"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
          />
        )}
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? '处理中…' : mode === 'login' ? '登录' : '注册'}
          </Button>
          <Button
            type="button"
            tone="ghost"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError(null);
            }}
          >
            {mode === 'login' ? '没有账号?去注册' : '已有账号?去登录'}
          </Button>
        </div>
      </form>
      {error ? (
        <p className="mt-2 text-xs text-cup-ember" role="alert">
          {error}
        </p>
      ) : (
        <p className="mt-2 text-xs text-cup-ink-soft">
          登录后可用市场投稿 / 加好友;管理台仅管理员可见
        </p>
      )}
    </Card>
  );
}
