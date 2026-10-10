/**
 * 持久化 —— 一个 JSON 文件承载**目标 + 对话轮 + 画像**(ADR T14)。
 *
 * 为什么是 JSON 不是 SQLite(P4 按需引入工具):
 *   · 单进程、单用户,查询只有"某杯最近 N 轮" → 一个文件足够
 *   · 引 SQLite = 一条原生依赖 + 迁移工具,为这几个读改写换来的是纯增压
 * 什么时候该换:多设备并发写、要按时间范围查历史、文件大到读不动 —— 那时再换,
 * 上层只认 ChatStore / onGoal 钩子,换实现不动调用方(T3「只换实现,不动上层」)。
 *
 * 为什么原子写:进程写到一半被 kill,半截 JSON 会毁掉全部历史。
 * 临时文件 + rename(同目录,rename 是原子操作)是防这个的最小手段。
 *
 * 为什么要去抖:每记一轮对话就 fsync 一次,长对话会把磁盘打满。
 * 攒到 flush 或 500ms 无写入时再落盘。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChatTurnRecord } from './chat/memory.ts';

export interface PersistState {
  /** cupId → 目标 ml */
  goals: Record<string, number>;
  /** cupId → 对话轮(旧→新) */
  turns: Record<string, ChatTurnRecord[]>;
  /** cupId → 长期画像文本 */
  profiles: Record<string, string>;
  /** cupId → 上次画像蒸馏时刻(ms);缺省视为从未蒸馏 */
  distilledAt: Record<string, number>;
}

const FLUSH_DEBOUNCE_MS = 500;

/**
 * 文件持久化。读一次(构造函数),之后内存里维护,定时/显式 flush 落盘。
 *
 * 用法:
 *   const p = new FilePersistence(dir);       // dir 默认 ./\.data
 *   const store = new MemoryStore({ goals: p.goals(), onGoal: (c, g) => { p.setGoal(c, g); } });
 */
export class FilePersistence {
  private readonly path: string;
  private readonly tmpPath: string;
  private state: PersistState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(dir: string) {
    this.path = join(dir, 'state.json');
    this.tmpPath = join(dir, 'state.json.tmp');
    this.state = FilePersistence.load(this.path);
  }

  /** 默认数据目录:环境变量优先,否则 ./.data */
  static defaultDir(): string {
    return process.env.CUP_DATA_DIR ?? './.data';
  }

  private static load(path: string): PersistState {
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistState>;
      return {
        goals: parsed.goals ?? {},
        turns: parsed.turns ?? {},
        profiles: parsed.profiles ?? {},
        distilledAt: parsed.distilledAt ?? {},
      };
    } catch {
      // 文件不存在 / 坏了 → 从空开始(坏文件不会让服务起不来)
      return { goals: {}, turns: {}, profiles: {}, distilledAt: {} };
    }
  }

  goals(): Record<string, number> {
    return { ...this.state.goals };
  }

  turns(): Record<string, ChatTurnRecord[]> {
    return this.state.turns;
  }

  profiles(): Record<string, string> {
    return { ...this.state.profiles };
  }

  distilledAt(): Record<string, number> {
    return { ...this.state.distilledAt };
  }

  setGoal(cupId: string, ml: number): void {
    this.state.goals[cupId] = ml;
    this.schedule();
  }

  setTurns(cupId: string, turns: ChatTurnRecord[]): void {
    this.state.turns[cupId] = turns;
    this.schedule();
  }

  setProfile(cupId: string, text: string): void {
    this.state.profiles[cupId] = text;
    this.schedule();
  }

  setDistilledAt(cupId: string, ts: number): void {
    this.state.distilledAt[cupId] = ts;
    this.schedule();
  }

  /** 攒一会儿再落盘 */
  private schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushSync();
    }, FLUSH_DEBOUNCE_MS);
    // 别让这个定时器拖住进程退出
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  private flushSync(): void {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.tmpPath, JSON.stringify(this.state), 'utf8');
      renameSync(this.tmpPath, this.path);
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
