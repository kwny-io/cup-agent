/**
 * 绑定杯子卡 —— 登录用户把自己的杯绑到账号上(好友才看得到我的派生性格 + 组队 streak)。
 *
 * 为什么需要这页:设备端(模拟器 / 固件)连上后会在横幅打出**一次性绑定码**
 * (`设备绑定码(可信绑定用,一次性): XXXX ← 在 App 里输入以绑定这只杯`),
 * 但用户此前**没地方输** —— 现补齐:输入 cup_id + 绑定码 → 真实 click → POST /social/cup。
 *
 * 两条口径:
 *   · 走**账号会话**(Bearer,同 /social/*),不走设备 x-api-key —— 绑杯是账号行为,故要登录;
 *   · 可信绑定开关(`--require-claim`)由**服务端**决;开着时缺码/错码后端回 403
 *     「杯子绑定凭证无效」,本卡**原样显示**(不猜原因,后端也不给 oracle)。
 *
 * 真实 click 提交(铁律),busy / error / saved 三态照 AccountCard / ProfileCard。
 */
import { useEffect, useState } from 'react';
import { Button, Card, TextField } from '../ui.tsx';
import type { PublicUser, SocialApi } from '../../data/source.ts';

export function BindCard({
  social,
  enabled,
  user,
}: {
  social: SocialApi | null;
  enabled: boolean;
  user: PublicUser | null;
}) {
  const [bound, setBound] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [cupInput, setCupInput] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!social || !user) {
      setLoaded(true);
      return;
    }
    let alive = true;
    void social.getBoundCup().then((id) => {
      if (!alive) return;
      setBound(id);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [social, user]);

  if (!enabled || !social) {
    return (
      <Card title="绑定杯子" hint="需连后端">
        <p className="py-4 text-center text-xs text-cup-ink-soft">
          绑杯要连后端(?cloud=1);模拟器与 mock 源没有账号体系
        </p>
      </Card>
    );
  }

  if (!user) {
    return (
      <Card title="绑定杯子" hint="未登录">
        <p className="py-4 text-center text-xs text-cup-ink-soft">
          登录后,把杯子上显示的绑定码填进来,这只杯就归到你名下
        </p>
      </Card>
    );
  }

  async function bind(): Promise<void> {
    if (!social) return;
    const id = cupInput.trim();
    if (id === '') {
      setError('要填杯子编号');
      return;
    }
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const r = await social.bindCup(id, codeInput.trim() || undefined);
      if (r.ok) {
        setBound(id);
        setCupInput('');
        setCodeInput('');
        setSaved(true);
      } else {
        // 403「杯子绑定凭证无效」原样显示;其余给通用人话
        setError(r.error ?? '绑定失败,请检查绑定码');
      }
    } finally {
      setBusy(false);
    }
  }

  async function unbind(): Promise<void> {
    if (!social) return;
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const r = await social.unbindCup();
      if (r.ok) {
        setBound(null);
      } else {
        setError(r.error ?? '解绑失败,请重试');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="绑定杯子" hint={bound ? '已绑定' : '未绑定'}>
      {!loaded ? (
        <p className="py-4 text-center text-xs text-cup-ink-soft">读取中…</p>
      ) : (
        <div className="flex flex-col gap-3">
          {bound ? (
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-col">
                <span className="text-xs text-cup-ink-soft">当前绑定</span>
                <span className="truncate text-sm font-medium text-cup-ink">{bound}</span>
              </div>
              <Button type="button" tone="ghost" disabled={busy} onClick={() => void unbind()}>
                解绑
              </Button>
            </div>
          ) : (
            <>
              <p className="text-xs text-cup-ink-soft">
                杯子(或模拟器)连上后会显示一枚一次性绑定码,连杯子编号一起填进来。
              </p>
              <form
                className="flex flex-col gap-2"
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  void bind();
                }}
              >
                <label className="flex items-center gap-2">
                  <span className="w-14 shrink-0 text-xs text-cup-ink-soft">杯子编号</span>
                  <TextField
                    aria-label="杯子编号"
                    placeholder="如 cup-001"
                    value={cupInput}
                    disabled={busy}
                    onChange={(e) => {
                      setCupInput(e.target.value);
                      setError(null);
                    }}
                  />
                </label>

                <label className="flex items-center gap-2">
                  <span className="w-14 shrink-0 text-xs text-cup-ink-soft">绑定码</span>
                  <TextField
                    aria-label="绑定码"
                    autoComplete="off"
                    placeholder="设备上显示的一次性码"
                    value={codeInput}
                    disabled={busy}
                    onChange={(e) => {
                      setCodeInput(e.target.value);
                      setError(null);
                    }}
                  />
                </label>

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button type="submit" disabled={busy}>
                    {busy ? '绑定中…' : '绑定'}
                  </Button>
                  {saved && (
                    <span className="text-xs text-cup-aqua" role="status">
                      已绑定
                    </span>
                  )}
                </div>
              </form>
            </>
          )}

          {error && (
            <p className="text-xs text-cup-ember" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
