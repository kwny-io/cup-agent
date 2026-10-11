/**
 * 账号服务 —— 注册 / 登录 / 登出 / 取当前用户 + 会话解析。
 *
 * 把"口令校验、重名、禁用、令牌过期"这些**规则**放在这里(纯逻辑,可直测),
 * http.ts 只做 HTTP 形状。这样路由薄、规则厚,规则不用起服务器就能测。
 */
import {
  SESSION_TTL_MS,
  hashPassword,
  newSessionToken,
  newUserId,
  verifyPassword,
} from './crypto.ts';
import { normalizeEmail, toPublicUser, type Account, type AccountsStore, type PublicUser } from './types.ts';

export interface RegisterInput {
  email: string;
  password: string;
  nickname?: string;
}

export type AuthResult =
  | { ok: true; token: string; user: PublicUser }
  | { ok: false; status: number; error: string };

/** 口令最短位数(太短的直接拒,别等用户被爆破) */
export const MIN_PASSWORD_LEN = 6;
const MAX_PASSWORD_LEN = 200;
const MAX_NICKNAME_LEN = 24;
const MAX_EMAIL_LEN = 120;

/** 极简邮箱形状校验:必须有个 @ 与一个点,不做 RFC 全套(过度校验反误伤) */
function looksLikeEmail(email: string): boolean {
  if (email.length === 0 || email.length > MAX_EMAIL_LEN) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export interface AuthDeps {
  store: AccountsStore;
  /** 首个管理员引导:注册邮箱等于它 → role='admin'(不新增注册口子) */
  adminEmail?: string;
  now?: () => number;
}

/**
 * 注册。校验邮箱形状 / 口令长度 / 重名 → 建账号 + 发会话。
 * 返回 token 与出口视图(salt/hash 不出)。
 */
export async function register(deps: AuthDeps, input: RegisterInput): Promise<AuthResult> {
  const email = normalizeEmail(input.email ?? '');
  const password = input.password ?? '';
  const nickname = (input.nickname ?? '').trim();

  if (!looksLikeEmail(email)) return { ok: false, status: 400, error: '邮箱格式不对' };
  if (password.length < MIN_PASSWORD_LEN) {
    return { ok: false, status: 400, error: `口令至少 ${MIN_PASSWORD_LEN} 位` };
  }
  if (password.length > MAX_PASSWORD_LEN) return { ok: false, status: 400, error: '口令过长' };
  if (nickname.length > MAX_NICKNAME_LEN) return { ok: false, status: 400, error: '昵称过长' };
  if (await deps.store.accountByEmail(email)) {
    return { ok: false, status: 409, error: '该邮箱已注册' };
  }

  const now = deps.now?.() ?? Date.now();
  const { salt, hash } = hashPassword(password);
  const adminEmail = deps.adminEmail ? normalizeEmail(deps.adminEmail) : '';
  const account: Account = {
    user_id: newUserId(),
    email,
    nickname: nickname || email.split('@')[0] || '杯子主人',
    salt,
    hash,
    role: adminEmail && email === adminEmail ? 'admin' : 'user',
    created_at: now,
  };
  await deps.store.createAccount(account);
  const token = await issueSession(deps, account.user_id, now);
  return { ok: true, token, user: toPublicUser(account) };
}

/** 登录。邮箱不存在 / 口令错 / 账号被禁用 → 401(不区分,免得探测哪个邮箱存在)。 */
export async function login(
  deps: AuthDeps,
  input: { email: string; password: string },
): Promise<AuthResult> {
  const account = await deps.store.accountByEmail(normalizeEmail(input.email ?? ''));
  // 账号不存在时也跑一次哈希,尽量抹平"存在/不存在"的时间差
  const stored = account
    ? { salt: account.salt, hash: account.hash }
    : { salt: '00', hash: '00' };
  const okPw = verifyPassword(input.password ?? '', stored);
  if (!account || !okPw) return { ok: false, status: 401, error: '邮箱或口令不对' };
  if (account.disabled) return { ok: false, status: 401, error: '账号已被禁用' };

  const now = deps.now?.() ?? Date.now();
  const token = await issueSession(deps, account.user_id, now);
  return { ok: true, token, user: toPublicUser(account) };
}

/** 登出:删会话(不存在也算成功,幂等) */
export async function logout(deps: AuthDeps, token: string | null): Promise<void> {
  if (token) await deps.store.dropSession(token);
}

/**
 * 由 `Authorization: Bearer <token>` 解析当前用户。
 * 令牌缺失 / 未知 / 过期 / 账号被禁用 → null。
 * 过期会话顺手清掉(免得文件里堆死会话)。
 */
export async function resolveSession(
  deps: AuthDeps,
  token: string | null,
): Promise<PublicUser | null> {
  if (!token) return null;
  const s = await deps.store.session(token);
  if (!s) return null;
  const now = deps.now?.() ?? Date.now();
  if (s.expires_at <= now) {
    await deps.store.dropSession(token);
    return null;
  }
  const account = await deps.store.accountById(s.user_id);
  if (!account || account.disabled) return null;
  return toPublicUser(account);
}

/** 从 Authorization 头取 Bearer 令牌;格式不对 → null */
export function bearerToken(header: string | string[] | undefined): string | null {
  const h = Array.isArray(header) ? header[0] : header;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

async function issueSession(deps: AuthDeps, userId: string, now: number): Promise<string> {
  const token = newSessionToken();
  await deps.store.putSession({
    token,
    user_id: userId,
    created_at: now,
    expires_at: now + SESSION_TTL_MS,
  });
  return token;
}
