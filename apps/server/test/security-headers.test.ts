/**
 * 安全响应头 / CORS 白名单 / TLS —— 起真 HTTP(S) 验**线上真发出去的头**,
 * 而不是只测内部函数(否则中间某层漏设了也测不出)。
 *
 * 覆盖:
 *   · 每个响应(200 / 404 / 401 / 429 / 预检 204)都带安全头
 *   · HSTS 只在真 TLS 时发 —— 明文下发 HSTS 会锁死用户浏览器
 *   · CORS:未配白名单 → `*`;配了 → 只回显名单内 Origin,名单外不发布
 *   · TLS:`createApp({tlsCertPath,tlsKeyPath})` 起 https,请求能通
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '@cup/server';
import { createRateLimiter } from '../src/api/rate-limit.ts';

const CUP = 'cup-A1B2C3';

async function start(extra: Parameters<typeof createApp>[0] = {}) {
  const app = createApp({ log: () => {}, allowUnauth: true, ...extra });
  const port = await app.listen(0);
  return { app, base: `http://127.0.0.1:${port}` };
}

/** 所有响应都该带的那几条。 */
const ALWAYS: ReadonlyArray<[string, string]> = [
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'DENY'],
  ['referrer-policy', 'no-referrer'],
  ['cross-origin-resource-policy', 'same-site'],
  ['content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"],
];

function assertSecurityHeaders(r: Response, label: string): void {
  for (const [name, want] of ALWAYS) {
    assert.equal(r.headers.get(name), want, `${label}: 缺 ${name}`);
  }
  assert.equal(r.headers.get('strict-transport-security'), null, `${label}: 明文不应发 HSTS`);
}

// ── 安全头覆盖各类响应 ────────────────────────────────────────

test('安全头:200 / 404 / 401 都带', async () => {
  const { app, base } = await start();
  try {
    const ok = await fetch(`${base}/healthz`);
    assert.equal(ok.status, 200);
    assertSecurityHeaders(ok, '200');

    const notFound = await fetch(`${base}/nope/nope`);
    assert.equal(notFound.status, 404);
    assertSecurityHeaders(notFound, '404');

    // 401:不带 key 打写端点。单独起一个**强制鉴权**的 app(allowUnauth 会豁免)。
    const strict = createApp({ log: () => {} });
    const strictPort = await strict.listen(0);
    try {
      const unauth = await fetch(`http://127.0.0.1:${strictPort}/cups/${CUP}/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(unauth.status, 401);
      assertSecurityHeaders(unauth, '401');
    } finally {
      await strict.close();
    }
  } finally {
    await app.close();
  }
});

test('安全头:预检 204 也带(否则浏览器拿不到 CORS 头)', async () => {
  const { app, base } = await start();
  try {
    const r = await fetch(`${base}/cups/${CUP}/goal`, {
      method: 'OPTIONS',
      headers: { origin: 'http://example.com', 'access-control-request-method': 'PUT' },
    });
    assert.equal(r.status, 204);
    assertSecurityHeaders(r, '204');
  } finally {
    await app.close();
  }
});

test('安全头:429 也带(限流响应同样过入口)', async () => {
  const limiter = createRateLimiter({
    rules: { default: { capacity: 1, refillPerSec: 0 } },
    now: () => 1_000_000,
  });
  const { app, base } = await start({ rateLimit: limiter });
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const limited = await fetch(`${base}/healthz`);
    assert.equal(limited.status, 429);
    assertSecurityHeaders(limited, '429');
    // 429 还该带 Retry-After(客户端退避的依据)
    assert.ok(limited.headers.get('retry-after'), '429 应带 Retry-After');
    const body = (await limited.json()) as { error: string; retry_after: number };
    assert.equal(body.error, 'rate_limited');
    assert.ok(Number.isInteger(body.retry_after));
  } finally {
    await app.close();
  }
});

// ── CORS ─────────────────────────────────────────────────────

test('CORS:未配白名单 → `*`(本地开发零配置)', async () => {
  const { app, base } = await start();
  try {
    const r = await fetch(`${base}/healthz`, { headers: { origin: 'http://random.dev' } });
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    // `*` 时不该发 Allow-Credentials(规范不允许通配符 + 凭据)
    assert.equal(r.headers.get('access-control-allow-credentials'), null);
    assert.equal(r.headers.get('vary'), null);
  } finally {
    await app.close();
  }
});

test('CORS:白名单命中 → 回显该源 + Vary + 允许凭据', async () => {
  const { app, base } = await start({ corsOrigins: ['https://cup.example.com'] });
  try {
    const hit = await fetch(`${base}/healthz`, { headers: { origin: 'https://cup.example.com' } });
    assert.equal(hit.headers.get('access-control-allow-origin'), 'https://cup.example.com');
    assert.equal(hit.headers.get('vary'), 'Origin');
    assert.equal(hit.headers.get('access-control-allow-credentials'), 'true');
  } finally {
    await app.close();
  }
});

test('CORS:白名单未命中 → 不发布 CORS 头(浏览器侧自然拦下)', async () => {
  const { app, base } = await start({ corsOrigins: ['https://cup.example.com'] });
  try {
    const miss = await fetch(`${base}/healthz`, { headers: { origin: 'https://evil.example' } });
    assert.equal(miss.status, 200, '服务端照常响应 —— CORS 是浏览器侧的策略');
    assert.equal(miss.headers.get('access-control-allow-origin'), null, '不得回显未授权的源');
    assert.equal(miss.headers.get('access-control-allow-credentials'), null);
  } finally {
    await app.close();
  }
});

// ── TLS ──────────────────────────────────────────────────────

test('TLS:配了证书私钥 → 起 https,且发 HSTS', async (t) => {
  // 自签证书:用 node 内置 crypto 手搓太绕,这里用 openssl 若不可用则跳过。
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'cup-tls-'));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=localhost', '-keyout', key, '-out', cert],
      { stdio: 'ignore' },
    );
  } catch {
    t.skip('本机没有 openssl,跳过 TLS 实测');
    return;
  }

  const app = createApp({ log: () => {}, allowUnauth: true, tlsCertPath: cert, tlsKeyPath: key });
  assert.equal(app.tls, true, 'createApp 应报告走 TLS');
  const port = await app.listen(0);
  try {
    const https = await import('node:https');
    // 自签证书:显式关校验(仅测试)
    const body = await new Promise<string>((resolve, reject) => {
      const req = https.request(
        { host: '127.0.0.1', port, path: '/healthz', rejectUnauthorized: false },
        (res) => {
          // 断言挂在真响应头上
          assert.equal(res.headers['strict-transport-security'], 'max-age=63072000; includeSubDomains');
          assert.equal(res.headers['x-content-type-options'], 'nosniff');
          let s = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (s += c));
          res.on('end', () => resolve(s));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal((JSON.parse(body) as { ok: boolean }).ok, true, 'https 上 /healthz 该正常');
    assert.ok(readFileSync(cert).length > 0);
  } finally {
    await app.close();
  }
});

test('TLS:只配一半 → 启动期就抛(不留下一个半死配置)', () => {
  assert.throws(
    () => createApp({ log: () => {}, tlsCertPath: 'C:/nope/cert.pem' }),
    /TLS 配置不完整/,
    '只给 cert 不给 key 应早失败',
  );
});
