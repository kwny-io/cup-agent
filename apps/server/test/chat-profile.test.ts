/**
 * §5.2 三个代码洞的回归测试 —— 由 SpyChatLlm 观测真实发给模型的 system 提示。
 *
 * 钉死三件事(每件都先测"改之前会红"的那一面):
 *   #2 PROACTIVE_PROMPT 不再死:主动开口时提示词带上"你自己开口"这层身份
 *   #1 profile() 被真读:设了画像 → 画像文本进系统提示
 *   #3 数字守卫不再误伤画像数字:画像里的数字可被复述(否则整段回退模板)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runChat,
  MemoryStore,
  MemoryChatStore,
  CommandQueue,
  CHAT_SYSTEM,
  PROACTIVE_PROMPT,
  type ChatDeps,
  type ChatLlm,
  type ChatLlmRequest,
  type ChatModelTurn,
} from '@cup/server';

const CUP = 'cup-A1B2C3';
const NOW = new Date(2026, 9, 8, 15, 0, 0).getTime();

/** 记录每次被调用时收到的 system 提示,便于断言"到底发了什么给模型" */
class SpyChatLlm implements ChatLlm {
  readonly name = 'spy';
  readonly systems: string[] = [];
  private readonly script: ChatModelTurn[];
  private i = 0;

  constructor(script: ChatModelTurn[]) {
    this.script = script;
  }

  async turn(req: ChatLlmRequest): Promise<ChatModelTurn> {
    this.systems.push(req.system);
    const t = this.script[this.i++];
    if (!t) throw new Error('script exhausted');
    return t;
  }

  last(): string {
    return this.systems[this.systems.length - 1] ?? '';
  }
}

function say(text: string): ChatModelTurn {
  return { text, toolCalls: [], stopReason: 'end_turn' };
}

function makeDeps(script: ChatModelTurn[], profile?: string) {
  const memory = new MemoryChatStore();
  if (profile !== undefined) memory.setProfile(CUP, profile);
  const chat = new SpyChatLlm(script);
  const deps: ChatDeps = {
    store: new MemoryStore(),
    commands: new CommandQueue(),
    chat,
    memory,
    log: () => {},
    now: () => NOW,
  };
  return { deps, chat };
}

// ── #2 主动提示词(不再死代码) ──────────────────────────────────

test('#2 主动开口:系统提示带上"你自己开口"身份,且不丢掉傲娇铁律', async () => {
  const { deps, chat } = makeDeps([say('喂,该喝水了,别装没看见。')]);
  await runChat(deps, { cupId: CUP, question: '（自己开口提醒主人喝水）', proactive: true });

  const sys = chat.last();
  assert.ok(sys.includes(PROACTIVE_PROMPT), '主动身份提示应进入系统提示');
  assert.ok(sys.includes(CHAT_SYSTEM), '傲娇铁律必须仍在(不替换,只追加)');
});

test('#2 普通问答:不注入主动身份', async () => {
  const { deps, chat } = makeDeps([say('才喝这么点呀。')]);
  await runChat(deps, { cupId: CUP, question: '我喝得怎么样' });

  assert.ok(!chat.last().includes(PROACTIVE_PROMPT), '非主动时不该带主动身份');
  assert.ok(chat.last().includes(CHAT_SYSTEM));
});

// ── #1 画像被真读 ───────────────────────────────────────────────

test('#1 profile():设了长期画像 → 画像文本进入系统提示', async () => {
  const { deps, chat } = makeDeps([say('我知道你哦。')], '主人习惯小口慢饮,每次约 250ml。');
  await runChat(deps, { cupId: CUP, question: '你记得我吗' });

  assert.ok(chat.last().includes('小口慢饮'), '画像文本应进入系统提示');
});

test('#1 profile():没设画像 → 不注入空画像段', async () => {
  const { deps, chat } = makeDeps([say('第一次见你。')]);
  await runChat(deps, { cupId: CUP, question: '你记得我吗' });
  assert.ok(!chat.last().includes('你长期记得'));
});

// ── #3 守卫不误伤画像数字(此洞的对照组是"修之前会红") ────────────

test('#3 守卫:无画像时复述画像数字 → 判凭空、回退(证明修复是承重的)', async () => {
  // 对照组:同样的回答,但画像没设 → 250 无来源 → fallback
  const { deps } = makeDeps([say('你就爱小口喝,又是 250ml 吧。')]);
  const a = await runChat(deps, { cupId: CUP, question: '你记得我怎么喝水吗' });
  assert.equal(a.source, 'fallback');
});

test('#3 守卫:有画像时复述画像里的数字 → 通过守卫(source=llm)', async () => {
  const { deps } = makeDeps(
    [say('你就爱小口喝,又是 250ml 吧。')],
    '主人习惯小口慢饮,每次约 250ml。',
  );
  const a = await runChat(deps, { cupId: CUP, question: '你记得我怎么喝水吗' });
  assert.equal(a.source, 'llm', '画像里的数字应被 allow,不该回退');
  assert.match(a.text, /250/);
});

test('#3 守卫:画像之外的数字仍被判凭空(守卫没被放宽到失效)', async () => {
  const { deps } = makeDeps(
    [say('你昨天喝了 9999ml 吧。')],
    '主人习惯小口慢饮,每次约 250ml。',
  );
  const a = await runChat(deps, { cupId: CUP, question: '你记得我怎么喝水吗' });
  assert.equal(a.source, 'fallback', '画像里没有 9999 → 仍应拦下');
});
