/**
 * 人格包 → 渲染参数(P4.2 接线 B 的"喂"这一步)。
 *
 * 三段接线的分工(设计稿 §2.4):
 *   A 服务端   —— 暴露"我装了什么""这只杯穿哪件"(归 B 的存储)
 *   B 前端     —— 把包喂进渲染回路 ← **本文件**
 *   C 服务端   —— tone/lines 进对话(另做)
 *
 * 本文件只做**纯映射**:包(已过 `sanitizePack` 钳制)→ 三组阈值对象。
 * 不碰 canvas、不 import 组件,故可单测(照 pack-apply.test.ts 的手法)。
 *
 * **关键不变量**:包缺某键 / 传 null → 用 `DEFAULT_*`;不装包时所有值 = 今天的
 * 出厂常量 → **渲染逐帧一致**(可回归,见 pack-render.test.ts)。
 */
import { DEFAULT_WAVE_PARAMS, type WaveParams } from './water.ts';
import { DEFAULT_MOOD_PARAMS, type MoodParams } from './mood.ts';
import { DEFAULT_EYE_PARAMS, type EyeParams } from './eyes.ts';
import type { PersonaPack } from '../data/source.ts';

/** 一组渲染参数:水波物理 + 心情阈值 + 表情阈值 */
export interface PackRenderParams {
  wave: WaveParams;
  mood: MoodParams;
  eye: EyeParams;
}

/** 不装包 / 缺键时的出厂参数 —— 即今天的常量 */
export const DEFAULT_RENDER_PARAMS: PackRenderParams = {
  wave: DEFAULT_WAVE_PARAMS,
  mood: DEFAULT_MOOD_PARAMS,
  eye: DEFAULT_EYE_PARAMS,
};

/** 从包的一个数值表里取有限数;缺失 / 非法 → fallback */
function num(t: Record<string, number> | undefined, key: string, fallback: number): number {
  const v = t?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * 把一份(已钳制的)人格包映射成渲染参数。
 *
 * 键名对齐 `PACK_THRESHOLD_KEYS` / `PACK_WAVE_KEYS`(与后端逐字同源):
 *   · 水波:`k` / `c` / `damp`
 *   · 心情:`REFUSE_S` / `SMUG_S` / `SULK_LEVEL`
 *   · 表情:`CONTENT_S`
 * 包**不含**的键(`IDLE_S` / `SULK_STREAK`)前端不消费,忽略 —— 不做错配映射。
 *
 * @param pack 已过 `sanitizePack` 的包;`null` → 出厂参数
 */
export function packRenderParams(pack: PersonaPack | null | undefined): PackRenderParams {
  if (!pack) return DEFAULT_RENDER_PARAMS;
  const w = pack.wave;
  const t = pack.thresholds;
  return {
    wave: {
      k: num(w, 'k', DEFAULT_WAVE_PARAMS.k),
      c: num(w, 'c', DEFAULT_WAVE_PARAMS.c),
      damp: num(w, 'damp', DEFAULT_WAVE_PARAMS.damp),
    },
    mood: {
      refuseS: num(t, 'REFUSE_S', DEFAULT_MOOD_PARAMS.refuseS),
      smugS: num(t, 'SMUG_S', DEFAULT_MOOD_PARAMS.smugS),
      sulkLevel: num(t, 'SULK_LEVEL', DEFAULT_MOOD_PARAMS.sulkLevel),
    },
    eye: {
      contentS: num(t, 'CONTENT_S', DEFAULT_EYE_PARAMS.contentS),
    },
  };
}
