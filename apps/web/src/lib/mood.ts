/**
 * 杯子心情层 —— D1 人设「傲娇宠物」的状态机(2026-10-08 定)。
 *
 * 性格:**嘴上嫌弃、其实在乎**。所以
 *   · 怠慢它(久置低水位)→ 蔫 —— 是**闹别扭**,不是悲伤
 *   · 你喝它        → "哼" 一声**得意地满足**
 *   · 你摇它        → 先不耐烦地**皱眉**,再**勉为其难地**享受
 *
 * 这是**表现层**状态,不吃 lib/water.ts 的物理,也不碰契约。
 * 输入只有:是否在摇、水位比例、以及调用方按 50Hz 喂进来的"又喝了一口"。
 * 自身按固定步长累积时钟,不依赖渲染帧率。
 */

export type Mood = 'idle' | 'refuse' | 'give' | 'smug' | 'sulk';

/**
 * 长期性格(M4)—— 后端日战报算出来的**趋势**,不是这一秒的心情。
 *
 * 与 Mood 的区别:
 *   Mood        秒级、由动作/水位驱动(摇杯皱一下、久置蔫一下),自收自散
 *   Disposition 天级、由后端从近 7 天聚合推得(见 apps/server personality.ts),常驻
 *
 * 二者是"底色 vs 表情":瞬时事件优先(喝水照样得意、摇杯照样皱眉),
 * 无事发生时长期性格接管,让杯子带着昨天/上周的情绪 —— 而不是每次都归零成呆滞。
 */
export type Disposition = 'sulky' | 'normal' | 'smug';

/** 长期性格 → 表现姿态。注意 sulky(长期)| sulk(瞬间) 拼写不同,这里做映射 */
const PASSTHROUGH_MOOD: Record<Disposition, Mood> = {
  sulky: 'sulk',
  normal: 'idle',
  smug: 'smug',
};

/** 摇杯起手皱眉的时长(秒)——短促,才像"嫌弃一下" */
const REFUSE_S = 0.45;
/** 得意持续时长(秒) */
const SMUG_S = 4;
/** 连续低水位多久算"被怠慢"(秒) */
const SULK_LOW_S = 6;
/** 低于此水位才可能蔫 */
const SULK_LEVEL = 0.28;
/** 一口之内的连续两次水位下降,多近算同一口(秒) */
const SIP_DEBOUNCE_S = 1.2;
/** 统计窗口(秒):这段时间内喝够 SIP_COUNT 口 → 得意 */
const SIP_WINDOW_S = 30;
const SIP_COUNT = 2;

export class CupMood {
  private mood: Mood = 'idle';
  /** 当前心情已持续(秒) */
  private moodT = 0;
  /** 自身时钟(秒),只被 step 推进 */
  private clock = 0;
  private wasShaking = false;
  private shakeT = 0;
  /** 连续低水位的累计时长(秒) */
  private lowT = 0;
  /** 最近的"口"发生时刻 */
  private sips: number[] = [];
  /** 后端给出的长期性格(底色);无后端时保持 normal */
  private disposition: Disposition = 'normal';
  /** 当前这次得意是"喝出来"的瞬时得意(有时候限),还是长期底色(常驻、随话随变) */
  private smugFromSip = false;

  get current(): Mood {
    return this.mood;
  }

  /** 由战报/快照喂入长期性格;normal 即"无底色",不改变表现 */
  setDisposition(d: Disposition): void {
    this.disposition = d;
  }

  /**
   * 每帧按固定步长调用一次。
   * @param dt        固定步长(lib/water.ts 的 FIXED_DT)
   * @param shaking   motion === 'shake'
   * @param level01   水位比例 0..1(用**原始**水位,别用显示平滑值)
   */
  step(dt: number, shaking: boolean, level01: number): void {
    this.clock += dt;
    this.moodT += dt;

    // 1) 摇杯:先皱眉(不耐),再勉为其难 —— 物理性事件,优先于其它心情
    if (shaking) {
      if (!this.wasShaking) {
        this.wasShaking = true;
        this.shakeT = 0;
        this.set('refuse');
      }
      this.shakeT += dt;
      if (this.shakeT >= REFUSE_S) this.set('give');
      this.lowT = 0;
      return;
    }
    this.wasShaking = false;

    // 2) 久置低水位 → 蔫(闹别扭)
    this.lowT = level01 < SULK_LEVEL ? this.lowT + dt : 0;
    if (this.lowT >= SULK_LOW_S) {
      this.setInternal('sulk');
      return;
    }

    // 3) 喝出来的得意有时限,到点自己收；长期底色的得意则常驻
    if (this.mood === 'smug' && this.smugFromSip && this.moodT < SMUG_S) return;

    // 4) 无事发生 → 长期性格接管底色(蔫/得意),normal 则回到 idle
    this.setInternal(PASSTHROUGH_MOOD[this.disposition]);
  }

  /** 调用方检测到"水位掉了一截"时调一次(即被喝了一口) */
  noteSip(): void {
    const last = this.sips[this.sips.length - 1];
    if (last !== undefined && this.clock - last < SIP_DEBOUNCE_S) return; // 同一口的重复触发
    this.sips = this.sips.filter((t) => this.clock - t < SIP_WINDOW_S);
    this.sips.push(this.clock);
    if (this.sips.length >= SIP_COUNT) {
      this.smugFromSip = true; // 这一版得意是喝出来的 → 有时限
      this.set('smug');
    }
  }

  /**
   * 强制置一个心情 —— 供**瞬时事件**用(如喝水得意),是真正的"换表情"。
   * 长期性格的回落不走这里,而是 `setInternal`,好让 set 能看穿"底色"阈值
   * 之外的当前 mood(其实二者实现一样,分开只为语义清晰)。
   */
  set(m: Mood): void {
    this.setInternal(m);
  }

  private setInternal(m: Mood): void {
    if (this.mood === m) return;
    this.mood = m;
    this.moodT = 0;
  }
}
