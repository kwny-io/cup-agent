/**
 * 落盘的对话记忆 —— `ChatStore` 的第二个实现,复用 `FilePersistence`(ADR T14)。
 *
 * 为什么单独一个文件:persist.ts 已经从 memory.ts 借类型,若把 FileChatStore 塞进
 * memory.ts 就会绕回来 import persist.ts → 循环。放这里两边都不欠。
 *
 * 与 MemoryChatStore 的唯一差别就是"关掉再开还在":所以裁剪规则(`capTurns` /
 * `windowTurns`)**共用同一套函数**,绝不各写一份 —— 否则两个实现会漂。
 */
import type { FilePersistence } from '../persist.ts';
import {
  capTurns,
  windowTurns,
  type ChatStore,
  type ChatTurnRecord,
} from './memory.ts';

export class FileChatStore implements ChatStore {
  private readonly file: FilePersistence;
  private readonly turns: Record<string, ChatTurnRecord[]>;

  constructor(file: FilePersistence) {
    this.file = file;
    this.turns = file.turns(); // 已从磁盘读回并挂在 state 上,这里持有同一个引用
  }

  appendTurn(t: ChatTurnRecord): void {
    const next = capTurns(this.turns[t.cup_id] ?? [], t);
    this.turns[t.cup_id] = next;
    this.file.setTurns(t.cup_id, next); // 触发去抖落盘
  }

  recentTurns(cupId: string, limit: number): ChatTurnRecord[] {
    return windowTurns(this.turns[cupId] ?? [], limit);
  }

  profile(cupId: string): string | null {
    return this.file.profiles()[cupId] ?? null;
  }

  setProfile(cupId: string, text: string): void {
    this.file.setProfile(cupId, text);
  }

  lastDistilledAt(cupId: string): number {
    return this.file.distilledAt()[cupId] ?? 0;
  }

  setLastDistilledAt(cupId: string, ts: number): void {
    this.file.setDistilledAt(cupId, ts);
  }

  async flush(): Promise<void> {
    await this.file.flush();
  }
}
