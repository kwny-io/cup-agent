/**
 * 社交域类型 —— 账号 / 会话 / 人格市场包 / 好友。**设备协议无关**,故不入 contract。
 *
 * 为什么单独一个域:这是"多用户地基"(用户选「真账号体系」),与 cup 的遥测/聚合解耦。
 * 账号↔杯子的归属是**后续阶段**;本轮只把身份与社交关系立起来。
 * 持久化见 accounts.ts(内存 + 文件双实现,照 ChatStore 手法)。
 */

export type Role = 'user' | 'admin';
export type PackStatus = 'pending' | 'approved' | 'rejected';

export interface Account {
  user_id: string;
  /** 归一化邮箱(小写去空格)—— 唯一键 */
  email: string;
  nickname: string;
  /** scrypt 盐(hex)—— 与 hash 一起验口令;**永不出口** */
  salt: string;
  /** scrypt 派生(hex)—— **永不出口** */
  hash: string;
  role: Role;
  created_at: number;
  /** 管理员可禁用;被禁用的账号登录/会话一律失效 */
  disabled?: boolean;
  /**
   * 绑定的杯子(#74 好友互见的**唯一途径**)—— 可选,用户主动绑。
   * 绑了才能把该杯的**派生性格 + streak**露给好友;不绑 = 好友只看得到昵称。
   * 这是「账号↔杯子归属」的最小落地(#74 需要它算互见与组队 streak);
   * 完整的 R10-B 读侧用户归属仍是后续阶段,此处不碰设备读端点。
   */
  cup_id?: string;
}

export interface Session {
  token: string;
  user_id: string;
  created_at: number;
  expires_at: number;
}

/** 出口的用户视图 —— 绝不带 salt/hash */
export interface PublicUser {
  user_id: string;
  email: string;
  nickname: string;
  role: Role;
}

/**
 * 管理后台的用户视图 —— PublicUser + `disabled`(管理员要能看出谁被禁了)。
 * **仍然不含 salt/hash**:`disabled` 是管理信息,不是机密。
 */
export interface AdminUser extends PublicUser {
  disabled: boolean;
  created_at: number;
}

/**
 * 人格市场包(UGC)—— **只带数值 + 文本,不执行代码**。
 * 数值项在应用前由前端逐项**区间钳制**(见 web lib/pack-apply.ts),这里是权威形状。
 */
export interface PersonaPack {
  pack_id: string;
  author_user_id: string;
  name: string;
  /** 语气提示词片段(≤ 200 字) */
  tone: string;
  /** 表情阈值覆盖(mood.ts 的量级);未知键忽略、越界钳制 */
  thresholds: Record<string, number>;
  /** 水波性格覆盖(water.ts 的 k/c/damp);同上 */
  wave: Record<string, number>;
  /** 台词库(每句 ≤ 80 字,最多 20 句) */
  lines: string[];
  status: PackStatus;
  created_at: number;
}

/** 好友关系:无向 —— 存一份归一化的 (a<b) 对,避免重复 */
export interface Friendship {
  a_user_id: string;
  b_user_id: string;
  created_at: number;
}

/**
 * 设备一次性 claim code(风险 R18 的修法,见 `claim.ts` 头部长注)。
 *
 * **PK = device_id**:本项目双形体(杯盖 + 底座)共用 `cup_id`、`device_id` 不同;若 PK=cup_id
 * 两具身体每次上电互踩同一行、随机一具的码永久报废。绑定按 `cup_id` 查**任一**活跃行即可。
 *
 * 只存 `HMAC-SHA256(规范化码, 服务端 pepper)` —— **明文码绝不落盘**;`issued_at` 来自设备
 * (未认证通道,只做审计/展示),`expires_at` 一律**服务端时钟**算(防伪造未来 = 永生码)。
 */
export interface CupClaim {
  device_id: string;
  cup_id: string;
  claim_hash: string;
  issued_at: number;
  expires_at: number;
  /** 用过即打戳(一次性);`undefined` = 未用。重发同一码**不**重置 */
  used_at?: number;
}

/**
 * 账号 / 会话 / 市场 / 好友的统一存储口。**全方法返回 Promise** —— 第 1 阶段
 * 异步化(为第 2 阶段换 Postgres 实现铺路)。内存实现无真实 I/O,加 `async` 即可。
 */
export interface AccountsStore {
  // ── 账号 ──
  createAccount(a: Account): Promise<void>;
  accountByEmail(email: string): Promise<Account | null>;
  accountById(id: string): Promise<Account | null>;
  listAccounts(): Promise<Account[]>;
  setDisabled(id: string, v: boolean): Promise<void>;
  /** 绑定 / 解绑用户的杯子(#74 好友互见的口子);cupId 为 null = 解绑 */
  setCup(id: string, cupId: string | null): Promise<void>;
  /**
   * 删账号及其名下社交数据(删除第 4 阶段:账号级「注销」)。**硬删**,无墓碑。
   * 连带清掉该用户的订阅与好友边(它们引用 userId,留着就是悬垂数据)。
   * 杯子数据(遥测/记忆/画像)不在此 —— 那是**杯级** `DELETE /cups/:id/memory`,由路由逐杯调。
   */
  deleteAccount(id: string): Promise<void>;
  /** 删该用户全部会话令牌(注销时一并 — 否则旧令牌在过期前仍可 resolve)。 */
  dropSessionsForUser(userId: string): Promise<void>;

  // ── 会话 ──
  putSession(s: Session): Promise<void>;
  session(token: string): Promise<Session | null>;
  dropSession(token: string): Promise<void>;

  // ── 市场包 ──
  createPack(p: PersonaPack): Promise<void>;
  packById(id: string): Promise<PersonaPack | null>;
  listPacks(status?: PackStatus): Promise<PersonaPack[]>;
  setPackStatus(id: string, status: PackStatus): Promise<void>;

  // ── 订阅 ──
  subscribe(userId: string, packId: string): Promise<void>;
  subscriptions(userId: string): Promise<string[]>;

  // ── 好友 ──
  addFriend(a: string, b: string): Promise<void>;
  friends(userId: string): Promise<string[]>;

  // ── 可信绑定(claim code;见 claim.ts)──
  /** 记 / 覆盖一台设备的 claim(**PK=device_id**);首哈希为准由 ClaimService 把关 */
  putClaim(c: CupClaim): Promise<void>;
  claimByDevice(deviceId: string): Promise<CupClaim | null>;
  /** 该 cup 名下所有 claim(双形体 → 可能多行);绑定按此命中任一活跃行 */
  claimsByCup(cupId: string): Promise<CupClaim[]>;
  /** 标记一次性码已用(从未用 → 打戳);**不复活**已用行 */
  markClaimUsed(deviceId: string, usedAt: number): Promise<void>;

  flush(): Promise<void>;
}

/** 归一化邮箱:唯一键的比较口径,读/写**都**走它 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** 好友对归一化:字典序小者在前,保证 (a,b) 与 (b,a) 存成同一份 */
export function friendPair(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

/** 账号 → 出口视图(去掉 salt/hash/disabled) */
export function toPublicUser(a: Account): PublicUser {
  return { user_id: a.user_id, email: a.email, nickname: a.nickname, role: a.role };
}

/** 账号 → 管理视图(带 disabled/created_at,仍不含 salt/hash) */
export function toAdminUser(a: Account): AdminUser {
  return { ...toPublicUser(a), disabled: a.disabled === true, created_at: a.created_at };
}
