/**
 * 日界 —— "今天"是哪个自然日、那天从哪一刻开始。
 *
 * 默认用**服务器本地时区**(MVP 单机够用);启动时可由 `--tz`/`CUP_TZ` 设成一个固定
 * IANA 时区(如 `Asia/Shanghai`),让多时区用户的"今天"一致。时区是**进程级开关**,
 * 启动时设一次;不设 = 老行为(本地时区),对现有部署零影响。
 *
 * 为什么不用第三方 tz 库:Node 自带完整 ICU,`Intl.DateTimeFormat` 就能拿到任意时区的
 * 墙钟字段与偏移,足够算日界;引库违背原则 P4(不为一件小事加依赖)。
 */

/** 配置的 IANA 时区;null = 用服务器本地时区。 */
let dayTz: string | null = null;
/** dayKey 用的 formatter 缓存(设了 tz 才建)。 */
let dayKeyFmt: Intl.DateTimeFormat | null = null;
/** tzOffsetMs 用的 formatter 缓存。 */
let wallClockFmt: Intl.DateTimeFormat | null = null;

const PAD = (n: number): string => String(n).padStart(2, '0');

/**
 * 设置日界时区(需在启动时调用一次)。
 * @param tz IANA 名(如 `'Asia/Shanghai'`);`null` 恢复服务器本地时区。
 * @throws 非法时区名(启动期早失败,别等运行到半夜才炸)。
 */
export function setDayTimeZone(tz: string | null): void {
  if (tz !== null) {
    // 构造会抛 RangeError,即非法时区
    dayKeyFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    wallClockFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } else {
    dayKeyFmt = null;
    wallClockFmt = null;
  }
  dayTz = tz;
}

/** 当前日界时区;null = 服务器本地时区。 */
export function getDayTimeZone(): string | null {
  return dayTz;
}

/**
 * Unix ms → 该时区下的自然日 `'YYYY-MM-DD'`。
 * 默认(未配时区)走本地,与旧实现逐字节一致。
 */
export function dayKey(ts: number): string {
  if (dayTz === null) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`;
  }
  const parts = dayKeyFmt!.formatToParts(ts);
  const g = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/** 某 Unix 时刻在其配置时区里的偏移(ms,东为正)。 */
function tzOffsetMs(ts: number, fmt: Intl.DateTimeFormat): number {
  const parts = fmt.formatToParts(ts);
  const g = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
  // 墙钟各字段当作 UTC 解析 → 与真实 ts 的差即偏移
  const wallAsUtc = Date.UTC(
    g('year'),
    g('month') - 1,
    g('day'),
    g('hour') % 24,
    g('minute'),
    g('second'),
  );
  return wallAsUtc - ts;
}

/**
 * `'YYYY-MM-DD'`(该时区下的自然日)→ 那天的 00:00 的 Unix ms。
 * 两遍求解以正确处理有 DST 的时区:先用 UTC 零点估偏移,再用修正后的时刻复算。
 */
export function dayStart(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  if (dayTz === null) {
    return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getTime();
  }
  const guess = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  const off1 = tzOffsetMs(guess, wallClockFmt!);
  const off2 = tzOffsetMs(guess - off1, wallClockFmt!);
  return guess - off2;
}

/** 相邻自然日:date ± n 天,返回 `'YYYY-MM-DD'`(与时区无关的纯日历运算)。 */
export function shiftDay(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  // 用 UTC 运算避免本地 DST 干扰"日历 +n 天"
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + n));
  return `${dt.getUTCFullYear()}-${PAD(dt.getUTCMonth() + 1)}-${PAD(dt.getUTCDate())}`;
}
