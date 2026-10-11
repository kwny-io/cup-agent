/**
 * JSON 单文件持久化基类 —— "内存里维护 + 去抖原子落盘"的通用骨架。
 *
 * 为什么抽基类:`state.json`(persist.ts)与 `social.json`(社交域)是**两个文件**,
 * 但"读到内存 → 改 → 攒一会儿 → tmp+rename 原子写"这套机制**完全一样**。
 * 各写一份必然漂;提上来一份,两个域共用(T3「只换实现,不动上层」的又一落点)。
 *
 * 子类只需:`super(path, defaults, hydrate)` + 用 `this.state` 读写 + 改后 `this.touch()`。
 */
import { readFileSync } from 'node:fs';
import { atomicWriteJson } from './persist.ts';

export const FLUSH_DEBOUNCE_MS = 500;

export class JsonFile<T extends object> {
  protected readonly path: string;
  protected state: T;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private readonly hydrate: (parsed: Partial<T>) => T;

  constructor(path: string, defaults: T, hydrate?: (parsed: Partial<T>) => T) {
    this.path = path;
    this.state = defaults;
    this.hydrate = hydrate ?? ((p) => ({ ...defaults, ...p }));
    this.state = this.read();
  }

  private read(): T {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<T>;
      return this.hydrate(parsed);
    } catch {
      // 文件不存在 / 坏了 → 从空开始(坏文件不该让服务起不来)
      return this.hydrate({});
    }
  }

  /** 标脏并安排一次去抖落盘(unref,不拖住进程退出) */
  protected touch(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushSync();
    }, FLUSH_DEBOUNCE_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** 公开的去抖落盘入口(给"持有 JsonFile 但不继承它"的 store 用) */
  flushSoon(): void {
    this.touch();
  }

  /** 直接读写内存态(改完记得 flushSoon)—— 调用方持有引用,不返回拷贝 */
  get data(): T {
    return this.state;
  }

  private flushSync(): void {
    if (!this.dirty) return;
    try {
      atomicWriteJson(this.path, this.state);
      this.dirty = false;
    } catch {
      // 落盘失败不该让服务崩;下次 flush 再试
    }
  }

  /** 立即落盘(app.close() / 进程退出前调) */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flushSync();
  }
}
