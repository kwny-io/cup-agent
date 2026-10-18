/**
 * 屏幕卡通杯的「脸型」决议 —— 纯函数,与画布无关(同 lib/eyes.ts 的分工,一个给硬件盖脸、一个给屏幕脸)。
 *
 * 优先级(高 → 低):
 *   shaking > drought > heat > sulk > smug > normal
 *
 * 摇杯、空杯、水烫都是**身体事实**,压过心情;心情只在身体平顺时露出来。
 * 干旱(空杯)排在炎热之前:杯里没水时"烫"根本没有意义。
 */
import type { TempZone } from './color.ts';
import type { Mood } from './mood.ts';

export type ScreenFaceMode = 'shaking' | 'drought' | 'heat' | 'sulk' | 'smug' | 'normal';

/** 低于此水位算「空杯 / 干旱」。与 drawWater 的残渍阈值(0.04)同量级,略高一点让脸先干。 */
export const DROUGHT_LEVEL = 0.06;

export interface FaceInputs {
  shaking: boolean;
  /** 水位比例 0..1 */
  level01: number;
  zone: TempZone;
  mood: Mood;
}

export function faceMode(i: FaceInputs): ScreenFaceMode {
  if (i.shaking) return 'shaking';
  if (i.level01 <= DROUGHT_LEVEL) return 'drought';
  if (i.zone === 'hot' || i.zone === 'scalding') return 'heat';
  if (i.mood === 'sulk') return 'sulk';
  if (i.mood === 'smug') return 'smug';
  return 'normal';
}

/** 脸型中文名(调试/测试可读) */
export const FACE_MODE_LABEL: Record<ScreenFaceMode, string> = {
  shaking: '发懵',
  drought: '干旱',
  heat: '受不了炎热',
  sulk: '蔫',
  smug: '得意',
  normal: '平常',
};
