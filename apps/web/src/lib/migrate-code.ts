/**
 * 迁移码 —— 「把这只杯子带去别处」的**纯本地**编解码(#72 养成卡写半)。
 *
 * 口径(用户拍板「纯本地、只带派生性格」):
 *   · 只编码**派生性格快照**(脾气 + 4 个数值)+ 生成日期 + 昵称;
 *   · **不含**聊天文本、不含原始饮水曲线 —— 与好友互见 / #72 档案同一隐私口径;
 *   · 编解码**全在前端**,零后端改动、零依赖。
 *
 * 格式(手写,给"人肉抄一串"用,故短且带校验和):
 *
 *     CUP1-<base64url(紧凑 JSON UTF-8)>-<校验和>
 *
 *   · `CUP1`        —— 版本前缀(将来换格式时改这里,老码自然报"版本不认")
 *   · base64url     —— 紧凑 JSON 的 UTF-8 字节(昵称可能是中文,不能直接 btoa)
 *   · 校验和        —— FNV-1a 32 位取 base36;抄漏/改一字节 → 解出来对不上 → 明确报错
 *
 * 为什么带校验和:用户会手抄、会微信转发、可能被截断 —— 必须能区分
 * "这码被弄坏了"和"这是个好码但内容为空",而不是解出一堆垃圾。
 *
 * 抽到 lib 是为了**可测**:往返一致、篡改必败、坏形状不崩,都能直接单测。
 */
import type { TraitRecord } from '../data/source.ts';

export interface MigratePayload {
  traits: TraitRecord;
  /** 生成日期(ms)—— 即 traits.updated_at,单独拎出来好读好展示 */
  createdAt: number;
  nickname: string;
}

export type MigrateDecode =
  | { ok: true; payload: MigratePayload }
  | { ok: false; error: string };

/** 版本前缀。换格式时递增,旧码会在解码时被明确拒绝(不静默解出错的)。 */
export const MIGRATE_PREFIX = 'CUP1';
const SEP = '-';

/** 紧凑 JSON 的短键 —— 迁移码要短,全名键太占地方 */
interface Wire {
  d: string; // disposition
  l: number; // level
  s: number; // streak
  w: number; // warmth
  r: number; // refill_habit
  t: number; // updated_at / createdAt
  n: string; // nickname
}

const DISPOSITIONS = new Set(['sulky', 'normal', 'smug']);

/**
 * UTF-8 字符串 → base64url。btoa 只吃 latin1,中文昵称会炸,故先手写 UTF-8 编码。
 * base64url(把 +/ 换成 -_,去掉 =)比标准 base64 更适合放进"可粘贴的码"。
 */
function utf8ToBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToUtf8(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** FNV-1a 32 位 → base36(短校验和;不是加密,只挡抄错/截断) */
function checksum(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** 三位小数取整 —— 数值都是 0..1 或小整数,不需要全精度,短一点更好抄 */
function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * 编码:派生性格 + 生成日期 + 昵称 → 一串可粘贴的迁移码。
 * traits 由调用方从后端档案(GET /cups/:id/profile)取,这里**不再校验数值域**
 * (那是 decode 的活:外部输入才需要防);编码方是可信的内部数据。
 */
export function encodeMigrateCode(traits: TraitRecord, nickname: string): string {
  const wire: Wire = {
    d: traits.disposition,
    l: r3(traits.level),
    s: Math.round(traits.streak),
    w: r3(traits.warmth),
    r: r3(traits.refill_habit),
    t: Math.round(traits.updated_at),
    n: nickname.slice(0, 24),
  };
  const body = utf8ToBase64Url(JSON.stringify(wire));
  return `${MIGRATE_PREFIX}${SEP}${body}${SEP}${checksum(body)}`;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * 解码:迁移码 → 派生性格 + 生成日期 + 昵称。
 *
 * 外部输入,**一律不信任**:版本不符 / 校验和对不上 / 形状不对,都给明确 error
 * (UI 直接显示这句人话)。数值做区间钳制(万一被手改成越界值也不至于喂坏下游)。
 * **从不 throw** —— 坏码就是 {ok:false, error},调用方一条路径处理。
 */
export function decodeMigrateCode(code: string): MigrateDecode {
  const raw = (code ?? '').trim();
  if (raw === '') return { ok: false, error: '迁移码为空' };

  // 在**首尾**两个分隔符处切,而不是 split('-') —— base64url 字母表里也有 `-`,
  // body 可能自带 `-`,按全部 `-` 切会切碎。前缀与校验和(base36)都不含 `-`,
  // 故首/末两个 `-` 位置唯一确定三段。
  const first = raw.indexOf(SEP);
  const last = raw.lastIndexOf(SEP);
  if (first <= 0 || last <= first) return { ok: false, error: '迁移码格式不对' };
  const prefix = raw.slice(0, first);
  const body = raw.slice(first + 1, last);
  const sum = raw.slice(last + 1);
  if (body === '' || sum === '') return { ok: false, error: '迁移码格式不对' };
  if (prefix !== MIGRATE_PREFIX) {
    return { ok: false, error: `不认识的迁移码版本:${prefix || '(空)'}` };
  }
  if (checksum(body) !== sum) {
    return { ok: false, error: '迁移码校验失败(可能抄漏或改动过)' };
  }

  let wire: Record<string, unknown>;
  try {
    wire = asRecord(JSON.parse(base64UrlToUtf8(body)));
  } catch {
    return { ok: false, error: '迁移码内容解不开(损坏)' };
  }

  const d = wire.d;
  if (typeof d !== 'string' || !DISPOSITIONS.has(d)) {
    return { ok: false, error: '迁移码里的性格值不合法' };
  }
  const num = (v: unknown, lo: number, hi: number): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null;

  const level = num(wire.l, 0, 1);
  const streak = num(wire.s, 0, 100_000);
  const warmth = num(wire.w, 0, 1);
  const refill = num(wire.r, 0, 1);
  const t = num(wire.t, 0, Number.MAX_SAFE_INTEGER);
  if (level === null || streak === null || warmth === null || refill === null || t === null) {
    return { ok: false, error: '迁移码里的数值不完整' };
  }

  const nickname = typeof wire.n === 'string' ? wire.n.slice(0, 24) : '';
  const traits: TraitRecord = {
    disposition: d as TraitRecord['disposition'],
    level: clamp01(level),
    streak: Math.round(streak),
    warmth: clamp01(warmth),
    refill_habit: clamp01(refill),
    updated_at: Math.round(t),
  };
  return { ok: true, payload: { traits, createdAt: Math.round(t), nickname } };
}

/** 生成日期 → 展示用 YYYY-MM-DD(纯字符串拼,避免时区把日期挪一天) */
export function createdAtLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '未知';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
