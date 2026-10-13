/**
 * BYOK(每杯自带模型)—— 内核 + `/cups/:id/llm` 路由 + `/ask` 走该杯模型。
 *
 * 钉的是**安全口径与归属口径**,不是"面板好不好看":
 *   · key 用 **AES-256-GCM 可逆加密**(要能解出来调 LLM);出口视图**绝不含** key
 *   · `/llm` 走**账号会话**(无令牌 401)+ **归属**(别人的杯 403)—— 不是设备 x-api-key
 *   · `set` 省 key → **沿用旧密文**(只改模型不逼重填 key)
 *   · `/ask`:**配了该杯模型**(resolveChatLlm 非 null)→ 走账户鉴权(无令牌 401 / 别人杯 403)
 *     且真走它(端到端打到本地桩端点);没配 → 回退全局 chatLlm(零回归)
 *
 * 起真 HTTP(createApp),`/ask` 的真链路用本地桩端点充当"用户的模型"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import {
  createApp,
  CupLlmService,
  MemoryCupLlmStore,
  encryptSecret,
  decryptSecret,
  toCupLlmPublic,
  toOpenAiMessages,
  isCupLlmProvider,
  type CupLlmConfig,
  type PublicUser,
} from '@cup/server';

const CUP = 'cup-A1B2C3';
const CUP_OTHER = 'cup-B1B2C3';

// ── 内核:加解密 ─────────────────────────────────────────────────

test('encryptSecret/decryptSecret:往返一致;换密钥/篡改 → null', () => {
  const key = randomBytes(32);
  const blob = encryptSecret('sk-user-secret-123', key);
  assert.match(blob, /^[0-9a-f]+\.[0-9a-f]+\.[0-9a-f]+$/, 'iv.tag.cipher 三段 hex');
  assert.equal(decryptSecret(blob, key), 'sk-user-secret-123');

  // 换密钥 → 解不开(认证失败,不抛)
  assert.equal(decryptSecret(blob, randomBytes(32)), null, '换密钥 → null');
  // 篡改密文段 → 认证失败
  const parts = blob.split('.');
  parts[2] = parts[2]!.slice(0, -2) + (parts[2]!.endsWith('00') ? '11' : '00');
  assert.equal(decryptSecret(parts.join('.'), key), null, '篡改 → null');
  // 形状不对 → null
  assert.equal(decryptSecret('garbage', key), null);
});

test('相同明文两次加密 → 密文不同(随机 IV)', () => {
  const key = randomBytes(32);
  assert.notEqual(encryptSecret('same', key), encryptSecret('same', key));
});

// ── 内核:出口视图绝不泄 key ─────────────────────────────────────

test('toCupLlmPublic:不含 key_enc,只给 has_key 布尔', () => {
  const cfg: CupLlmConfig = {
    cup_id: CUP, provider: 'anthropic', model: 'claude-sonnet-4-6',
    key_enc: 'iv.tag.cipher', updated_at: 7,
  };
  const pub = toCupLlmPublic(cfg);
  assert.equal(pub.has_key, true);
  assert.equal('key_enc' in pub, false, '出口视图不得带 key_enc');
  assert.equal(JSON.stringify(pub).includes('cipher'), false, '序列化后也不得出现密文');

  const noKey = toCupLlmPublic({ ...cfg, key_enc: '' });
  assert.equal(noKey.has_key, false, '空密文 → has_key=false');
  // base_url 缺席 → 出口视图也不带该键
  assert.equal('base_url' in pub, false);
});

test('isCupLlmProvider:只认 anthropic / openai', () => {
  assert.equal(isCupLlmProvider('anthropic'), true);
  assert.equal(isCupLlmProvider('openai'), true);
  assert.equal(isCupLlmProvider('google'), false);
  assert.equal(isCupLlmProvider(123), false);
  assert.equal(isCupLlmProvider(undefined), false);
});

// ── 内核:toOpenAiMessages 映射 ──────────────────────────────────

test('toOpenAiMessages:user/assistant(tool_calls)/tool(tool_call_id) 三形状', () => {
  const msgs = toOpenAiMessages([
    { role: 'user', text: '我喝多少了' },
    { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'get_today', input: { x: 1 } }] },
    { role: 'tool', callId: 'c1', name: 'get_today', output: { drank_ml: 720 }, ok: true },
    { role: 'assistant', text: '才 720ml', toolCalls: [] },
  ]) as Record<string, unknown>[];
  assert.deepEqual(msgs[0], { role: 'user', content: '我喝多少了' });
  assert.equal(msgs[1]!.role, 'assistant');
  assert.deepEqual((msgs[1] as { tool_calls: unknown[] }).tool_calls, [
    { id: 'c1', type: 'function', function: { name: 'get_today', arguments: '{"x":1}' } },
  ]);
  assert.deepEqual(msgs[2], { role: 'tool', tool_call_id: 'c1', content: '{"drank_ml":720}' });
  // 无工具轮 → 不带 tool_calls 键
  assert.equal('tool_calls' in (msgs[3] as object), false);
});

// ── 内核:CupLlmService ──────────────────────────────────────────

test('CupLlmService:set 落密文、get 出口无 key、clear 清掉', async () => {
  const key = randomBytes(32);
  const store = new MemoryCupLlmStore();
  const svc = new CupLlmService({ store, key });

  assert.equal(await svc.get(CUP), null, '未配 → null');

  const pub = await svc.set(CUP, { provider: 'openai', model: 'gpt-4o-mini', key: 'sk-abc' });
  assert.equal(pub.has_key, true);
  assert.equal(pub.provider, 'openai');
  // 存储形里是密文,不是明文
  const raw = await store.get(CUP);
  assert.ok(raw && raw.key_enc.length > 0 && !raw.key_enc.includes('sk-abc'), '落库的是密文');
  assert.equal(decryptSecret(raw!.key_enc, key), 'sk-abc', '能解回明文');

  await svc.clear(CUP);
  assert.equal(await svc.get(CUP), null, 'clear 后 → null');
});

test('CupLlmService:set 省 key → 沿用旧密文(只改模型)', async () => {
  const key = randomBytes(32);
  const svc = new CupLlmService({ store: new MemoryCupLlmStore(), key });

  await svc.set(CUP, { provider: 'anthropic', model: 'claude-sonnet-4-6', key: 'sk-keep' });
  const before = (await svc.chatLlm(CUP)) !== null;
  assert.equal(before, true);

  const pub = await svc.set(CUP, { provider: 'anthropic', model: 'claude-opus-4-1' }); // 不带 key
  assert.equal(pub.model, 'claude-opus-4-1');
  assert.equal(pub.has_key, true, '省 key 应沿用旧密文');
});

test('CupLlmService:没配 / key 解不开 → chatLlm() 返回 null(调用方回退)', async () => {
  const svc = new CupLlmService({ store: new MemoryCupLlmStore(), key: randomBytes(32) });
  assert.equal(await svc.chatLlm(CUP), null, '未配 → null');

  // 造一个解不开的密文行
  const store = new MemoryCupLlmStore();
  await store.set(CUP, {
    cup_id: CUP, provider: 'openai', model: 'gpt-4o-mini',
    key_enc: encryptSecret('x', randomBytes(32)), updated_at: 1, // 用别的密钥加密
  });
  const svc2 = new CupLlmService({ store, key: randomBytes(32) });
  assert.equal(await svc2.chatLlm(CUP), null, '换密钥 → 解不开 → null');
});

// ── HTTP:每杯配置端点 ────────────────────────────────────────────

async function startApp(opts: Parameters<typeof createApp>[0] = {}) {
  const app = createApp({ log: () => {}, allowUnauth: true, ...opts });
  const port = await app.listen(0);
  return { app, base: `http://127.0.0.1:${port}` };
}

function req(base: string, path: string, method: string, body?: unknown, token?: string) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function registerAndBind(base: string, cup = CUP): Promise<string> {
  const r = await req(base, '/auth/register', 'POST', {
    email: `u${Math.random().toString(36).slice(2)}@x.com`, password: 'pw123456',
  });
  assert.equal(r.status, 200, '注册应成功');
  const { token } = (await r.json()) as { token: string; user: PublicUser };
  const b = await req(base, '/social/cup', 'POST', { cup_id: cup }, token);
  assert.equal(b.status, 200, '绑杯应成功');
  return token;
}

test('/llm:无令牌 → 401(走会话闸,不走 x-api-key)', async () => {
  const { app, base } = await startApp();
  try {
    assert.equal((await req(base, `/cups/${CUP}/llm`, 'GET')).status, 401);
    assert.equal((await req(base, `/cups/${CUP}/llm`, 'PUT', { provider: 'openai', model: 'm' })).status, 401);
    assert.equal((await req(base, `/cups/${CUP}/llm`, 'DELETE')).status, 401);
  } finally {
    await app.close();
  }
});

test('/llm:登录但非主人 → 403(别人的杯不能碰)', async () => {
  const { app, base } = await startApp();
  try {
    const token = await registerAndBind(base, CUP); // 绑的是 CUP
    const r = await req(base, `/cups/${CUP_OTHER}/llm`, 'PUT', { provider: 'openai', model: 'm' }, token);
    assert.equal(r.status, 403, '未绑的杯 → 403');
    assert.equal((await req(base, `/cups/${CUP_OTHER}/llm`, 'GET', undefined, token)).status, 403);
  } finally {
    await app.close();
  }
});

test('/llm:主人 GET 未配 → config:null;PUT 写入 → GET 读回(无 key);DELETE 清掉', async () => {
  const { app, base } = await startApp();
  try {
    const token = await registerAndBind(base);
    const g0 = await req(base, `/cups/${CUP}/llm`, 'GET', undefined, token);
    assert.equal(g0.status, 200);
    assert.equal(((await g0.json()) as { config: unknown }).config, null, '未配 → null');

    const put = await req(base, `/cups/${CUP}/llm`, 'PUT', {
      provider: 'openai', model: 'gpt-4o-mini', key: 'sk-user-xyz',
      base_url: 'https://api.openai.com/v1/chat/completions',
    }, token);
    assert.equal(put.status, 200);
    const cfg = ((await put.json()) as { config: Record<string, unknown> }).config;
    assert.equal(cfg.provider, 'openai');
    assert.equal(cfg.model, 'gpt-4o-mini');
    assert.equal(cfg.has_key, true);
    assert.equal('key' in cfg || 'key_enc' in cfg, false, '回包不得含 key');

    const g1 = ((await (await req(base, `/cups/${CUP}/llm`, 'GET', undefined, token)).json()) as {
      config: Record<string, unknown>;
    }).config;
    assert.equal(g1.model, 'gpt-4o-mini');
    assert.equal(g1.has_key, true);

    const del = await req(base, `/cups/${CUP}/llm`, 'DELETE', undefined, token);
    assert.equal(del.status, 200);
    const g2 = ((await (await req(base, `/cups/${CUP}/llm`, 'GET', undefined, token)).json()) as {
      config: unknown;
    }).config;
    assert.equal(g2, null, 'DELETE 后 → null');
  } finally {
    await app.close();
  }
});

test('/llm:校验 —— provider 非法 400、model 空 400、非 PUT/GET/DELETE 405', async () => {
  const { app, base } = await startApp();
  try {
    const token = await registerAndBind(base);
    assert.equal(
      (await req(base, `/cups/${CUP}/llm`, 'PUT', { provider: 'google', model: 'gemini' }, token)).status,
      400, 'provider 非法 → 400',
    );
    assert.equal(
      (await req(base, `/cups/${CUP}/llm`, 'PUT', { provider: 'openai', model: '  ' }, token)).status,
      400, 'model 空 → 400',
    );
    assert.equal((await req(base, `/cups/${CUP}/llm`, 'POST', {}, token)).status, 405);
  } finally {
    await app.close();
  }
});

// ── HTTP:/ask 用该杯模型(端到端,打到本地"用户的模型"桩)─────────

/** 起一个 OpenAI 兼容的桩端点:记录收到的请求,回一句固定文本 */
async function startLlmStub(): Promise<{ url: string; hits: () => number; close: () => Promise<void>; server: Server }> {
  let count = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      count++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '我用的可是你自己的模型哦。' }, finish_reason: 'stop' }],
      }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    hits: () => count,
    server,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test('/ask:配了该杯模型 → 无令牌 401、问别人配了模型的杯 403(真接线:store → resolveChatLlm)', async () => {
  // 不注入 resolveChatLlm:走 app.ts 默认接线(cupLlm.chatLlm(cupId)),
  // 验"PUT /llm 落库之后,/ask 的会话闸真的自己亮起来"。
  const { app, base } = await startApp();
  try {
    const token = await registerAndBind(base, CUP); // 主人绑定 CUP
    // 给**别人的杯** CUP_OTHER 也配一个模型(主人没绑它)
    const putOther = await req(base, `/cups/${CUP_OTHER}/llm`, 'PUT', {
      provider: 'openai', model: 'm', key: 'sk-o',
    }, token);
    assert.equal(putOther.status, 403, '未绑的杯根本配不了模型');

    // 主人给自己杯配模型(端点随便,不调)
    const put = await req(base, `/cups/${CUP}/llm`, 'PUT', {
      provider: 'openai', model: 'm', key: 'sk-me',
    }, token);
    assert.equal(put.status, 200);

    // 配好之后:无令牌问自己的杯 → 401(会话闸亮起)
    assert.equal((await req(base, `/cups/${CUP}/ask`, 'POST', { q: '在吗' })).status, 401, '无令牌 → 401');

    // 另一个用户注册但**不绑杯**,问 CUP(已配模型)→ 403 而不是 401
    const other = await req(base, '/auth/register', 'POST', {
      email: `o${Math.random().toString(36).slice(2)}@x.com`, password: 'pw123456',
    });
    const otherToken = ((await other.json()) as { token: string }).token;
    assert.equal(
      (await req(base, `/cups/${CUP}/ask`, 'POST', { q: '在吗' }, otherToken)).status,
      403, '别人的杯(已配模型)→ 403',
    );
  } finally {
    await app.close();
  }
});

test('/ask:配了该杯模型 → 真走它(端到端打到桩端点);未配 → 回退全局', async () => {
  const stub = await startLlmStub();
  const { app, base } = await startApp();
  try {
    const token = await registerAndBind(base, CUP);

    // 未配该杯模型 → resolveChatLlm 返回 null → 不走会话闸、回退全局 NullChatLlm
    // → 确定性模板答复(仍 200,不空白)
    const before = await req(base, `/cups/${CUP}/ask`, 'POST', { q: '我今天喝得怎么样' });
    assert.equal(before.status, 200, '未配 → 无令牌也 200(旧路径零回归)');
    assert.equal(stub.hits(), 0, '未配 → 不该打到用户模型');

    // 配该杯模型(端点指向桩)→ /ask 应打到桩并回它的话
    const put = await req(base, `/cups/${CUP}/llm`, 'PUT', {
      provider: 'openai', model: 'my-model', key: 'sk-user', base_url: stub.url,
    }, token);
    assert.equal(put.status, 200);

    const after = await req(base, `/cups/${CUP}/ask`, 'POST', { q: '你用的谁的模型' }, token);
    assert.equal(after.status, 200);
    const ans = (await after.json()) as { answer: { text: string; source: string } };
    assert.equal(ans.answer.source, 'llm', '应由该杯模型作答');
    assert.match(ans.answer.text, /你自己的模型/, '回的是桩端点那句话');
    assert.equal(stub.hits(), 1, '应恰好打到桩一次');
  } finally {
    await app.close();
    await stub.close();
  }
});
