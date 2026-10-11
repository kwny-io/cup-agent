/**
 * 登录会话的 React 状态 —— 四张卡(#72/#73/#74 + 管理台)共享"当前是谁"。
 *
 * 为什么上提到 hook 而不是每张卡各自 useState:
 *   · 登录 / 登出要**所有卡一起变**(登录后市场卡才出投稿表单、管理台才现身);
 *   · 令牌在 CloudSocial 里(sessionStorage),这里只镜像**用户视图**;
 *   · 挂载时静默 `me()` 一次,把上次留下的令牌换回用户(刷新页面不掉登录)。
 *
 * social 为 null(模拟器 / mock 源)时恒为未登录,且不提供登录入口。
 */
import { useCallback, useEffect, useState } from 'react';
import type { AuthOutcome, PublicUser, SocialApi } from './source.ts';

export interface Session {
  /** 当前登录用户;未登录为 null */
  user: PublicUser | null;
  /** 首次 me() 是否还在跑(避免"闪一下未登录"再变已登录) */
  loading: boolean;
  login: (email: string, password: string) => Promise<AuthOutcome>;
  register: (email: string, password: string, nickname?: string) => Promise<AuthOutcome>;
  logout: () => Promise<void>;
  /** 外部动作(如改昵称)后手动刷一次用户视图 */
  refresh: () => Promise<void>;
}

export function useSession(social: SocialApi | null): Session {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(social !== null);

  useEffect(() => {
    if (!social) {
      setUser(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    void social.me().then((u) => {
      if (!alive) return;
      setUser(u);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [social]);

  const refresh = useCallback(async () => {
    if (!social) return;
    setUser(await social.me());
  }, [social]);

  const login = useCallback(
    async (email: string, password: string): Promise<AuthOutcome> => {
      if (!social) return { ok: false, reason: 'offline' };
      const out = await social.login(email, password);
      if (out.ok) setUser(out.user);
      return out;
    },
    [social],
  );

  const register = useCallback(
    async (email: string, password: string, nickname?: string): Promise<AuthOutcome> => {
      if (!social) return { ok: false, reason: 'offline' };
      const out = await social.register(email, password, nickname);
      if (out.ok) setUser(out.user);
      return out;
    },
    [social],
  );

  const logout = useCallback(async () => {
    if (!social) return;
    await social.logout();
    setUser(null);
  }, [social]);

  return { user, loading, login, register, logout, refresh };
}
