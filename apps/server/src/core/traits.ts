/**
 * 人格档案存储(#72)—— 养成卡的**服务端那一半**:昵称 + 派生性格快照。
 *
 * 为什么单开一个 seam:http 层不该直接摸 `FilePersistence`(那会把文件实现焊进路由)。
 * 照 `ChatStore` 手法给接口 + 内存/文件两实现;文件实现挂在 `state.json` 的 `traits` 段上,
 * 与目标/对话记忆同一套去抖原子写(T3「只换实现,不动上层」)。
 *
 * **只存派生性格**(5 个数值 + 落盘时刻),不存原始饮水曲线、不存 `reason` 自由文本 ——
 * 与迁移码"纯本地、只带派生性格"的隐私口径一致。
 */
import type { FilePersistence, ProfileRecord } from './persist.ts';

export type { ProfileRecord };

export interface ProfileStore {
  get(cupId: string): Promise<ProfileRecord | null>;
  set(cupId: string, r: ProfileRecord): Promise<void>;
  /** 删该杯人格档案(删除第 4 阶段:`memory` 档)。**硬删**,无墓碑。 */
  delete(cupId: string): Promise<void>;
  flush(): Promise<void>;
}

export class MemoryProfileStore implements ProfileStore {
  private map = new Map<string, ProfileRecord>();

  async get(cupId: string): Promise<ProfileRecord | null> {
    return this.map.get(cupId) ?? null;
  }

  async set(cupId: string, r: ProfileRecord): Promise<void> {
    this.map.set(cupId, r);
  }

  async delete(cupId: string): Promise<void> {
    this.map.delete(cupId);
  }

  async flush(): Promise<void> {
    // 内存实现无持久,no-op
  }
}

export class FileProfileStore implements ProfileStore {
  private readonly file: FilePersistence;

  constructor(file: FilePersistence) {
    this.file = file;
  }

  async get(cupId: string): Promise<ProfileRecord | null> {
    return this.file.traits()[cupId] ?? null;
  }

  async set(cupId: string, r: ProfileRecord): Promise<void> {
    this.file.setTraits(cupId, r);
  }

  async delete(cupId: string): Promise<void> {
    this.file.dropTraits(cupId);
  }

  async flush(): Promise<void> {
    await this.file.flush();
  }
}
