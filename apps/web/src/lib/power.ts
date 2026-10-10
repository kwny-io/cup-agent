/**
 * 硬件脸功耗估算器(创意备忘 §4.3 第 3 步)。
 *
 * "按状态时长 × 各方案电流,直接算出'今天这样用,电池几天'" —— 选型不再靠猜。
 *
 * 纯函数、无 DOM:状态时长(小时)× 面板电流 → 每日 mAh → 整机续航天数。
 * 面板选项的电流取自备忘 §2.1 的估算表(均为 [待实测] 的工程默认,真机回填)。
 *
 * 口径:总量 = 设备基线(24 mAh/天,= 1500mAh ÷ 62 天,来自架构 §3.3)
 *       + 本脸额外耗电。于是"常亮 IPS ≈ 40 倍超预算 → 直接死"是算出来的,不是形容的。
 */
import type { EyeState } from './eyes.ts';

/** 电池容量(备忘 §2.1 基于的 1500mAh) */
export const BATTERY_MAH = 1500;
/** 设备基线耗电 mAh/天(= 1500 ÷ 62 天,架构 §3.3),显示之外的 MCU/传感器/上报 */
export const DEVICE_BUDGET_MAH_PER_DAY = 24;

export interface PanelOption {
  key: string;
  /** 中文名 */
  name: string;
  /** 一句话结论 */
  note: string;
  /** 常亮保持电流 mA(发光型 = 发光电流;反射型 ≈ 静态保持电流) */
  holdMa: number;
  /** 每次全屏刷新耗电 mAh(发光型点亮时电流已计入 hold,故≈0;反射型它是唯一开销) */
  refreshMah: number;
  /** 面板点亮占比 0–1(常亮=1;唤醒式按每天点亮秒数/86400) */
  dutyCycle: number;
  /** 能否做眨眼(电子纸刷新 0.3–1s,做不了眨眼 → 判死) */
  canBlink: boolean;
}

/** 每个状态每秒约几次整屏刷新(由 §3 像素级描述折算;发光型无所谓,反射型全靠它) */
export const STATE_REFRESH_HZ: Record<EyeState, number> = {
  sleep: 0.02, // 两条 2px 静止线,最低刷新
  nap: 0.125, // 每 8s 极缓位移 1px
  idle: 0.3, // 默认,靠眨眼带来刷新
  blink: 2.0, // 眨眼动作本身
  look: 1.0,
  startled: 8.0, // 瞳孔放大 + 反向摆动
  tilt: 2.0, // 随重力偏,慢一拍
  content: 1.5, // 弧眼 + 慢眨
  sulky: 0.3,
  smug: 0.3,
  weak: 0.5, // 半闭 + 三次慢眨
  forgotten: 0.3,
};

/** 面板候选(备忘 §2.1 估算表)。dutyCycle<1 的唤醒式变体单列。 */
export const PANEL_OPTIONS: PanelOption[] = [
  {
    key: 'ips-bright',
    name: '1.28" 圆 IPS + 背光(常亮)',
    note: '直接死:≈40× 超预算',
    holdMa: 40,
    refreshMah: 0,
    dutyCycle: 1,
    canBlink: true,
  },
  {
    key: 'ips-duty',
    name: '1.28" 圆 IPS(仅唤醒亮,30次×10s/天)',
    note: '续航几乎不变,但"眼睛不在"= 不是常亮陪伴物',
    holdMa: 40,
    refreshMah: 0,
    dutyCycle: 300 / 86400, // 30 次 × 10s = 300s/天
    canBlink: true,
  },
  {
    key: 'oled',
    name: '2× 0.96" 单色 OLED(常亮)',
    note: '要天天充电;另有静态图案烧屏风险',
    holdMa: 5,
    refreshMah: 0,
    dutyCycle: 1,
    canBlink: true,
  },
  {
    key: 'memory-lcd',
    name: 'Sharp Memory LCD 1.28" 128×128',
    note: '唯一同时满足"常亮 + 62 天 + 无烧屏"',
    holdMa: 0.005, // 静态保持 ~5µA
    refreshMah: 1.0e-5, // 每次全屏刷新 ≈ 0.5mW 摊到一帧 [待实测]
    dutyCycle: 1,
    canBlink: true,
  },
  {
    key: 'led-matrix',
    name: 'LED 点阵/导光片(低亮 PWM 常亮)',
    note: '最佳性价比 MVP,表达力够做眯眼/圆睁/瞌睡线',
    holdMa: 0.5,
    refreshMah: 0,
    dutyCycle: 1,
    canBlink: true,
  },
  {
    key: 'epaper',
    name: '电子纸(E-paper)',
    note: '做不了眨眼 → "活着"的第一要素缺失,判死',
    holdMa: 0.001,
    refreshMah: 0,
    dutyCycle: 1,
    canBlink: false,
  },
];

export interface PowerProfile {
  name: string;
  /** 每状态每天占用小时数 */
  hours: Record<EyeState, number>;
}

/** 典型一天:白天待机 + 夜里打盹为主,偶发看/倾斜/喝/低电。 */
export function defaultProfile(): PowerProfile {
  return {
    name: '典型一天',
    hours: {
      sleep: 0,
      nap: 8, // 夜里无人
      idle: 13.5,
      blink: 0.2,
      look: 0.5,
      startled: 0.02,
      tilt: 0.4,
      content: 0.5,
      sulky: 0.08,
      smug: 0.0,
      weak: 0.5,
      forgotten: 0.3,
    },
  };
}

export interface StatePart {
  state: EyeState;
  hours: number;
  mah: number;
}

export interface PowerBreakdown {
  key: string;
  name: string;
  note: string;
  canBlink: boolean;
  /** 保持耗电 mAh/天 */
  holdMah: number;
  /** 刷新耗电 mAh/天 */
  refreshMah: number;
  /** 本脸额外 mAh/天 */
  dailyMah: number;
  /** 整机 mAh/天(基线 + 本脸) */
  totalMahPerDay: number;
  /** 整机续航天数 */
  days: number;
  /** 相对设备基线的倍数 */
  overBudget: number;
  parts: StatePart[];
}

/** 计算单个方案在给定"一天用时分布"下的耗电(保持 + 刷新) */
export function estimateDaily(opt: PanelOption, profile: PowerProfile): PowerBreakdown {
  const parts: StatePart[] = [];
  let holdMah = 0;
  let refreshMah = 0;
  const duty = opt.dutyCycle;
  const states = Object.keys(profile.hours) as EyeState[];
  for (const st of states) {
    const hours = profile.hours[st];
    const h = opt.holdMa * hours * duty;
    const r = opt.refreshMah * hours * 3600 * STATE_REFRESH_HZ[st];
    holdMah += h;
    refreshMah += r;
    parts.push({ state: st, hours, mah: h + r });
  }
  const dailyMah = holdMah + refreshMah;
  const totalMahPerDay = DEVICE_BUDGET_MAH_PER_DAY + dailyMah;
  const days = BATTERY_MAH / totalMahPerDay;
  return {
    key: opt.key,
    name: opt.name,
    note: opt.note,
    canBlink: opt.canBlink,
    holdMah,
    refreshMah,
    dailyMah,
    totalMahPerDay,
    days,
    overBudget: totalMahPerDay / DEVICE_BUDGET_MAH_PER_DAY,
    parts,
  };
}

/** 一看就懂的续航档位(给 UI 上色用) */
export function verdict(days: number): { label: string; tone: 'dead' | 'poor' | 'ok' | 'great' } {
  if (days < 3) return { label: '直接死', tone: 'dead' };
  if (days < 21) return { label: '要天天/隔天充电', tone: 'poor' };
  if (days < 45) return { label: '尚可', tone: 'ok' };
  return { label: '达标(≈62 天量级)', tone: 'great' };
}

/** 全部方案的估算(按续航从好到坏) */
export function estimateAll(profile: PowerProfile): PowerBreakdown[] {
  return PANEL_OPTIONS.map((o) => estimateDaily(o, profile)).sort((a, b) => b.days - a.days);
}

/** 状态标签(与 UI 显示一致) */
export const STATE_NAME: Record<EyeState, string> = {
  nap: '打盹',
  sleep: '睡觉',
  idle: '睁眼待机',
  blink: '眨眼',
  look: '看主人',
  startled: '摇杯受惊',
  tilt: '倾斜跟随',
  content: '喝一口满足',
  sulky: '欠水蔫',
  smug: '得意',
  weak: '低电虚弱',
  forgotten: '被遗忘',
};
