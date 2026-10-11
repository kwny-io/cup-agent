/**
 * ChatPanel 组件测试 —— 真挂载、真点击/真输入。
 *
 * ChatPanel 是纯展示:消息流与草稿由 useChat 持有,故这里塞一个假的 ChatController,
 * 专测它把状态渲染对、把交互回传对(改草稿、提交发消息、按钮禁用)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useState } from 'react';
import { ChatPanel } from '../src/components/ChatPanel.tsx';
import type { ChatController } from '../src/data/useChat.ts';
import { canSubmit, type ChatMsg } from '../src/lib/chat.ts';
import { mount, click, submit, type as typeInto } from './mount.tsx';

/** 造一个可控的 ChatController;send 记调用次数。 */
function fakeChat(over: Partial<ChatController> = {}): ChatController & { sent: number } {
  const msgs = over.msgs ?? [];
  const input = over.input ?? '';
  const pending = over.pending ?? false;
  const enabled = over.enabled ?? true;
  const ctl = {
    msgs,
    input,
    setInput: over.setInput ?? (() => {}),
    pending,
    enabled,
    canSend: over.canSend ?? (enabled && canSubmit(input) && !pending),
    send: over.send ?? (() => {}),
    sent: 0,
  } as ChatController & { sent: number };
  return ctl;
}

/** 让输入框真正受控:用一个带 state 的外壳把 setInput 接上。 */
function Harness({ chat }: { chat: ChatController }) {
  const [input, setInput] = useState(chat.input);
  const [sent, setSent] = useState(0);
  const ctl: ChatController = {
    ...chat,
    input,
    setInput,
    canSend: chat.enabled && canSubmit(input) && !chat.pending,
    send: () => setSent((n) => n + 1),
  };
  return createElement(
    'div',
    null,
    createElement(ChatPanel, { chat: ctl }),
    createElement('span', { 'data-sent': String(sent) }, ''),
  );
}

test('ChatPanel:空消息 + 已连后端 → 引导语;表单可用', () => {
  const { host, unmount } = mount(createElement(Harness, { chat: fakeChat() }));
  assert.match(host.textContent ?? '', /今天喝得怎么样/);
  const input = host.querySelector('input')!;
  assert.equal(input.disabled, false);
  assert.equal(input.placeholder, '跟杯子说点什么…');
  unmount();
});

test('ChatPanel:未连后端 → 提示"需连后端",输入框与发送钮都禁用', () => {
  const { host, unmount } = mount(
    createElement(Harness, { chat: fakeChat({ enabled: false }) }),
  );
  assert.match(host.textContent ?? '', /需连后端/);
  assert.match(host.textContent ?? '', /连上后端/); // 空态文案
  assert.equal((host.querySelector('input') as HTMLInputElement).disabled, true);
  assert.equal((host.querySelector('button') as HTMLButtonElement).disabled, true);
  unmount();
});

test('ChatPanel:渲染气泡 —— 用户靠右、杯子靠左、pending 显示"在想"', () => {
  const msgs: ChatMsg[] = [
    { id: 'u1', role: 'user', text: '你好', ts: 0 },
    { id: 'c1', role: 'cup', text: '', ts: 0, pending: true },
  ];
  const { host, unmount } = mount(createElement(Harness, { chat: fakeChat({ msgs }) }));
  const log = host.querySelector('[role="log"]')!;
  const rows = log.querySelectorAll(':scope > div');
  assert.equal(rows.length, 2);
  assert.match(rows[0].className, /justify-end/); // 用户靠右
  assert.match(rows[1].className, /justify-start/); // 杯子靠左
  assert.match(host.textContent ?? '', /在 想|在想/);
  unmount();
});

test('ChatPanel:LLM 出处打标;fallback 不打标', () => {
  const msgs: ChatMsg[] = [
    { id: 'c1', role: 'cup', text: '多喝点', ts: 0, source: 'llm' },
    { id: 'c2', role: 'cup', text: '好的', ts: 0, source: 'fallback' },
  ];
  const { host, unmount } = mount(createElement(Harness, { chat: fakeChat({ msgs }) }));
  assert.equal((host.textContent ?? '').match(/LLM/g)?.length, 1);
  unmount();
});

test('ChatPanel:打字进输入框 → 可发送;真实点击发送 → send 被调一次', () => {
  const { host, unmount } = mount(createElement(Harness, { chat: fakeChat() }));
  const input = host.querySelector('input')!;
  const btn = host.querySelector('button')!;
  assert.equal((btn as HTMLButtonElement).disabled, true, '空输入时发送禁用');

  typeInto(input, '今天喝得怎么样');
  assert.equal((btn as HTMLButtonElement).disabled, false, '有内容后可发送');

  click(btn);
  assert.equal(host.querySelector('[data-sent]')!.getAttribute('data-sent'), '1');
  unmount();
});

test('ChatPanel:表单 submit(回车)→ send 被调;preventDefault 生效', () => {
  const { host, unmount } = mount(createElement(Harness, { chat: fakeChat() }));
  typeInto(host.querySelector('input')!, '问一句');
  const form = host.querySelector('form')!;
  const ev = new window.Event('submit', { bubbles: true, cancelable: true });
  submit(form);
  assert.equal(host.querySelector('[data-sent]')!.getAttribute('data-sent'), '1');
  // 再显式验一次 preventDefault:构造可取消事件,派发后默认应被阻止
  const ev2 = new window.Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(ev2);
  assert.equal(ev2.defaultPrevented, true);
  void ev;
  unmount();
});

test('ChatPanel:pending 时 placeholder 变"杯子在想…还可以接着打"且发送禁用', () => {
  const { host, unmount } = mount(
    createElement(Harness, { chat: fakeChat({ pending: true, input: '在吗' }) }),
  );
  assert.match((host.querySelector('input') as HTMLInputElement).placeholder, /杯子在想/);
  assert.equal((host.querySelector('button') as HTMLButtonElement).disabled, true);
  unmount();
});
