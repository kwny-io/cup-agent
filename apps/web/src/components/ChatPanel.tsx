/**
 * 「和杯子对话」卡片 —— 消息列表 + 输入框。
 *
 * 纯展示:消息流与输入草稿由 useChat 持有并**上提到 App**(跨 Tab / 跨布局保留),
 * 这里只渲染 + 把交互回传。所以窄屏独立 Tab 与宽屏看板内嵌卡共享同一份记录。
 */
import { useEffect, useRef } from 'react';
import { Card, Button, TextField } from './ui.tsx';
import { MAX_QUESTION, formatTime, type ChatMsg } from '../lib/chat.ts';
import type { ChatController } from '../data/useChat.ts';

export function ChatPanel({
  chat,
  fill = false,
  className = '',
}: {
  chat: ChatController;
  /** 占满父高(窄屏 chat Tab 用);否则固定矮高度(看板卡用) */
  fill?: boolean;
  className?: string;
}) {
  const { msgs, input, setInput, pending, enabled, canSend, send } = chat;
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // 仅当用户本来就贴着底部时才自动滚 —— 往上翻历史时不被新消息拽走
  const onScroll = () => {
    const el = listRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  return (
    <Card
      title="和杯子说句话"
      hint={enabled ? '问问它' : '需连后端'}
      className={`flex flex-col ${fill ? 'h-full' : ''} ${className}`}
    >
      <div
        ref={listRef}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-label="对话记录"
        className={`min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 ${fill ? '' : 'h-64'}`}
      >
        {msgs.length === 0 && (
          <p className="py-6 text-center text-xs text-cup-ink-soft">
            {enabled ? '问一句:今天喝得怎么样?' : '连上后端(?cloud=1)就能和杯子对话'}
          </p>
        )}
        {msgs.map((m) => (
          <Bubble key={m.id} msg={m} />
        ))}
      </div>

      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <TextField
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={MAX_QUESTION}
          placeholder={enabled ? (pending ? '杯子在想…还可以接着打' : '跟杯子说点什么…') : '未连接后端'}
          disabled={!enabled}
          aria-label="对话输入"
        />
        <Button type="submit" disabled={!canSend}>
          发送
        </Button>
      </form>
    </Card>
  );
}

/** 一条气泡:user 靠右(主色),cup 靠左(浅底);出处分 LLM/模板 */
function Bubble({ msg }: { msg: ChatMsg }) {
  const mine = msg.role === 'user';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
          mine
            ? 'bg-cup-deep text-cup-mist'
            : msg.failed
              ? 'bg-cup-foam text-cup-ink-soft'
              : 'bg-white/80 text-cup-ink ring-1 ring-cup-veil/60'
        }`}
      >
        {msg.pending ? (
          <span className="text-cup-ink-soft">杯子在想…</span>
        ) : (
          <span className="whitespace-pre-wrap break-words">{msg.text}</span>
        )}
        {!msg.pending && (
          <span
            className={`ml-2 align-bottom text-[10px] ${
              mine ? 'text-cup-mist/60' : 'text-cup-ink-soft/70'
            }`}
          >
            {formatTime(msg.ts)}
            {msg.source === 'llm' ? ' · LLM' : ''}
          </span>
        )}
      </div>
    </div>
  );
}
