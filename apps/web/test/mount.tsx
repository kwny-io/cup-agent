/**
 * 组件测试的挂载工具 —— 在 jsdom 上真挂载 React 组件(非浅渲染)。
 *
 * 为什么用真的 createRoot 而不是 mock 渲染器:组件里的交互(保存按钮、发送、
 * 表单提交)只有在真 DOM 上才走完整链路 —— 这正是要测的。DOM 由 test/setup.mjs 提供。
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

export interface Mounted {
  /** 组件挂载到的宿主元素 */
  host: HTMLElement;
  /** 重新渲染(更新 props) */
  render: (node: ReactNode) => void;
  /** 卸载并清理(每个测试收尾必调,单进程下防串味) */
  unmount: () => void;
  /** 按文本找元素(限本组件内) */
  byText: (text: string | RegExp) => HTMLElement | null;
}

export function mount(node: ReactNode): Mounted {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root: Root = createRoot(host);

  const render = (n: ReactNode) => {
    act(() => root.render(n));
  };
  render(node);

  return {
    host,
    render,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
    byText: (text) => {
      const wanted = typeof text === 'string' ? text : null;
      const re = typeof text === 'string' ? null : text;
      const all = host.querySelectorAll('*');
      for (const el of all) {
        const own = Array.from(el.childNodes)
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent ?? '')
          .join('')
          .trim();
        if ((wanted !== null && own === wanted) || (re && re.test(own))) {
          return el as HTMLElement;
        }
      }
      return null;
    },
  };
}

/** 真实点击(走原生事件派发,不直接调 handler)。 */
export function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/**
 * 提交表单 —— 派发原生 submit 事件。
 * 注意:React 的 onSubmit 只会收到我们派发的事件;表单的原生校验(noValidate 等)
 * 由组件自己处理,故这里用 `requestSubmit` 更真实地走浏览器语义(有 noValidate 时直接触发)。
 */
export function submit(form: HTMLFormElement): void {
  act(() => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
}

/** 在受控 input 上输入 —— 派发 input 事件并设值(React 受控组件靠此更新 state)。 */
export function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

/** 等一个微任务/宏任务周期,让 act 之外的 Promise 链(setState)落定。 */
export async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
