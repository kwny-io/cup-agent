/**
 * 邀请落地页(P4.3)—— 收到分享链接(?invite=<code>)的人**免注册**先看到的场景。
 *
 * 设计稿 §3.3:分享 → 落地 → 注册 → 归属边落库。落地页只做两件事:
 *   1. 用 `previewInvite(code)`(公开读,无需登录)**只**展示邀请人的杯子场景
 *      —— 昵称 + 一眼性格 + streak(与分享卡画的是同一份东西);看不到邮箱 / cup_id。
 *   2. 给一个注册入口,把 `code` 带进去 —— 注册成功即记一条归属边(服务端尽力而为)。
 *
 * 没配后端(social 为 null)时预览取不到 → 如实说"看不了",但**注册入口仍在**
 * (带上 ?cloud= 就能连上)。
 */
import { useEffect, useState } from 'react';
import { Card } from './ui.tsx';
import { AccountCard } from './dashboard/AccountCard.tsx';
import type { Session } from '../data/useSession.ts';
import type { InvitePreview, SocialApi, TraitRecord } from '../data/source.ts';

const DISPOSITION_CN: Record<TraitRecord['disposition'], string> = {
  sulky: '蔫蔫的',
  normal: '平平常常',
  smug: '得意洋洋',
};

function pct(x: number): string {
  const v = x < 0 ? 0 : x > 1 ? 1 : x;
  return `${Math.round(v * 100)}%`;
}

export function InviteLanding({
  social,
  session,
  code,
}: {
  social: SocialApi | null;
  session: Session;
  code: string;
}) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loading, setLoading] = useState(social !== null);

  useEffect(() => {
    if (!social) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    void social.previewInvite(code).then((p) => {
      if (!alive) return;
      setPreview(p);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [social, code]);

  const inviter = preview?.valid ? preview.inviter : null;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 p-5">
      <header className="flex flex-col items-center gap-1 pt-4 text-center">
        <span className="text-3xl">🥤</span>
        <h1 className="text-lg font-bold text-cup-deep">有人邀请你养一只能一起组队的杯子</h1>
        <p className="text-xs text-cup-ink-soft">邀请码 {code}</p>
      </header>

      {/* 邀请人的杯子场景(免注册预览) */}
      <Card title="对方的杯子" hint={loading ? '读取中…' : undefined}>
        {loading ? (
          <p className="py-4 text-center text-xs text-cup-ink-soft">正在看看这只杯子…</p>
        ) : !social ? (
          <p className="py-4 text-center text-xs text-cup-ink-soft">
            这个链接要连后端才看得到(?cloud=…)
          </p>
        ) : !preview?.valid ? (
          <p className="py-4 text-center text-xs text-cup-ink-soft">
            邀请码无效或已失效 —— 不过注册入口照旧,进去自己养一只
          </p>
        ) : !inviter ? (
          <p className="py-4 text-center text-xs text-cup-ink-soft">
            对方还没公开杯子,先注册养一只自己的吧
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="text-sm font-medium text-cup-ink">
              {inviter.nickname}
              <span className="ml-1 text-xs text-cup-ink-soft">的杯子</span>
            </div>
            {inviter.traits ? (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-cup-ink-soft">
                <span>脾气:{DISPOSITION_CN[inviter.traits.disposition]}</span>
                <span>连续达标 {inviter.streak ?? inviter.traits.streak} 天</span>
                <span>近一周达标率 {pct(inviter.traits.level)}</span>
              </div>
            ) : (
              <p className="text-xs text-cup-ink-soft">对方没公开杯子状态</p>
            )}
          </div>
        )}
      </Card>

      {/* 注册入口:带上邀请码 → 注册成功记一条归属边 */}
      <AccountCard session={session} enabled={social !== null} invite={code} defaultMode="register" />
    </div>
  );
}
