/**
 * 分享卡邀请链接的纯逻辑(lib/invite.ts)—— 不碰 React / DOM。
 * 钉的是"链接并入 invite 时**保留 ?cloud=**"(落地页要靠它连对后端)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInviteLink, inviteCodeFromSearch } from '../src/lib/invite.ts';

test('buildInviteLink:并入 invite,且**保留** ?cloud=', () => {
  const link = buildInviteLink('ABCDEFGHJK', '?cloud=http://localhost:8788', 'http://x.io', '/');
  const u = new URL(link);
  assert.equal(u.searchParams.get('invite'), 'ABCDEFGHJK');
  assert.equal(u.searchParams.get('cloud'), 'http://localhost:8788', 'cloud 不能被挤掉');
});

test('buildInviteLink:已有其他参数一并保留', () => {
  const link = buildInviteLink('ABCDEFGHJK', '?cloud=http://a&cup=cup-1', 'http://x.io', '/app');
  const u = new URL(link);
  assert.equal(u.searchParams.get('cloud'), 'http://a');
  assert.equal(u.searchParams.get('cup'), 'cup-1');
  assert.equal(u.searchParams.get('invite'), 'ABCDEFGHJK');
});

test('buildInviteLink:空码 → 原样返回当前 URL(不塞空 invite)', () => {
  const link = buildInviteLink('  ', '?cloud=http://a', 'http://x.io', '/');
  const u = new URL(link);
  assert.equal(u.searchParams.get('invite'), null);
  assert.equal(u.searchParams.get('cloud'), 'http://a');
});

test('buildInviteLink:覆盖已有 invite(重新生成)', () => {
  const link = buildInviteLink('NEWCODE123', '?invite=OLDCODE123', 'http://x.io', '/');
  assert.equal(new URL(link).searchParams.get('invite'), 'NEWCODE123');
});

test('inviteCodeFromSearch:取出去空白;空 / 缺 → null', () => {
  assert.equal(inviteCodeFromSearch('?invite=ABCDEFGHJK'), 'ABCDEFGHJK');
  assert.equal(inviteCodeFromSearch('?invite=%20ABC%20'), 'ABC');
  assert.equal(inviteCodeFromSearch('?invite='), null);
  assert.equal(inviteCodeFromSearch('?invite=%20%20'), null);
  assert.equal(inviteCodeFromSearch('?cloud=http://a'), null);
});
