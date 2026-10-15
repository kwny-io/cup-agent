/**
 * 当前生效的人格包(P4.2)——“这只杯现在穿哪件”,交渲染回路。
 *
 * 两个来源,优先级:
 *   1. `?pack=<pack_id>` 深链 —— **显式预览**动作(不想装、只想看手感):解析后优先。
 *   2. 服务端 `GET /cups/:id/pack` —— **真源**:账号给自己那只杯装的生效包(落库)。
 *      深链缺省 / 指了个不存在的包时,回落到这里;都没有 → null(= 出厂体质)。
 *
 * 包到手**先过 `sanitizePack`**(前端那道语义钳制),与 MarketCard 同口径 ——
 * 远端包只带数值 + 文本,喂渲染前必须夹一次。
 */
import { useEffect, useState } from 'react';
import { sanitizePack } from '../lib/pack-apply.ts';
import type { PersonaPack, SocialApi } from './source.ts';

/**
 * 解析当前生效包:显式 `?pack=<id>` 深链(预览)优先,否则用服务端生效包。
 * 都没有 / 未登录 / 找不到 → null(= 出厂体质,渲染逐帧与今天一致)。
 */
export function useActivePack(
  social: SocialApi | null,
  search = location.search,
  /** 装/卸包后 +1 触发重取(市场里点「装到我的杯子」→ 徽标即时跟进,不用刷新) */
  refreshKey = 0,
): PersonaPack | null {
  const [pack, setPack] = useState<PersonaPack | null>(null);
  useEffect(() => {
    if (!social) {
      setPack(null);
      return;
    }
    let alive = true;
    void (async () => {
      // 1) 显式深链 ?pack=<id>:预览动作,解析得到就优先(不装包也能改手感)。
      const id = new URLSearchParams(search).get('pack');
      if (id) {
        const list = await social.listPacks();
        if (!alive) return;
        const found = list.find((p) => p.pack_id === id);
        if (found) {
          setPack(sanitizePack(found));
          return;
        }
      }
      // 2) 服务端"当前生效包"(账号给自己那只杯装的)—— P4.2 真源。
      const active = await social.getActivePack();
      if (!alive) return;
      setPack(active ? sanitizePack(active) : null);
    })();
    return () => {
      alive = false;
    };
  }, [social, search, refreshKey]);
  return pack;
}
