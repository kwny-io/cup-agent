/**
 * 对话记忆 —— 接口 + 内存实现(与 Store 同款"接口先行")。
 *
 * 为什么要它:跨天召回是真实的"重启不丢"需求(ADR T14)—— 关掉再开,
 * 杯子还记得昨天聊过什么、你的目标是多少。原始遥测不是这种需求(丢掉无所谓)。
 *
 * 为什么 JSON 不 SQLite(P4):单进程、单用户,查询只有"某杯最近 N 轮" →
 * 一个文件足够,引 SQLite 是纯增压。FileChatStore 见 file-memory.ts。
 *
 * `profile()` = **长期画像**(跨会话的"它记得你")。**读写两端都已接**:
 *   · 读端(agent.ts):画像按字节封顶后注入系统提示,并把画像里的数字并入数字守卫的
 *     allow 集(否则复述画像数字会被判凭空)。
 *   · 写端(distill.ts):攒够新对话轮 → 再调一次 LLM 归纳成画像,过数字守卫后 `setProfile`。
 * `lastDistilledAt` 是蒸馏水位 —— distill.ts 据此判"攒够新轮没",随画像一起落盘。
 */

export interface ChatTurnRecord {
  cup_id: string;
  ts: number;
  role: 'user' | 'assistant' | 'proactive';
  text: string;
  tools_used?: string[];
  source?: 'llm' | 'fallback' | 'template';
}

export interface ChatStore {
  appendTurn(t: ChatTurnRecord): Promise<void>;
  /** 最近 N 轮(旧→新),按条数与字节双限 */
  recentTurns(cupId: string, limit: number): Promise<ChatTurnRecord[]>;
  /** 长期画像文本;没有 → null(读端已接:见 agent.ts 的 systemPrompt / 数字守卫) */
  profile(cupId: string): Promise<string | null>;
  setProfile(cupId: string, text: string): Promise<void>;
  /** 上次画像蒸馏的时刻(ms);从未蒸过 → 0(distill.ts 据此判"攒够新轮没") */
  lastDistilledAt(cupId: string): Promise<number>;
  setLastDistilledAt(cupId: string, ts: number): Promise<void>;
  /** 删该杯全部对话轮(删除第 4 阶段:`conversation` 档)。**硬删**,无墓碑。 */
  deleteTurns(cupId: string): Promise<void>;
  /** 删该杯长期画像 + 蒸馏水位(`conversation` 档;画像本是"聊过什么"的沉淀)。 */
  deleteProfile(cupId: string): Promise<void>;
  /** 落盘(内存实现是 no-op);app.close() 时调 */
  flush(): Promise<void>;
}

/** 每杯最多留这么多轮,免得文件无限长 */
export const MAX_TURNS_PER_CUP = 200;
/** 召回时按字节封顶(约 4KB),防止把超长历史灌进提示词 */
const MAX_RECALL_CHARS = 4000;
/** 长期画像的字节上限 —— 读端(agent.ts 注入)与写端(distill.ts 蒸馏)共用,单一口径 */
export const MAX_PROFILE_CHARS = 2000;

/** 追加一轮并按条数上限裁剪(内存/文件两个实现共用同一套规则) */
export function capTurns(arr: ChatTurnRecord[], t: ChatTurnRecord): ChatTurnRecord[] {
  const next = arr.concat(t);
  return next.length > MAX_TURNS_PER_CUP ? next.slice(next.length - MAX_TURNS_PER_CUP) : next;
}

/** 从尾部取最多 limit 轮、且总字节不超预算(旧→新)—— 内存/文件共用 */
export function windowTurns(arr: ChatTurnRecord[], limit: number): ChatTurnRecord[] {
  const tail = arr.slice(-limit);
  const out: ChatTurnRecord[] = [];
  let budget = MAX_RECALL_CHARS;
  for (let i = tail.length - 1; i >= 0; i--) {
    const rec = tail[i]!;
    budget -= rec.text.length;
    if (budget < 0) break;
    out.unshift(rec);
  }
  return out;
}

export class MemoryChatStore implements ChatStore {
  private turns = new Map<string, ChatTurnRecord[]>();
  private profiles = new Map<string, string>();
  private distilledAt = new Map<string, number>();

  async appendTurn(t: ChatTurnRecord): Promise<void> {
    this.turns.set(t.cup_id, capTurns(this.turns.get(t.cup_id) ?? [], t));
  }

  async recentTurns(cupId: string, limit: number): Promise<ChatTurnRecord[]> {
    return windowTurns(this.turns.get(cupId) ?? [], limit);
  }

  async profile(cupId: string): Promise<string | null> {
    return this.profiles.get(cupId) ?? null;
  }

  async setProfile(cupId: string, text: string): Promise<void> {
    this.profiles.set(cupId, text);
  }

  async lastDistilledAt(cupId: string): Promise<number> {
    return this.distilledAt.get(cupId) ?? 0;
  }

  async setLastDistilledAt(cupId: string, ts: number): Promise<void> {
    this.distilledAt.set(cupId, ts);
  }

  async deleteTurns(cupId: string): Promise<void> {
    this.turns.delete(cupId);
  }

  async deleteProfile(cupId: string): Promise<void> {
    this.profiles.delete(cupId);
    this.distilledAt.delete(cupId);
  }

  async flush(): Promise<void> {
    // 内存实现无持久,no-op
  }
}
