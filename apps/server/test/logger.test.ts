/**
 * 结构化日志 —— 级别过滤 / 字段拼接 / child 上下文 / json 格式 / 旧签名兼容。
 *
 * 这一层的价值全在"能过滤 + 带上下文",所以测试盯的就是这两点:
 * 低于级别的**根本不进 sink**(不靠肉眼剥)、child 的字段**每条都带上**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, parseLogLevel, parseLogFormat, type LogLevel } from '@cup/server';

/** 收集 sink 输出(不碰真 console)。 */
function collector(): { lines: { line: string; level: LogLevel }[]; sink: (l: string, lv: LogLevel) => void } {
  const lines: { line: string; level: LogLevel }[] = [];
  return { lines, sink: (line, level) => lines.push({ line, level }) };
}

test('级别过滤:低于 min 的日志不进 sink', () => {
  const { lines, sink } = collector();
  const log = createLogger({ level: 'warn', sink });
  log.debug('d');
  log.info('i');
  log.warn('w');
  log.error('e');
  assert.deepEqual(lines.map((l) => l.level), ['warn', 'error']);
});

test('旧签名兼容:log(msg, level) 可调用且按级别分流', () => {
  const { lines, sink } = collector();
  const log = createLogger({ sink });
  log('hello', 'warn');
  log('plain'); // 缺省 info
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.level, 'warn');
  assert.equal(lines[1]!.level, 'info');
  assert.match(lines[0]!.line, /hello/);
});

test('text 格式:字段拼成 k=v,含空格的值得引号包', () => {
  const { lines, sink } = collector();
  const log = createLogger({ sink });
  log.info('请求', { method: 'GET', status: 200, note: 'a b' });
  assert.match(lines[0]!.line, /请求/);
  assert.match(lines[0]!.line, /method=GET/);
  assert.match(lines[0]!.line, /status=200/);
  assert.match(lines[0]!.line, /note="a b"/); // 含空格 → JSON 引号
});

test('undefined 字段被跳过,null 保留', () => {
  const { lines, sink } = collector();
  const log = createLogger({ sink });
  log.info('x', { a: undefined, b: null });
  assert.ok(!lines[0]!.line.includes('a='));
  assert.match(lines[0]!.line, /b=null/);
});

test('child 绑定上下文:子 logger 每条都带上字段', () => {
  const { lines, sink } = collector();
  const log = createLogger({ sink });
  const sub = log.child({ cupId: 'cup-A1B2C3' });
  sub.info('一');
  sub.info('二', { extra: 1 });
  assert.match(lines[0]!.line, /cupId=cup-A1B2C3/);
  assert.match(lines[1]!.line, /cupId=cup-A1B2C3/);
  assert.match(lines[1]!.line, /extra=1/);
});

test('child 叠加:后绑的字段覆盖同名、不同名并存', () => {
  const { lines, sink } = collector();
  const log = createLogger({ sink }).child({ a: 1 });
  const sub = log.child({ b: 2, a: 9 });
  sub.info('m');
  assert.match(lines[0]!.line, /b=2/);
  assert.match(lines[0]!.line, /a=9/); // 覆盖
});

test('with 源标记:text 打 [src] 前缀', () => {
  const { lines, sink } = collector();
  const log = createLogger({ sink }).with('http');
  log.info('m');
  assert.match(lines[0]!.line, /^\[http\] INFO m/);
});

test('json 格式:一行 JSON,含 ts/level/msg 与字段', () => {
  const { lines, sink } = collector();
  const log = createLogger({ format: 'json', sink, source: 'mqtt' });
  log.warn('掉了', { deviceId: 'lid-A1B2C3' });
  const obj = JSON.parse(lines[0]!.line) as Record<string, unknown>;
  assert.equal(obj.level, 'warn');
  assert.equal(obj.msg, '掉了');
  assert.equal(obj.src, 'mqtt');
  assert.equal(obj.deviceId, 'lid-A1B2C3');
  assert.equal(typeof obj.ts, 'string');
});

test('isEnabled 与 level 反映有效级别', () => {
  const log = createLogger({ level: 'error' });
  assert.equal(log.level, 'error');
  assert.equal(log.isEnabled('error'), true);
  assert.equal(log.isEnabled('warn'), false);
});

test('parseLogLevel / parseLogFormat:合法取值 + 非法回退', () => {
  assert.equal(parseLogLevel('WARN'), 'warn');
  assert.equal(parseLogLevel('bogus'), 'info');
  assert.equal(parseLogLevel(undefined, 'debug'), 'debug');
  assert.equal(parseLogFormat('JSON'), 'json');
  assert.equal(parseLogFormat('bogus'), 'text');
});
