/**
 * 当前生效的人格包(P4.2 接线 B 的"取包"这半)——
 * 从 `?pack=<pack_id>` 深链解析出**这只杯现在穿哪件**,交渲染回路。
 *
 * 为什么先用深链而非服务端:
 *   · 服务端的"当前生效包"(`GET /cups/:id/pack`)要落库 —— 存储归 B lane(设计稿 §5);
 *   · 深链是**纯前端**的观察口:不落库、可分享、刷新即还原,先让"包真的改变手感"
 *     肉眼可见(里程碑 P4.1 的判据),等 B 落库后把这里的来源换成服务端即可(一处改)。
 *
 * 包到手**先过 `sanitizePack`**(前端那道语义钳制),与 MarketCard 同口径 ——
 * 远端包只带数值 + 文本,喂渲染前必须夹一次。
 */
import { useEffect, useState } from 'react';
import { sanitizePack } from '../lib/pack-apply.ts';
import type { PersonaPack, SocialApi } from './source.ts';

/**
 * 解析 `?pack=<id>` 指定的包;无参 / 未登录 / 找不到 / 未上架 → null(= 出厂体质)。
 * 只认**已上架**的包(listPacks 只回 approved),与"可订阅"同一可见性口径。
 */
export function useActivePack(social: SocialApi | null, search = location.search): PersonaPack | null {
  const [pack, setPack] = useState<PersonaPack | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(search).get('pack');
    if (!social || !id) {
      setPack(null);
      return;
    }
    let alive = true;
    void (async () => {
      const list = await social.listPacks();
      if (!alive) return;
      const found = list.find((p) => p.pack_id === id);
      setPack(found ? sanitizePack(found) : null);
    })();
    return () => {
      alive = false;
    };
  }, [social, search]);
  return pack;
}
