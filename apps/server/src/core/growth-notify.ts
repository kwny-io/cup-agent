/**
 * 成长庆祝下行 —— 养成闭环的**设备侧**出口:今天新跨里程碑 → 给杯子发一条提醒,让它"高兴一下"。
 *
 * 为什么单独一只小对象而不是塞进 pipeline:`Pipeline` 只管"帧 → 存储 + 广播",
 * 不认识 `CommandQueue`(下行队列),也不想认识。这里用 `PipelineEvents.event` 这个**已有**的
 * 观察口挂上去 —— 管线照样只做它的事,庆祝是**旁挂的观察者**,改不动写路径。
 *
 * 端侧分工(与 B 说好):**业务判定全在后端** —— 哪道坎、id、label 都由 `deriveGrowth` 算好,
 * 固件只认 `payload.reason === 'milestone'` 播一段庆祝表情,不做任何判定(P3)。
 *
 * 契约零改动:复用既有 `remind` 下行,`payload` 本就是自由键值记录(§2.1),
 * 新增 `reason:'milestone'` 是加法。
 *
 * 就地判"今天":`dayKey(Date.now())` 与 `deriveGrowth` 的窗口末位(今天)同源,
 * 故 `celebrate` 非 null ⟺ 今天这道坎刚被跨过 —— 天然"今天一次",不天天庆祝。
 */
import type { Command } from '@cup/contract';
import type { CupEvent } from '@cup/contract';
import { DEFAULT_DEVICE_TARGET, type CommandQueue } from './commands.ts';
import { deriveGrowth } from './growth.ts';
import { dayKey } from './day-boundary.ts';
import type { LogLevel } from './logger.ts';

/** 庆祝窗口 —— 与 http.ts 的 GROWTH_DAYS 同口径(够覆盖最深里程碑) */
const GROWTH_DAYS = 730;
const CELEBRATE_TTL_MS = 6 * 3_600_000;
/** 已庆祝去重表上限(简单游标,够用;超出清一半) */
const SEEN_MAX = 4096;

/** 只需要 `recentAggs` 这一只读方法,收窄依赖便于测试(不依赖整个 Store)。 */
export interface GrowthNotifyStore {
  recentAggs(cupId: string, date: string, days: number): Promise<Parameters<typeof deriveGrowth>[0]>;
}

export interface GrowthNotifyDeps {
  store: GrowthNotifyStore;
  commands: CommandQueue;
  /** 可注入时钟(测试用);默认 Date.now */
  now?: () => number;
  /** 下行目标设备;默认 DEFAULT_DEVICE_TARGET(真机配网前 lid-*) */
  target?: string;
  /** 只用来记一行旁路日志;与 claim/sim-adapter 同款 callable 形态 */
  log?: (msg: string, level?: LogLevel) => void;
}

/**
 * 事件落定后跑:今天新跨坎 → 入队一条 `remind(reason=milestone)`。
 * 纯旁路:任何异常都吞掉并记日志 —— 庆祝失败**绝不能**影响 ingest 主路径。
 */
export function makeGrowthNotifier(deps: GrowthNotifyDeps): (e: CupEvent) => void {
  const now = deps.now ?? Date.now;
  const target = deps.target ?? DEFAULT_DEVICE_TARGET;
  // 已庆祝去重:celebrate 是**无状态派生** —— 只要窗口覆盖到今天跨的那道坎,今天之内
  // 每处理一个事件它都会给出同一个 id。若不去重,一杯水灌 7 条事件就给设备发 7 条提醒。
  // 键含日期,故跨天自然失效(明天若要庆祝新坎,是新 key)。
  const seen = new Set<string>();
  // 每杯一条串行链:event 回调同步、内部 async,若并发跑,多个事件会在 `seen` 记录之前
  // 都读到 celebrate → 都入队(重复)。按杯串行,判定-记录-入队成为不可分割的一步。
  // 用链而非"进杯即锁":同一天稍晚才跨的坎仍能被那之后的事件触发(不能一早锁死整日)。
  const chains = new Map<string, Promise<void>>();

  return (e: CupEvent): void => {
    const prev = chains.get(e.cup_id) ?? Promise.resolve();
    const next = prev.then(() => celebrateOnce(e)).catch(() => {});
    chains.set(e.cup_id, next);
  };

  async function celebrateOnce(e: CupEvent): Promise<void> {
    try {
      const today = dayKey(now());
      const recent = await deps.store.recentAggs(e.cup_id, today, GROWTH_DAYS);
      const { celebrate } = deriveGrowth(recent);
      if (!celebrate) return; // 今天没跨坎 → 不发(不天天庆祝)

      const key = `${e.cup_id}|${today}|${celebrate.id}`;
      if (seen.has(key)) return; // 今天这道坎已经庆祝过,别再发
      // 有界:超上限丢一半(与 pipeline 的 seenEvents 同款简单游标)
      if (seen.size > SEEN_MAX) {
        for (const k of [...seen].slice(0, SEEN_MAX / 2)) seen.delete(k);
      }
      seen.add(key);

      const ts = now();
      const cmd: Command = {
        v: 1,
        cmd_id: `ms-${key}-${ts}`,
        target,
        ts,
        expires_at: ts + CELEBRATE_TTL_MS,
        type: 'remind',
        payload: {
          reason: 'milestone',
          id: celebrate.id,
          label: celebrate.label,
          kind: celebrate.kind,
          threshold: celebrate.threshold,
        },
      };
      deps.commands.enqueue(cmd);
      deps.log?.(`成长庆祝下行入队 cup=${e.cup_id} milestone=${celebrate.id}`);
    } catch (err) {
      // 庆祝是旁路,失败只记不抛(主路径已成功落库)
      deps.log?.(`成长庆祝判定失败(忽略)cup=${e.cup_id} err=${String(err)}`, 'warn');
    }
  }
}
