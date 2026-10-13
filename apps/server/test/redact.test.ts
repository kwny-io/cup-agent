/**
 * 写入时脱敏 —— 纯函数,零基建。
 *
 * 钉的是"落盘前敏感值已被抹净"的口径:
 *   · 键名命中 `SENSITIVE_KEYS`(大小写不敏感)→ 整值 `[REDACTED]`;
 *   · `msg`/字符串值里的 `Bearer <t>`、`token=…`、`password: …` → 抹值留名;
 *   · 邮箱 → 局部掩码(留首字符 + 域名);
 *   · **非敏感原样透传**、**不动入参**(返回新对象)、数字/布尔/null 透传。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactFields, maskEmail, SENSITIVE_KEYS, REDACTED } from '@cup/server';

test('键名脱敏:命中 SENSITIVE_KEYS 的整值抹除(大小写不敏感)', () => {
  const out = redactFields({
    msg: 'login',
    fields: { Authorization: 'Bearer abcdef123456', password: 'hunter2', 'X-Api-Key': 'k1234567' },
  });
  assert.equal(out.fields.Authorization, REDACTED);
  assert.equal(out.fields.password, REDACTED);
  assert.equal(out.fields['X-Api-Key'], REDACTED);
});

test('键名脱敏:cookie / set-cookie / claim_code / secret / token 系列', () => {
  const out = redactFields({
    msg: 'x',
    fields: {
      cookie: 'sid=1234567890',
      'set-cookie': 'sid=1234567890',
      claim_code: 'ABCD-EFGH',
      secret: 'shhh-secret',
      access_token: 'at-1234567890',
      refresh_token: 'rt-1234567890',
    },
  });
  for (const k of ['cookie', 'set-cookie', 'claim_code', 'secret', 'access_token', 'refresh_token']) {
    assert.equal(out.fields[k], REDACTED, `${k} 应被抹`);
  }
  assert.ok(SENSITIVE_KEYS.includes('token'));
});

test('非敏感字段原样透传', () => {
  const out = redactFields({ msg: 'ok', fields: { cupId: 'cup-A1', status: 200, ok: true } });
  assert.equal(out.fields.cupId, 'cup-A1');
  assert.equal(out.fields.status, 200);
  assert.equal(out.fields.ok, true);
});

test('字符串值里的 Bearer 令牌 → 抹值留名', () => {
  const out = redactFields({ msg: 'auth', fields: { header: 'Bearer sk-opc-abcdef123456' } });
  assert.equal(out.fields.header, `Bearer ${REDACTED}`);
});

test('具名密钥(token= / password: / api_key=)抹值留名', () => {
  const out = redactFields({
    msg: 'token=abcdef123456 inline',
    fields: { note: 'password: hunter2zzz', other: 'api_key=ABCDEF123456' },
  });
  assert.equal(out.msg, `token=${REDACTED} inline`);
  assert.equal(out.fields.note, `password=${REDACTED}`);
  assert.equal(out.fields.other, `api_key=${REDACTED}`);
});

test('正文里出现裸词 "password policy" 不误伤(无分隔符+值)', () => {
  const out = redactFields({ msg: 'password policy updated', fields: {} });
  assert.equal(out.msg, 'password policy updated');
});

test('邮箱 → 局部掩码(留首字符 + 域名)', () => {
  const out = redactFields({
    msg: '注册 ann@x.com 成功',
    fields: { email: 'moggy.li+tg@sub.x.com' },
  });
  assert.equal(out.fields.email, 'm***@sub.x.com');
  assert.equal(out.msg, '注册 a***@x.com 成功');
});

test('maskEmail:边界', () => {
  assert.equal(maskEmail('a@b.com'), 'a***@b.com');
  assert.equal(maskEmail('@b.com'), '@b.com'); // local 为空 → 原样
  assert.equal(maskEmail('no-at-sign'), 'no-at-sign');
});

test('不动入参(返回新对象)', () => {
  const input = { msg: 'login token=abcdef123456', fields: { password: 'hunter2' } };
  const snapshot = JSON.parse(JSON.stringify(input)) as typeof input;
  redactFields(input);
  assert.deepEqual(input, snapshot);
});

test('数字/布尔/null 透传;undefined 保留', () => {
  const out = redactFields({ msg: 'x', fields: { n: 42, b: false, z: null, u: undefined } });
  assert.equal(out.fields.n, 42);
  assert.equal(out.fields.b, false);
  assert.equal(out.fields.z, null);
  assert.equal(out.fields.u, undefined);
  assert.ok('u' in out.fields);
});

test('空 fields / 空 msg 不炸', () => {
  assert.deepEqual(redactFields({ msg: '', fields: {} }), { msg: '', fields: {} });
});
