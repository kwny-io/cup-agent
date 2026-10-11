/**
 * 每日目标的纯逻辑 —— 解析 / 校验 / 离线持久化。
 *
 * 抽到 lib 是为了**可测**:逻辑与渲染分离,"什么输入算合法、离线怎么存"能直接单测。
 * GoalCard 只负责把这些接到 React 状态上。
 *
 * 校验规则**对齐后端** `apps/server/src/api/http.ts` 的 setGoal:
 *   PUT /cups/:id/goal,体 { goal_ml },后端 `goal <= 0 || goal > 10_000` → 400。
 *   即合法域是整数 [1, 10000]。前端先拦一道,别等后端 400 才发现。
 */
import { DAILY_GOAL_ML } from './stats.ts';

/** 目标合法域(与后端 setGoal 一致:0 与负值、>10000 都非法) */
export const GOAL_MIN = 1;
export const GOAL_MAX = 10_000;

/** 解析结果:合规给 {ok:true,value},否则给一句能直接显示的人话 */
export type GoalParse = { ok: true; value: number } | { ok: false; reason: string };

/**
 * 把输入框里的字符串解析成合法目标。
 * 只认整数(ml 粒度;后端也按整数存)→ 小数/科学计数法/空/越界都拦下。
 */
export function parseGoal(raw: string): GoalParse {
  const t = raw.trim();
  if (t === '') return { ok: false, reason: '请输入目标值' };
  if (!/^\d+$/.test(t)) return { ok: false, reason: '只能填整数(毫升)' };
  const n = Number(t);
  if (n < GOAL_MIN) return { ok: false, reason: `目标至少 ${GOAL_MIN} ml` };
  if (n > GOAL_MAX) return { ok: false, reason: `目标最多 ${GOAL_MAX} ml` };
  return { ok: true, value: n };
}

// ── 离线持久化(仅 mock 源用;云源以后端为准,不落 localStorage)──────

const LS_KEY = 'cup.goalMl';

/**
 * 读本地存的目标;没存过 / 解析不出 → 回落到约定默认目标。
 * 存储不可用(隐私模式等)时静默回落,不能让"读个设置"把页面搞崩。
 */
export function loadGoal(fallback = DAILY_GOAL_ML): number {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw === null) return fallback;
    const p = parseGoal(raw);
    return p.ok ? p.value : fallback;
  } catch {
    return fallback;
  }
}

/** 存目标。存储不可用时静默 —— 目标本次会话仍生效,只是刷新后丢。 */
export function saveGoal(ml: number): void {
  try {
    localStorage.setItem(LS_KEY, String(ml));
  } catch {
    /* 隐私模式 / 配额满:忽略,不影响当前会话 */
  }
}
