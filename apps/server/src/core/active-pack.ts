/**
 * 每杯"当前生效的人格包"—— `cup_id → pack_id`(一只杯穿一件)。
 *
 * ── 为什么不挂在账号(订阅)上 ─────────────────────────────────────
 * `subscriptions` 是 **per-USER**(「我订了 5 个包」);本表是 **per-CUP**(「我这只杯穿着哪件」)。
 * 「订了」≠「穿着」—— 两条独立关系,别混。PUT 只落本表一行,不写回 subscriptions。
 *
 * ── 为什么独立表(不复用 cup_settings)────────────────────────────
 * 见 `store/pg/migrations/0007_cup_active_pack.sql` 头注:`forget('all')` 整行删 `cup_settings`,
 * 复用会静默卸包;且 goal(设备域)与生效包(账号域)是两个鉴权域。
 *
 * ── 本 store 的职责边界 ──────────────────────────────────────────
 * 只存**关系**(cup → pack_id),**不存包全文**。包全文由 pack store(`accounts.packById`)给 ——
 * 这样内存实现无需依赖 packs 数据源,三种实现语义得以一致(只换实现、不动上层)。
 * "包存在且 status='approved'" 的校验在路由侧(取包的出口已有该口径),不落在这里。
 *
 * strip-only 约束:无 enum、无参数属性,全显式字段。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from './persist.ts';

// ── 存储口(接口 + 内存/文件两实现)─────────────────────────────

export interface CupActivePackStore {
  /** 该杯当前生效包的 id;没装 → null。 */
  get(cupId: string): Promise<string | null>;
  /** 装到这只杯(幂等:同 cup 覆盖)。 */
  set(cupId: string, packId: string): Promise<void>;
  /** 卸下(回到默认体质);无行 → no-op。 */
  clear(cupId: string): Promise<void>;
  flush(): Promise<void>;
}

export class MemoryActivePackStore implements CupActivePackStore {
  private map = new Map<string, string>();

  async get(cupId: string): Promise<string | null> {
    return this.map.get(cupId) ?? null;
  }
  async set(cupId: string, packId: string): Promise<void> {
    this.map.set(cupId, packId);
  }
  async clear(cupId: string): Promise<void> {
    this.map.delete(cupId);
  }
  async flush(): Promise<void> {
    // 内存实现无持久,no-op
  }
}

/**
 * 文件实现:整体落 `active-pack.json`(独立文件,与 state.json / cup-llm.json 同套原子写)。
 */
export class FileActivePackStore implements CupActivePackStore {
  private readonly path: string;
  private readonly map: Map<string, string>;

  constructor(path: string) {
    this.path = path;
    this.map = new Map();
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { cups?: Record<string, string> };
      for (const [k, v] of Object.entries(raw.cups ?? {})) this.map.set(k, v);
    } catch {
      // 文件不存在 / 损坏 → 空起(不该让服务起不来)
    }
  }

  async get(cupId: string): Promise<string | null> {
    return this.map.get(cupId) ?? null;
  }
  async set(cupId: string, packId: string): Promise<void> {
    this.map.set(cupId, packId);
    this.save();
  }
  async clear(cupId: string): Promise<void> {
    if (this.map.delete(cupId)) this.save();
  }
  async flush(): Promise<void> {
    this.save();
  }
  private save(): void {
    atomicWriteJson(this.path, { cups: Object.fromEntries(this.map) });
  }
}

/** 文件实现的默认落点:`<dataDir>/active-pack.json` */
export function activePackFilePath(dataDir: string): string {
  return join(dataDir, 'active-pack.json');
}
