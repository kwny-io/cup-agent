/**
 * 官方人格种子包(P4-D3 冷启动)—— 5 个手工调的包,启动时种入市场。
 *
 * 为什么要种子:市场空着 = 用户看到空货架 = 一次性差评。5 个手感明显不同的包
 * 既是"先有鸡"的最小解,本身也是产品 demo(见桌面 P4-生态位设计稿 §2.5)。
 *
 * **官方包不走审核队列**:`author_user_id` 用哨兵 `OFFICIAL_AUTHOR`、`status` 直接 `approved`
 * (自己审自己没意义)。种子**幂等**:按稳定 `pack_id` 逐包查,缺才补,绝不覆盖。
 *
 * 数值都落在 **前端语义区间内**(见 apps/web lib/pack-apply.ts),故经两层钳制后原样生效 ——
 * 若越界会被前端夹到边界,手感就不是这里调的了。
 */
import type { AccountsStore, PersonaPack } from './types.ts';

/** 官方作者哨兵 —— 不是合法 userId,永不与真实用户撞 */
export const OFFICIAL_AUTHOR = 'official';

interface OfficialSpec {
  /** 稳定 id(种子幂等的键;改动它 = 会重新种一份) */
  id: string;
  name: string;
  tone: string;
  thresholds: Record<string, number>;
  wave: Record<string, number>;
  lines: string[];
}

/**
 * 5 个底色明显不同的包(慢性子 / 急性子 / 傲娇 / 元气 / 冷淡)。
 * 数值口径:REFUSE_S=摇杯起手皱眉时长(越大越迟钝)、SMUG_S=得意持续、SULK_LEVEL=低于此水位才蔫;
 * 水波 k=弹簧回复、c=邻居传播、damp=阻尼(越大越"死水")。默认体质见 mood.ts / water.ts。
 */
export const OFFICIAL_PACKS: readonly OfficialSpec[] = [
  {
    id: 'official-slowpoke',
    name: '慢性子',
    tone: '说话慢条斯理,不急不催;提醒你喝水也温吞,像午后晒太阳的老朋友。',
    thresholds: { REFUSE_S: 1.2, SMUG_S: 8, SULK_LEVEL: 0.2, SULK_STREAK: 5 },
    wave: { k: 18, c: 60, damp: 5 },
    lines: ['不急,慢慢来。', '喝一口也好。', '我就这么看着你。'],
  },
  {
    id: 'official-hothead',
    name: '急性子',
    tone: '说话快、爱催,语气冲但没恶意;一见你磨蹭就急。',
    thresholds: { REFUSE_S: 0.15, SMUG_S: 1.5, SULK_LEVEL: 0.35, SULK_STREAK: 2 },
    wave: { k: 120, c: 260, damp: 6 },
    lines: ['快点喝水!', '磨蹭什么呢?', '一口,就现在!'],
  },
  {
    id: 'official-tsundere',
    name: '傲娇',
    tone: '嘴硬心软,嘴上嫌弃你,其实一直在等你回来。',
    thresholds: { REFUSE_S: 0.45, SMUG_S: 10, SULK_LEVEL: 0.28, SULK_STREAK: 3 },
    wave: { k: 42, c: 105, damp: 2.6 },
    lines: ['哼,才不是特意等你。', '……喝就喝吧。', '别以为我在意。'],
  },
  {
    id: 'official-genki',
    name: '元气满满',
    tone: '一天到晚精神饱满,爱鼓励,你喝一口它就夸你一句。',
    thresholds: { REFUSE_S: 0.3, SMUG_S: 6, SULK_LEVEL: 0.15, SULK_STREAK: 1 },
    wave: { k: 90, c: 200, damp: 1.2 },
    lines: ['太棒了!', '干得漂亮!', '再来一口,冲呀!'],
  },
  {
    id: 'official-aloof',
    name: '冷淡',
    tone: '话少、语气平,不催不夸,只在你真的渴了才开口。',
    thresholds: { REFUSE_S: 0.2, SMUG_S: 1, SULK_LEVEL: 0.5, SULK_STREAK: 2 },
    wave: { k: 55, c: 120, damp: 8 },
    lines: ['该喝水了。', '嗯。', '水在这里。'],
  },
];

function toPack(spec: OfficialSpec, nowMs: number): PersonaPack {
  return {
    pack_id: spec.id,
    author_user_id: OFFICIAL_AUTHOR,
    name: spec.name,
    tone: spec.tone,
    thresholds: spec.thresholds,
    wave: spec.wave,
    lines: spec.lines,
    status: 'approved',
    created_at: nowMs,
  };
}

/**
 * 启动时种入官方包。**幂等**:逐包按稳定 id 查,已存在则跳过(不覆盖、不重置审核状态)。
 * @returns 本次新种入的数量(0 = 已齐;给日志/测试一个可断言的值)
 */
export async function seedOfficialPacks(
  accounts: AccountsStore,
  nowMs: number,
): Promise<number> {
  let added = 0;
  for (const spec of OFFICIAL_PACKS) {
    if (await accounts.packById(spec.id)) continue;
    await accounts.createPack(toPack(spec, nowMs));
    added += 1;
  }
  return added;
}
