/**
 * 对话状态钩子 —— 消息流**上提到 App**,不留在 ChatPanel 里。
 *
 * 为什么:窄屏有独立「对话」Tab、宽屏看板内嵌一张卡,是两个不同的 ChatPanel;
 * 若状态跟着组件走,切 Tab 就卸载重建 → 聊天记录丢。放在这里(只在 App 调一次),
 * 记录与输入框草稿跨 Tab、跨布局都保留。
 *
 * 逻辑本体仍是 lib/chat.ts 的纯函数;这里只做 React 状态编排。
 */
import { useEffect, useRef, useState } from 'react';
import {
  appendMsg,
  canSubmit,
  cupMsg,
  failedMsg,
  pendingMsg,
  proactiveKey,
  proactiveMsg,
  resolvePending,
  userMsg,
  type ChatMsg,
} from '../lib/chat.ts';
import type { AskFn, ProactiveMessage } from './source.ts';

export interface ChatController {
  msgs: ChatMsg[];
  input: string;
  setInput: (v: string) => void;
  /** 已发出、等后端回复 */
  pending: boolean;
  /** 是否接了可问答的源(非云源为 false) */
  enabled: boolean;
  canSend: boolean;
  send: () => void;
}

export function useChat(ask: AskFn | null, proactive: ProactiveMessage[]): ChatController {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const seq = useRef(0);
  /** 已并入消息流的主动搭话键(按内容+时刻),防重连/重渲染重复入列 */
  const seen = useRef(new Set<string>());
  const nextId = () => `m${seq.current++}`;
  // 双击竞态:setState 是异步的,同一 tick 内两次 send 都会读到旧的 pending=false。
  // 用同步的 ref 当闸门,pending state 只管渲染。
  const sendingRef = useRef(false);

  // 新到的主动搭话并进消息流(去重见 proactiveKey)
  useEffect(() => {
    const fresh = proactive.filter((m) => !seen.current.has(proactiveKey(m)));
    // 集合重建成"当前窗口的 key",而不是只加不删 ——
    // 旧 key 已不在 proactive 里、再也不会来,留着只会让长驻页面缓慢泄漏。
    seen.current = new Set(proactive.map(proactiveKey));
    if (fresh.length === 0) return;
    setMsgs((prev) => fresh.reduce((acc, m) => appendMsg(acc, proactiveMsg(m, nextId())), prev));
  }, [proactive]);

  const send = () => {
    if (!ask || sendingRef.current || !canSubmit(input)) return;
    const q = input.trim();
    const now = Date.now();
    const uid = nextId();
    const pid = nextId();
    sendingRef.current = true;
    setInput('');
    setMsgs((prev) => appendMsg(appendMsg(prev, userMsg(q, now, uid)), pendingMsg(now, pid)));
    setPending(true);
    // ask 契约上从不 reject,但仍兜一层:任何意外都保证释放闸门、出失败气泡
    void ask(q)
      .then((res) => {
        const reply = res.ok
          ? cupMsg(res.answer, Date.now(), pid)
          : failedMsg(res.reason, Date.now(), pid);
        setMsgs((prev) => resolvePending(prev, pid, reply));
      })
      .catch(() => {
        setMsgs((prev) => resolvePending(prev, pid, failedMsg('error', Date.now(), pid)));
      })
      .finally(() => {
        sendingRef.current = false;
        setPending(false);
      });
  };

  const enabled = ask !== null;
  return { msgs, input, setInput, pending, enabled, canSend: enabled && !pending && canSubmit(input), send };
}
