/**
 * 对话线的纯函数 —— 消息构造 / 守卫 / 裁剪 / 时间格式化。
 *
 * 全抽到这里是为了**可测**:逻辑与渲染分离,"该不该发、消息怎么造、
 * 列表怎么裁、占位怎么替换"能直接单测,不必渲染。ChatPanel 只负责把它们接到 React 状态上。
 */
import type { AskFailure, ChatAnswer, ProactiveMessage } from '../data/source.ts';

/** user = 我问的;cup = 杯子说的(答复 + 主动搭话都算) */
export type ChatRole = 'user' | 'cup';

export interface ChatMsg {
  id: string;
  role: ChatRole;
  text: string;
  ts: number;
  /** 杯子消息的出处:LLM 还是模板兜底;用户消息没有 */
  source?: 'llm' | 'fallback';
  /** 已发出、等回复时的占位气泡 */
  pending?: boolean;
  /** 答不上来(后端没起 / 超时)—— 灰气泡,不算正常回答 */
  failed?: boolean;
}

/** 单条问题上限:防手滑粘一大段把后端 prompt 撑爆 */
export const MAX_QUESTION = 200;
/** 列表保留条数 */
export const MAX_MESSAGES = 60;

/** 能不能发:非空且不超上限(首尾空白不算内容) */
export function canSubmit(input: string): boolean {
  const t = input.trim();
  return t.length > 0 && t.length <= MAX_QUESTION;
}

/** 追加一条,超出上限从头裁掉 */
export function appendMsg(list: ChatMsg[], msg: ChatMsg): ChatMsg[] {
  return [...list, msg].slice(-MAX_MESSAGES);
}

export function userMsg(text: string, ts: number, id: string): ChatMsg {
  return { id, role: 'user', text: text.trim(), ts };
}

/** 发出去、等后端回复时的占位气泡 */
export function pendingMsg(ts: number, id: string): ChatMsg {
  return { id, role: 'cup', text: '', ts, pending: true };
}

export function cupMsg(ans: ChatAnswer, ts: number, id: string): ChatMsg {
  return { id, role: 'cup', text: ans.text, ts, source: ans.source };
}

/** 失败原因 → 一句人话;每种都不同,便于用户/排障区分 */
const FAIL_TEXT: Record<AskFailure, string> = {
  offline: '……(连不上后端)',
  timeout: '……(想了太久,走神了)',
  error: '……(后端好像出了问题)',
  invalid: '……(没听懂你在问什么)',
};

/** 没答上来时的诚实占位,按原因给不同措辞,不编一句假的答复冒充杯子 */
export function failedMsg(reason: AskFailure, ts: number, id: string): ChatMsg {
  return { id, role: 'cup', text: FAIL_TEXT[reason], ts, failed: true };
}

/** 杯子主动搭话 → 聊天气泡(走 WS,与问答同一条流) */
export function proactiveMsg(m: ProactiveMessage, id: string): ChatMsg {
  return { id, role: 'cup', text: m.text, ts: m.ts, source: m.source };
}

/**
 * 主动消息去重键。proactive 是**滚动数组**(旧条会被挤掉),
 * 所以按"内容+时刻"判重,而不是按下标 —— 挤掉再进来也不会重复。
 */
export function proactiveKey(m: ProactiveMessage): string {
  return `${m.ts}|${m.text}`;
}

/**
 * 把 pending 占位换成最终结果(含失败)。
 *
 * 关键:**找不到 pendingId 就追加**,而不是静默丢掉。慢回复(LLM 秒级)
 * 期间若列表被 appendMsg 裁到窗口外,占位气泡会先被挤掉 —— 此时若只是
 * map 找不到就算了,答复就凭空消失。追加能保证"问了必有回音"。
 */
export function resolvePending(list: ChatMsg[], pendingId: string, result: ChatMsg): ChatMsg[] {
  let found = false;
  const next = list.map((m) => {
    if (m.id === pendingId) {
      found = true;
      return result;
    }
    return m;
  });
  return found ? next : appendMsg(next, result);
}

/** HH:MM(本地时区),气泡角标用 */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
