/**
 * 社区视图 —— 把 #72/#73/#74 的卡 + 账号卡拼成一屏(独立 Tab)。
 *
 * 为什么单独一屏而不是塞进看板:这几张卡要登录、要后端账号体系,与"看今天喝了多少"
 * 是两条线。放一起会让看板在无后端时堆一排空态。单独一屏,空态集中、登录入口明确。
 *
 * 数据从 props 进(与 Dashboard 同约定,不自己取数)。
 */
import { AccountCard } from './dashboard/AccountCard.tsx';
import { ProfileCard } from './dashboard/ProfileCard.tsx';
import { LlmCard } from './dashboard/LlmCard.tsx';
import { MarketCard } from './dashboard/MarketCard.tsx';
import { FriendsCard } from './dashboard/FriendsCard.tsx';
import type { Session } from '../data/useSession.ts';
import type { SocialApi } from '../data/source.ts';

export function CommunityView({ social, session }: { social: SocialApi | null; session: Session }) {
  const enabled = social !== null;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      <AccountCard session={session} enabled={enabled} />
      <ProfileCard social={social} enabled={enabled} />
      <LlmCard social={social} enabled={enabled} user={session.user} />
      <MarketCard social={social} enabled={enabled} user={session.user} />
      <FriendsCard social={social} enabled={enabled} user={session.user} />
    </div>
  );
}
