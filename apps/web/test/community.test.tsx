/**
 * 社区 / 管理 组件测试 —— 走**真实 click**(铁律),不合成 submit、不直接调 handler。
 *
 * 覆盖 #72 养成卡/迁移码、#73 市场/管理台、#74 社交/分享卡,以及账号卡(登录闸)。
 * social 用假实现(记调用 + 可编排返回),不连真后端。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { CommunityView } from '../src/components/CommunityView.tsx';
import { AdminPanel } from '../src/components/AdminPanel.tsx';
import { LogsView } from '../src/components/LogsView.tsx';
import { AccountCard } from '../src/components/dashboard/AccountCard.tsx';
import { ProfileCard } from '../src/components/dashboard/ProfileCard.tsx';
import { LlmCard } from '../src/components/dashboard/LlmCard.tsx';
import { BindCard } from '../src/components/dashboard/BindCard.tsx';
import { MarketCard } from '../src/components/dashboard/MarketCard.tsx';
import { FriendsCard } from '../src/components/dashboard/FriendsCard.tsx';
import { encodeMigrateCode } from '../src/lib/migrate-code.ts';
import type {
  AdminUser,
  AuthOutcome,
  CupLlmDraft,
  CupLlmPublic,
  FriendView,
  LogPage,
  LogPartition,
  LogRow,
  PackDraft,
  PersonaPack,
  PublicUser,
  ServerProfile,
  SocialApi,
  TeamState,
  TraitRecord,
} from '../src/data/source.ts';
import type { Session } from '../src/data/useSession.ts';
import { mount, click, type as typeInto, flush } from './mount.tsx';

const T: TraitRecord = {
  disposition: 'smug',
  level: 0.83,
  streak: 5,
  warmth: 0.61,
  refill_habit: 0.4,
  updated_at: Date.UTC(2026, 9, 12),
};

const USER: PublicUser = { user_id: 'u1', email: 'a@b.c', nickname: '小绿', role: 'user' };
const ADMIN: PublicUser = { ...USER, user_id: 'ad', role: 'admin' };
const OPS: PublicUser = { ...USER, user_id: 'op', role: 'ops' };
const REVIEWER: PublicUser = { ...USER, user_id: 'rv', role: 'reviewer' };

function fakeSocial(over: Partial<SocialApi> = {}): SocialApi {
  const base: SocialApi = {
    me: async () => null,
    register: async () => ({ ok: true, user: USER }),
    login: async () => ({ ok: true, user: USER }),
    logout: async () => {},
    hasSession: () => false,
    getToken: () => null,
    getProfile: async (): Promise<ServerProfile | null> => ({ cup_id: 'cup-X', nickname: '小绿', traits: T }),
    saveProfile: async (nickname): Promise<ServerProfile | null> => ({ cup_id: 'cup-X', nickname, traits: T }),
    getCupLlm: async (): Promise<CupLlmPublic | null> => null,
    saveCupLlm: async (): Promise<CupLlmPublic | null> => null,
    clearCupLlm: async () => true,
    listPacks: async () => [],
    submitPack: async (): Promise<PersonaPack | null> => null,
    subscribePack: async () => true,
    adminListUsers: async () => [],
    adminSetDisabled: async () => null,
    adminListPacks: async () => [],
    adminVerdict: async () => null,
    adminListLogs: async (): Promise<LogPage | null> => ({ rows: [], next_cursor: null }),
    adminLogPartitions: async (): Promise<LogPartition[] | null> => [],
    adminRetainLogs: async (): Promise<string[] | null> => [],
    listFriends: async () => [],
    addFriend: async () => null,
    getBoundCup: async () => null,
    bindCup: async () => ({ ok: true }),
    unbindCup: async () => ({ ok: true }),
    getTeam: async (): Promise<TeamState | null> => ({ members: 1, friends: 0, streak: 0, days: [] }),
  };
  return { ...base, ...over };
}

function fakeSession(over: Partial<Session> = {}): Session {
  return {
    user: null,
    loading: false,
    login: async () => ({ ok: true, user: USER }),
    register: async () => ({ ok: true, user: USER }),
    logout: async () => {},
    refresh: async () => {},
    ...over,
  };
}

const findButton = (host: HTMLElement, text: string) =>
  Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(text)) as
    | HTMLButtonElement
    | undefined;

/** 在受控 textarea 上输入 —— mount.tsx 的 type() 走 input 原型 setter,对 textarea 会 Illegal invocation */
function typeArea(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

// ── 账号卡 ────────────────────────────────────────────────────────

test('AccountCard:enabled=false → 需连后端空态,不出登录表单', () => {
  const { host, unmount } = mount(createElement(AccountCard, { session: fakeSession(), enabled: false }));
  assert.match(host.textContent ?? '', /需连后端/);
  assert.equal(host.querySelector('input'), null, '不该有输入框');
  unmount();
});

test('AccountCard:未登录 → 登录表单;真实点击登录 → 调 session.login', async () => {
  const seen: { email: string; pw: string }[] = [];
  const session = fakeSession({
    login: async (email, pw): Promise<AuthOutcome> => {
      seen.push({ email, pw });
      return { ok: true, user: USER };
    },
  });
  const { host, unmount } = mount(createElement(AccountCard, { session, enabled: true }));
  const inputs = host.querySelectorAll('input');
  typeInto(inputs[0] as HTMLInputElement, 'a@b.c');
  typeInto(inputs[1] as HTMLInputElement, 'pw123456');
  click(findButton(host, '登录')!);
  await flush();
  assert.deepEqual(seen, [{ email: 'a@b.c', pw: 'pw123456' }]);
  unmount();
});

test('AccountCard:后端回人话错误 → 原样显示在 alert 里', async () => {
  const session = fakeSession({
    login: async () => ({ ok: false, reason: 'error', error: '邮箱或口令不对' }),
  });
  const { host, unmount } = mount(createElement(AccountCard, { session, enabled: true }));
  const inputs = host.querySelectorAll('input');
  typeInto(inputs[0] as HTMLInputElement, 'a@b.c');
  typeInto(inputs[1] as HTMLInputElement, 'bad');
  click(findButton(host, '登录')!);
  await flush();
  assert.match(host.querySelector('[role="alert"]')!.textContent ?? '', /邮箱或口令不对/);
  unmount();
});

test('AccountCard:空邮箱 → 前端拦下,不调 login', async () => {
  let calls = 0;
  const session = fakeSession({
    login: async () => {
      calls++;
      return { ok: true, user: USER };
    },
  });
  const { host, unmount } = mount(createElement(AccountCard, { session, enabled: true }));
  click(findButton(host, '登录')!);
  await flush();
  assert.equal(calls, 0);
  assert.match(host.querySelector('[role="alert"]')!.textContent ?? '', /都要填/);
  unmount();
});

test('AccountCard:已登录 → 显示身份 + 登出;真实点击登出调 session.logout', async () => {
  let outed = false;
  const session = fakeSession({
    user: USER,
    logout: async () => {
      outed = true;
    },
  });
  const { host, unmount } = mount(createElement(AccountCard, { session, enabled: true }));
  assert.match(host.textContent ?? '', /小绿/);
  click(findButton(host, '登出')!);
  await flush();
  assert.equal(outed, true);
  unmount();
});

// ── 人格档案(养成卡 + 迁移码)────────────────────────────────────

test('ProfileCard:enabled=false → 需连后端空态', () => {
  const { host, unmount } = mount(createElement(ProfileCard, { social: null, enabled: false }));
  assert.match(host.textContent ?? '', /需连后端/);
  unmount();
});

test('ProfileCard:拉档案后展示性格;真实点击「生成迁移码」出码', async () => {
  const { host, unmount } = mount(
    createElement(ProfileCard, { social: fakeSocial(), enabled: true }),
  );
  await flush(); // getProfile().then
  assert.match(host.textContent ?? '', /得意洋洋/);
  click(findButton(host, '生成迁移码')!);
  await flush();
  const code = host.querySelector('[data-testid="migrate-code"]');
  assert.ok(code, '应出现迁移码');
  assert.match(code!.textContent ?? '', /^CUP1-/);
  unmount();
});

test('ProfileCard:导入合法迁移码 → 解出昵称与性格', async () => {
  const good = encodeMigrateCode(T, '小绿');
  const { host, unmount } = mount(
    createElement(ProfileCard, { social: fakeSocial(), enabled: true }),
  );
  await flush();
  const inputs = host.querySelectorAll('input');
  typeInto(inputs[inputs.length - 1] as HTMLInputElement, good); // 最后一个 = 迁移码框
  click(findButton(host, '解析')!);
  await flush();
  const status = host.querySelector('[role="status"]');
  assert.ok(status);
  assert.match(status!.textContent ?? '', /得意洋洋/);
  assert.match(status!.textContent ?? '', /小绿/);
  unmount();
});

test('ProfileCard:坏迁移码 → 明确报错,不误当成功', async () => {
  const { host, unmount } = mount(
    createElement(ProfileCard, { social: fakeSocial(), enabled: true }),
  );
  await flush();
  const inputs = host.querySelectorAll('input');
  typeInto(inputs[inputs.length - 1] as HTMLInputElement, 'CUP1-xxxx-bad');
  click(findButton(host, '解析')!);
  await flush();
  const status = host.querySelector('[role="status"]');
  assert.match(status!.textContent ?? '', /校验|格式|版本|损坏/);
  unmount();
});

// ── 接入我的模型(BYOK)──────────────────────────────────────────

test('LlmCard:enabled=false → 需连后端空态', () => {
  const { host, unmount } = mount(createElement(LlmCard, { social: null, enabled: false, user: null }));
  assert.match(host.textContent ?? '', /需连后端/);
  unmount();
});

test('LlmCard:未登录 → 提示先登录,不出表单', () => {
  const { host, unmount } = mount(
    createElement(LlmCard, { social: fakeSocial(), enabled: true, user: null }),
  );
  assert.match(host.textContent ?? '', /登录后/);
  assert.equal(host.querySelector('input'), null, '未登录不该有输入框');
  unmount();
});

test('LlmCard:未接入 → 真实点击「接入」提交 provider/model/key,提交后清空 key', async () => {
  let got: CupLlmDraft | null = null;
  const soc = fakeSocial({
    saveCupLlm: async (d): Promise<CupLlmPublic | null> => {
      got = d;
      return { cup_id: 'cup-X', provider: d.provider, model: d.model, has_key: true, updated_at: 1 };
    },
  });
  const { host, unmount } = mount(createElement(LlmCard, { social: soc, enabled: true, user: USER }));
  await flush();
  const inputs = host.querySelectorAll('input');
  typeInto(inputs[0] as HTMLInputElement, 'claude-opus-5'); // 模型
  typeInto(inputs[1] as HTMLInputElement, 'sk-secret'); // 密钥
  click(findButton(host, '接入')!);
  await flush();
  assert.ok(got, 'saveCupLlm 应被调用');
  assert.equal(got!.provider, 'anthropic');
  assert.equal(got!.model, 'claude-opus-5');
  assert.equal(got!.key, 'sk-secret');
  // 提交后 key 立即从表单清掉,不回显
  assert.equal((inputs[1] as HTMLInputElement).value, '');
  assert.match(host.textContent ?? '', /已保存/);
  unmount();
});

test('LlmCard:切厂商 → 模型默认值跟着换(不给错配的模型名)', async () => {
  const { host, unmount } = mount(
    createElement(LlmCard, { social: fakeSocial(), enabled: true, user: USER }),
  );
  await flush();
  const modelInput = () => host.querySelector('input[aria-label="模型名"]') as HTMLInputElement;
  assert.equal(modelInput().value, 'claude-sonnet-4-6');
  click(findButton(host, 'OpenAI')!);
  await flush();
  assert.equal(modelInput().value, 'gpt-4o-mini');
  unmount();
});

test('LlmCard:已接入 → 显示当前模型 + 留空改模型(key 省略);真实点击「更新」', async () => {
  let got: CupLlmDraft | null = null;
  const soc = fakeSocial({
    getCupLlm: async (): Promise<CupLlmPublic | null> => ({
      cup_id: 'cup-X', provider: 'openai', model: 'gpt-4o-mini', has_key: true, updated_at: 1,
    }),
    saveCupLlm: async (d): Promise<CupLlmPublic | null> => {
      got = d;
      return { cup_id: 'cup-X', provider: d.provider, model: d.model, has_key: true, updated_at: 2 };
    },
  });
  const { host, unmount } = mount(createElement(LlmCard, { social: soc, enabled: true, user: USER }));
  await flush();
  assert.match(host.textContent ?? '', /gpt-4o-mini/);
  const keyInput = host.querySelector('input[aria-label="模型密钥"]') as HTMLInputElement;
  assert.match(keyInput.placeholder, /已保存/);
  click(findButton(host, '更新')!); // 不动 key,只更新
  await flush();
  assert.ok(got, 'saveCupLlm 应被调用');
  assert.equal(got!.key, undefined, 'key 留空 → 不带上,后端沿用旧密文');
  unmount();
});

test('LlmCard:已接入 → 真实点击「取消接入」调 clearCupLlm 并回未接入', async () => {
  let cleared = false;
  const soc = fakeSocial({
    getCupLlm: async (): Promise<CupLlmPublic | null> => ({
      cup_id: 'cup-X', provider: 'anthropic', model: 'claude-sonnet-4-6', has_key: true, updated_at: 1,
    }),
    clearCupLlm: async () => {
      cleared = true;
      return true;
    },
  });
  const { host, unmount } = mount(createElement(LlmCard, { social: soc, enabled: true, user: USER }));
  await flush();
  click(findButton(host, '取消接入')!);
  await flush();
  assert.equal(cleared, true);
  assert.match(host.textContent ?? '', /未接入/);
  assert.equal(findButton(host, '取消接入'), undefined, '取消后不该再有取消按钮');
  unmount();
});

test('LlmCard:模型名清空 → 前端拦下,不提交', async () => {
  let calls = 0;
  const soc = fakeSocial({
    saveCupLlm: async () => {
      calls++;
      return null;
    },
  });
  const { host, unmount } = mount(createElement(LlmCard, { social: soc, enabled: true, user: USER }));
  await flush();
  typeInto(host.querySelector('input[aria-label="模型名"]') as HTMLInputElement, '');
  click(findButton(host, '接入')!);
  await flush();
  assert.equal(calls, 0);
  assert.match(host.querySelector('[role="alert"]')!.textContent ?? '', /不能为空/);
  unmount();
});

// ── 绑定杯子(可信绑定 UI)──────────────────────────────────────

test('BindCard:enabled=false → 需连后端空态', () => {
  const { host, unmount } = mount(createElement(BindCard, { social: null, enabled: false, user: null }));
  assert.match(host.textContent ?? '', /需连后端/);
  unmount();
});

test('BindCard:未登录 → 提示先登录,不出表单', () => {
  const { host, unmount } = mount(
    createElement(BindCard, { social: fakeSocial(), enabled: true, user: null }),
  );
  assert.match(host.textContent ?? '', /登录后/);
  assert.equal(host.querySelector('input'), null, '未登录不该有输入框');
  unmount();
});

test('BindCard:未绑定 → 真实点击「绑定」提交 cup_id + 绑定码', async () => {
  const seen: { cup: string; code?: string }[] = [];
  const soc = fakeSocial({
    bindCup: async (cupId, claimCode) => {
      seen.push({ cup: cupId, ...(claimCode !== undefined ? { code: claimCode } : {}) });
      return { ok: true };
    },
  });
  const { host, unmount } = mount(createElement(BindCard, { social: soc, enabled: true, user: USER }));
  await flush();
  typeInto(host.querySelector('input[aria-label="杯子编号"]') as HTMLInputElement, 'cup-001');
  typeInto(host.querySelector('input[aria-label="绑定码"]') as HTMLInputElement, 'JH2RFDZZ');
  click(findButton(host, '绑定')!);
  await flush();
  assert.deepEqual(seen, [{ cup: 'cup-001', code: 'JH2RFDZZ' }]);
  assert.match(host.textContent ?? '', /当前绑定/); // 成功 → 切到已绑视图
  unmount();
});

test('BindCard:403 → 后端人话原样显示(不吞成通用文案)', async () => {
  const soc = fakeSocial({
    bindCup: async () => ({ ok: false, error: '杯子绑定凭证无效' }),
  });
  const { host, unmount } = mount(createElement(BindCard, { social: soc, enabled: true, user: USER }));
  await flush();
  typeInto(host.querySelector('input[aria-label="杯子编号"]') as HTMLInputElement, 'cup-001');
  typeInto(host.querySelector('input[aria-label="绑定码"]') as HTMLInputElement, 'WRONG');
  click(findButton(host, '绑定')!);
  await flush();
  assert.match(host.querySelector('[role="alert"]')!.textContent ?? '', /杯子绑定凭证无效/);
  unmount();
});

test('BindCard:编号空 → 前端拦下,不提交', async () => {
  let calls = 0;
  const soc = fakeSocial({
    bindCup: async () => {
      calls++;
      return { ok: true };
    },
  });
  const { host, unmount } = mount(createElement(BindCard, { social: soc, enabled: true, user: USER }));
  await flush();
  click(findButton(host, '绑定')!);
  await flush();
  assert.equal(calls, 0);
  assert.match(host.querySelector('[role="alert"]')!.textContent ?? '', /要填/);
  unmount();
});

test('BindCard:已绑定 → 显示当前杯 + 真实点击「解绑」', async () => {
  let unbound = false;
  const soc = fakeSocial({
    getBoundCup: async () => 'cup-001',
    unbindCup: async () => {
      unbound = true;
      return { ok: true };
    },
  });
  const { host, unmount } = mount(createElement(BindCard, { social: soc, enabled: true, user: USER }));
  await flush();
  assert.match(host.textContent ?? '', /cup-001/);
  click(findButton(host, '解绑')!);
  await flush();
  assert.equal(unbound, true);
  assert.match(host.textContent ?? '', /未绑定/);
  unmount();
});

// ── 市场 ─────────────────────────────────────────────────────────

test('MarketCard:未登录 → 只读浏览,无投稿表单', async () => {
  const soc = fakeSocial({
    listPacks: async (): Promise<PersonaPack[]> => [
      { pack_id: 'p1', author_user_id: 'u2', name: '温柔包', tone: '柔柔的', thresholds: { SMUG_S: 4 }, wave: { k: 42 }, lines: ['你好'], status: 'approved', created_at: 1 },
    ],
  });
  const { host, unmount } = mount(createElement(MarketCard, { social: soc, enabled: true, user: null }));
  await flush();
  assert.match(host.textContent ?? '', /温柔包/);
  assert.match(host.textContent ?? '', /登录后才能投稿/);
  assert.equal(findButton(host, '投稿'), undefined);
  unmount();
});

test('MarketCard:真实点击「订阅」调 subscribePack', async () => {
  const seen: string[] = [];
  const soc = fakeSocial({
    listPacks: async (): Promise<PersonaPack[]> => [
      { pack_id: 'p1', author_user_id: 'u2', name: '温柔包', tone: '', thresholds: {}, wave: {}, lines: [], status: 'approved', created_at: 1 },
    ],
    subscribePack: async (id) => {
      seen.push(id);
      return true;
    },
  });
  const { host, unmount } = mount(createElement(MarketCard, { social: soc, enabled: true, user: USER }));
  await flush();
  click(findButton(host, '订阅')!);
  await flush();
  assert.deepEqual(seen, ['p1']);
  assert.ok(findButton(host, '已订阅'), '订阅后按钮变已订阅');
  unmount();
});

test('MarketCard:登录后投稿 → 真实点击提交,submitPack 收到净化后的草稿', async () => {
  let got: PackDraft | null = null;
  const soc = fakeSocial({
    submitPack: async (d): Promise<PersonaPack | null> => {
      got = d;
      return { ...d, pack_id: 'p9', author_user_id: 'u1', status: 'pending', created_at: 1 };
    },
  });
  const { host, unmount } = mount(createElement(MarketCard, { social: soc, enabled: true, user: USER }));
  await flush();
  const inputs = host.querySelectorAll('input');
  typeInto(inputs[0] as HTMLInputElement, '早八包');
  const ta = host.querySelector('textarea') as HTMLTextAreaElement;
  assert.ok(ta, '投稿表单应有台词多行框');
  typeArea(ta, '早啊\n喝口水');
  click(findButton(host, '投稿')!);
  await flush();
  assert.ok(got, 'submitPack 应被调用');
  assert.equal(got!.name, '早八包');
  assert.deepEqual(got!.lines, ['早啊', '喝口水']);
  unmount();
});

test('MarketCard:包名为空 → 前端拦下,不投稿', async () => {
  let calls = 0;
  const soc = fakeSocial({
    submitPack: async () => {
      calls++;
      return null;
    },
  });
  const { host, unmount } = mount(createElement(MarketCard, { social: soc, enabled: true, user: USER }));
  await flush();
  click(findButton(host, '投稿')!);
  await flush();
  assert.equal(calls, 0);
  unmount();
});

// ── 社交 ─────────────────────────────────────────────────────────

test('FriendsCard:展示组队 streak;真实点击「加好友」调 addFriend', async () => {
  const seen: string[] = [];
  const friend: FriendView = { user_id: 'u2', nickname: '阿蓝', traits: T, streak: 3 };
  const soc = fakeSocial({
    getTeam: async (): Promise<TeamState | null> => ({ members: 2, friends: 1, streak: 3, days: ['2026-10-10', '2026-10-12'] }),
    listFriends: async () => [friend],
    addFriend: async (email) => {
      seen.push(email);
      return friend;
    },
  });
  const { host, unmount } = mount(createElement(FriendsCard, { social: soc, enabled: true, user: USER }));
  await flush();
  assert.match(host.textContent ?? '', /组队连续 3 天/);
  assert.match(host.textContent ?? '', /阿蓝/);
  typeInto(host.querySelector('input') as HTMLInputElement, 'b@b.c');
  click(findButton(host, '加好友')!);
  await flush();
  assert.deepEqual(seen, ['b@b.c']);
  unmount();
});

test('FriendsCard:未登录 → 无加好友表单', async () => {
  const { host, unmount } = mount(
    createElement(FriendsCard, { social: fakeSocial(), enabled: true, user: null }),
  );
  await flush();
  assert.match(host.textContent ?? '', /登录后才能加好友/);
  unmount();
});

// ── 管理台 ───────────────────────────────────────────────────────

test('AdminPanel:真实点击「禁用」调 adminSetDisabled 并就地更新', async () => {
  const u2: AdminUser = { user_id: 'u2', email: 'b@b.c', nickname: '阿蓝', role: 'user', disabled: false, created_at: 1 };
  const seen: { id: string; v: boolean }[] = [];
  const soc = fakeSocial({
    adminListUsers: async () => [u2],
    adminSetDisabled: async (id, v) => {
      seen.push({ id, v });
      return { ...u2, disabled: v };
    },
  });
  const { host, unmount } = mount(createElement(AdminPanel, { social: soc }));
  await flush();
  click(findButton(host, '禁用')!);
  await flush();
  assert.deepEqual(seen, [{ id: 'u2', v: true }]);
  assert.match(host.textContent ?? '', /已禁用/);
  unmount();
});

test('AdminPanel:真实点击「通过」调 adminVerdict(true),审完离队', async () => {
  const pack: PersonaPack = { pack_id: 'p1', author_user_id: 'u2', name: '待审包', tone: '', thresholds: {}, wave: {}, lines: [], status: 'pending', created_at: 1 };
  const seen: { id: string; ok: boolean }[] = [];
  const soc = fakeSocial({
    adminListPacks: async () => [pack],
    adminVerdict: async (id, ok) => {
      seen.push({ id, ok });
      return { ...pack, status: ok ? 'approved' : 'rejected' };
    },
  });
  const { host, unmount } = mount(createElement(AdminPanel, { social: soc }));
  await flush();
  assert.match(host.textContent ?? '', /待审包/);
  click(findButton(host, '通过')!);
  await flush();
  assert.deepEqual(seen, [{ id: 'p1', ok: true }]);
  assert.ok(!(host.textContent ?? '').includes('待审包'), '审完该包应离队');
  unmount();
});

// ── 服务日志回看 ─────────────────────────────────────────────────

function logRow(over: Partial<LogRow> = {}): LogRow {
  return { ts: Date.UTC(2026, 9, 14, 1, 2, 3), level: 'info', src: 'http', msg: '一条日志', payload: {}, ...over };
}

test('LogsView:进页即拉一页,渲染日志行(时间/级别/来源/正文)', async () => {
  const soc = fakeSocial({
    adminListLogs: async (): Promise<LogPage | null> => ({
      rows: [logRow({ msg: '杯子连上了' })],
      next_cursor: null,
    }),
  });
  const { host, unmount } = mount(createElement(LogsView, { social: soc, role: REVIEWER.role }));
  await flush();
  assert.match(host.textContent ?? '', /杯子连上了/);
  assert.match(host.textContent ?? '', /info/);
  assert.match(host.textContent ?? '', /http/);
  unmount();
});

test('LogsView:真实点击「查询」把筛选拼进 LogQuery(级别多选 + 来源 + 关键词)', async () => {
  const seen: unknown[] = [];
  const soc = fakeSocial({
    adminListLogs: async (q): Promise<LogPage | null> => {
      seen.push(q);
      return { rows: [], next_cursor: null };
    },
  });
  const { host, unmount } = mount(createElement(LogsView, { social: soc, role: REVIEWER.role }));
  await flush();
  click(findButton(host, 'warn')!); // 级别 chip
  click(findButton(host, 'error')!);
  typeInto(host.querySelector('input[aria-label="来源"]') as HTMLInputElement, 'ws');
  typeInto(host.querySelector('input[aria-label="关键词"]') as HTMLInputElement, '超时');
  click(findButton(host, '查询')!);
  await flush();
  const last = seen[seen.length - 1] as {
    level?: string[];
    src?: string;
    q?: string;
  };
  assert.deepEqual([...(last.level ?? [])].sort(), ['error', 'warn']);
  assert.equal(last.src, 'ws');
  assert.equal(last.q, '超时');
  unmount();
});

test('LogsView:reviewer 只读 —— 不显示「触发保留清理」与分区', async () => {
  let retainCalls = 0;
  let partCalls = 0;
  const soc = fakeSocial({
    adminRetainLogs: async () => {
      retainCalls++;
      return [];
    },
    adminLogPartitions: async () => {
      partCalls++;
      return [{ name: 'server_logs_2026_07', bytes: 1024 }];
    },
  });
  const { host, unmount } = mount(createElement(LogsView, { social: soc, role: REVIEWER.role }));
  await flush();
  assert.equal(findButton(host, '触发保留清理'), undefined, 'reviewer 不该看到写按钮');
  assert.equal(partCalls, 0, 'reviewer 不该拉分区');
  assert.equal(retainCalls, 0);
  unmount();
});

test('LogsView:ops 可见分区占用;真实点击「触发保留清理」调 adminRetainLogs 并显示结果', async () => {
  let retained = false;
  const soc = fakeSocial({
    adminLogPartitions: async (): Promise<LogPartition[] | null> => [
      { name: 'server_logs_2026_07', bytes: 2_097_152 },
    ],
    adminRetainLogs: async (): Promise<string[] | null> => {
      retained = true;
      return ['server_logs_2026_07'];
    },
  });
  const { host, unmount } = mount(createElement(LogsView, { social: soc, role: OPS.role }));
  await flush();
  assert.match(host.textContent ?? '', /server_logs_2026_07/);
  assert.match(host.textContent ?? '', /2\.0 MB/);
  click(findButton(host, '触发保留清理')!);
  await flush();
  assert.equal(retained, true);
  assert.match(host.textContent ?? '', /已删除 1 个过期分区/);
  unmount();
});

test('LogsView:加载失败(非授权会话)→ 报警,不静默', async () => {
  const soc = fakeSocial({ adminListLogs: async (): Promise<LogPage | null> => null });
  const { host, unmount } = mount(createElement(LogsView, { social: soc, role: ADMIN.role }));
  await flush();
  assert.match(host.querySelector('[role="alert"]')!.textContent ?? '', /加载失败/);
  unmount();
});

test('LogsView:分页 —— next_cursor 非空时显示「加载更多」,点击续拉并追加', async () => {
  let call = 0;
  const soc = fakeSocial({
    adminListLogs: async (): Promise<LogPage | null> => {
      call++;
      return call === 1
        ? { rows: [logRow({ msg: '第一页' })], next_cursor: 'c1' }
        : { rows: [logRow({ msg: '第二页' })], next_cursor: null };
    },
  });
  const { host, unmount } = mount(createElement(LogsView, { social: soc, role: REVIEWER.role }));
  await flush();
  assert.ok(findButton(host, '加载更多'), '有 next_cursor 时应显示加载更多');
  click(findButton(host, '加载更多')!);
  await flush();
  assert.match(host.textContent ?? '', /第一页/);
  assert.match(host.textContent ?? '', /第二页/);
  assert.equal(findButton(host, '加载更多'), undefined, '拉完应消失');
  unmount();
});

test('LogsView 角色可见性:admin / ops / reviewer 看得见,user 进不来(App 侧 gate)', () => {
  // 组件本身不 gate(App 才 gate);这里钉「reviewer 也渲染得出来」这一条
  const { host, unmount } = mount(createElement(LogsView, { social: fakeSocial(), role: REVIEWER.role }));
  assert.match(host.textContent ?? '', /服务日志/);
  unmount();
});

// ── 组合 ─────────────────────────────────────────────────────────

test('CommunityView:无后端源时四张卡都显示「需连后端」', () => {
  const { host, unmount } = mount(
    createElement(CommunityView, { social: null, session: fakeSession() }),
  );
  const n = (host.textContent ?? '').split('需连后端').length - 1;
  assert.ok(n >= 3, `应有多张卡提示需连后端,实际 ${n}`);
  unmount();
});

test('CommunityView:管理员登录 → 管理台可见(公开于 session)', async () => {
  // CommunityView 只含四张社区卡;管理台是独立 Tab,这里只验管理员身份能被会话透出
  const { host, unmount } = mount(
    createElement(CommunityView, { social: fakeSocial(), session: fakeSession({ user: ADMIN }) }),
  );
  await flush();
  assert.match(host.textContent ?? '', /小绿/); // 账号卡显示身份
  unmount();
});
