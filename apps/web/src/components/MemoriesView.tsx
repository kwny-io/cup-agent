/**
 * 回忆视图 —— 独立一屏(与社区同约定:要登录 + 后端,空态集中)。
 *
 * 这屏放的是**关系的两条时间线**:
 *   · 成长(养成闭环,优先级 1)—— 向前看:阶段 / 里程碑 / 今天新解锁;
 *   · 回忆(长期记忆,优先级 2)—— 回头翻:逐日的叙事卡。
 * 两者都要账号 + 多天后端数据,故同屏;放一起 = "我和这只杯子"的完整一瞥。
 *
 * 数据从 props 进(与 Dashboard / CommunityView 同约定,不自己取数)。
 * 账号卡放最上面:没登录时它给登录入口,登录后成长与回忆才有东西可看。
 */
import { AccountCard } from './dashboard/AccountCard.tsx';
import { GrowthCard } from './dashboard/GrowthCard.tsx';
import { MemoriesCard } from './dashboard/MemoriesCard.tsx';
import type { Session } from '../data/useSession.ts';
import type { SocialApi } from '../data/source.ts';

export function MemoriesView({ social, session }: { social: SocialApi | null; session: Session }) {
  const enabled = social !== null;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      <AccountCard session={session} enabled={enabled} />
      <GrowthCard social={social} enabled={enabled} />
      <MemoriesCard social={social} enabled={enabled} />
    </div>
  );
}
