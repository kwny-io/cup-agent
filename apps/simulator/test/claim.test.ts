/**
 * 模拟器 · 设备一次性 claim code(可信绑定的设备半)—— 纯函数单测。
 *
 * 钉的是**与固件的形状与算法一致**,不是"能不能跑":
 *   · `generateClaim` 逐位复刻固件 `claim_code_generate`(splitmix64 + Crockford):
 *     同 seed → 同码(可复现)、定长 8、每字符在字母表内、**无易混的 I/L/O/U**。
 *     形状对了,服务端 `normalizeClaim` 才收得下(它要求恰 8 且全在字母表内)。
 *   · `buildHello` 产出真机字段集 `{kind,v,cup_id,device_id,claim,issued_at}`(镜像固件 mqtt_uplink.c)。
 *   · `deriveSeed64` 确定性:同 seed+salt → 同值;异 salt → 异值。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateClaim, buildHello, deriveSeed64, CLAIM_ALPHABET, CLAIM_LEN } from '@cup/simulator';

test('generateClaim:定长 8、每字符在 Crockford 字母表内(无 I/L/O/U)', () => {
  for (const seed of [0n, 1n, 12345n, 0xdeadbeefn, (1n << 63n) | 7n]) {
    const code = generateClaim(seed);
    assert.equal(code.length, CLAIM_LEN, `seed=${seed} 长度应恰 ${CLAIM_LEN}`);
    for (const ch of code) {
      assert.ok(CLAIM_ALPHABET.includes(ch), `seed=${seed} 字符 ${ch} 应在字母表内`);
    }
    assert.equal(/[ILOU]/.test(code), false, `seed=${seed} 确无易混字符 I/L/O/U:${code}`);
  }
});

test('generateClaim:确定性 —— 同种子同码,异种子(抽查)异码', () => {
  assert.equal(generateClaim(999n), generateClaim(999n), 'seed=999 两次一致');
  assert.notEqual(generateClaim(1n), generateClaim(2n), 'seed 1 vs 2 不同');
});

test('buildHello:真机字段集,claim 原样带上', () => {
  const code = generateClaim(42n);
  const h = buildHello('lid-A1B2C3', 'cup-A1B2C3', code, 1_700_000_000_000);
  assert.deepEqual(h, {
    kind: 'hello',
    v: 1,
    cup_id: 'cup-A1B2C3',
    device_id: 'lid-A1B2C3',
    claim: code,
    issued_at: 1_700_000_000_000,
  });
});

test('deriveSeed64:确定性,异 salt 异流', () => {
  assert.equal(deriveSeed64(42, 1), deriveSeed64(42, 1), '同 seed+salt 一致');
  assert.notEqual(deriveSeed64(42, 1), deriveSeed64(42, 2), '异 salt 异值');
  assert.notEqual(deriveSeed64(42, 1), deriveSeed64(43, 1), '异 seed 异值');
  // 产出的种子喂 generateClaim 应得合法码(接线正确性)
  const code = generateClaim(deriveSeed64(42, 1));
  assert.equal(code.length, CLAIM_LEN);
  assert.equal(/[ILOU]/.test(code), false);
});
