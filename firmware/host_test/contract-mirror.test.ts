/**
 * 契约镜像守护 —— 固件手写的 C 枚举/字符串 必须与 `@cup/contract` 的枚举**逐字一致**。
 *
 * 为什么需要这道闸:`firmware/components/cup_common/contract_dev.h` 注释写着
 * 「事件类型;必须与 EVENT_TYPES 逐字一致」,但那是句**靠人守的承诺** ——
 * 2026-10-14 契约加了 `tap`/`long_press`,C 镜像就漏了,承诺当场变假话(虽加法不回归)。
 * 这里把它变成**机器守的**:直接读固件源码,和契约的枚举对表,缺一个/多一个/串拼错都红。
 *
 * 覆盖三个枚举:`EVENT_TYPES` ↔ `event_type_t`、`MOTION_STATES` ↔ `motion_state_t`、
 * `DERIVED_BY` ↔ `derived_by_t`;并且断言 C 的 `<enum>_str()` switch 覆盖**全部**成员
 * (漏一个 case 会静默落到 default,是最阴的一类漂移)。
 *
 * 放 firmware/host_test(而非各 app 的 test 目录)因为它读的是 firmware/ 源码;
 * 根 package.json 的 test glob 已含本目录,故随 `npm test` 一起跑(纯 node 内置,零基建、零新依赖)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EVENT_TYPES, MOTION_STATES, DERIVED_BY } from '@cup/contract';

const here = dirname(fileURLToPath(import.meta.url));
const common = join(here, '..', 'components', 'cup_common');
const header = readFileSync(join(common, 'contract_dev.h'), 'utf8');
const impl = readFileSync(join(common, 'contract_dev.c'), 'utf8');

/** 抠出 `typedef enum { ... } <name>;` 体内的全部 <PREFIX>_ 标识符(声明顺序)。 */
function enumMembers(alias: string, prefix: string): string[] {
  // [^}]* 而非 [\s\S]*?:枚举体内无嵌套花括号,用它可以**锁死在单个块内**,
  // 不会从更早的枚举块一路贪婪跨过来(否则会把别处注释里的同名 token 也吃掉)。
  const block = header.match(new RegExp(`typedef enum \\{([^}]*)\\} ${alias};`));
  assert.ok(block, `contract_dev.h 应含 ${alias} 枚举`);
  return [...block[1]!.matchAll(new RegExp(`\\b(${prefix}[A-Z_]+)\\b`, 'g'))].map((m) => m[1]!);
}

/** 抠出 `<fn>(...)` 的 switch 里 `case <IDENT>: return "<str>";` 的映射表。 */
function strMap(fn: string, identPrefix: string): Map<string, string> {
  const body = impl.match(new RegExp(`const char \\*${fn}\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(body, `contract_dev.c 应含 ${fn}`);
  const out = new Map<string, string>();
  for (const m of body[1]!.matchAll(new RegExp(`case\\s+(${identPrefix}[A-Z_]+)\\s*:\\s*return\\s+"([^"]+)"\\s*;`, 'g'))) {
    out.set(m[1]!, m[2]!);
  }
  return out;
}

/**
 * 契约串 ↔ C 标识符的对应:C 去掉前缀、转小写即契约字面量
 * (`EVENT_OFF_BASE` → `off_base`,`MOTION_LIFTED` → `lifted`,`DERIVED_BY_LID` → `lid`)。
 */
function identToContract(ident: string, prefix: string): string {
  return ident.slice(prefix.length).toLowerCase();
}

/** 三枚举共用的对表:成员集一致 + str() 全覆盖且串正确。 */
function checkMirror(alias: string, prefix: string, fn: string, contract: readonly string[]): void {
  const idents = enumMembers(alias, prefix);
  assert.deepEqual(
    idents.map((i) => identToContract(i, prefix)).sort(),
    [...contract].sort(),
    `${alias} 成员须与契约枚举逐字一致(多/少/拼错都在这报)`,
  );

  const map = strMap(fn, prefix);
  // 每个 C 成员都要有 case(漏 case 会静默落 default —— 最阴的漂移)
  for (const id of idents) {
    assert.ok(map.has(id), `${fn} 缺 case ${id}`);
  }
  assert.deepEqual(
    [...map.values()].sort(),
    [...contract].sort(),
    `${fn} 序列化出的字符串集合须等于契约枚举`,
  );
  for (const [id, str] of map) {
    assert.equal(str, identToContract(id, prefix), `${fn}: ${id} 应序列化为 "${identToContract(id, prefix)}"`);
  }
}

test('[契约镜像] event_type_t 与 EVENT_TYPES 逐字一致(含手势加法)', () => {
  checkMirror('event_type_t', 'EVENT_', 'event_type_str', EVENT_TYPES);
});

test('[契约镜像] motion_state_t 与 MOTION_STATES 逐字一致', () => {
  checkMirror('motion_state_t', 'MOTION_', 'motion_state_str', MOTION_STATES);
});

test('[契约镜像] derived_by_t 与 DERIVED_BY 逐字一致', () => {
  checkMirror('derived_by_t', 'DERIVED_BY_', 'derived_by_str', DERIVED_BY);
});

test('[契约镜像] 手势加法确实落进 C 镜像(反向盯防:契约有、C 必须也有)', () => {
  for (const g of ['tap', 'long_press'] as const) {
    assert.ok(EVENT_TYPES.includes(g), `契约应含 ${g}`);
    assert.ok(enumMembers('event_type_t', 'EVENT_').map((i) => identToContract(i, 'EVENT_')).includes(g), `C 镜像应含 ${g}`);
  }
});

// ── 手势阈值:固件宏 ↔ 模拟器常量,双侧同源 ───────────────────────────
// 这四值**不是**契约常量(契约只装结论:事件型 tap/long_press + 必须带 duration_ms;
// "多长算轻磕、多长算长按"归设备端),故不在上面的枚举对表里。
// 但固件(contract_dev.h 的 GESTURE_* 宏)与模拟器(lid.ts 的 GESTURE_* 常量)
// 各自独立写着同一组启发式,容易各改各的 —— 故在此锁死"数值必须相等"。
// 两侧代码注释都声称"由本文件守护",这里让它成真。
const simLid = readFileSync(
  join(here, '..', '..', 'apps', 'simulator', 'src', 'sensors', 'lid.ts'),
  'utf8',
);

/** 从固件头文件抠 `#define <name> <number>` 的数值(容忍 `50.0f` 这类后缀)。 */
function fwMacro(name: string): number {
  const m = header.match(new RegExp(`#define\\s+${name}\\s+(-?[0-9.]+)`));
  assert.ok(m, `contract_dev.h 应含宏 ${name}`);
  return Number(m[1]!.replace(/[fF]$/, ''));
}

/** 从模拟器 TS 抠 `const <name> = <number>;` 的数值。 */
function simConst(name: string): number {
  const m = simLid.match(new RegExp(`const\\s+${name}\\s*=\\s*(-?[0-9.]+)\\s*;`));
  assert.ok(m, `lid.ts 应含常量 ${name}`);
  return Number(m[1]);
}

test('[手势阈值镜像] GESTURE_* 固件宏与模拟器常量数值一致', () => {
  const pairs: Array<[string, string]> = [
    ['GESTURE_PRESS_MIN_G', 'GESTURE_PRESS_MIN_G'],
    ['GESTURE_TAP_MIN_MS', 'GESTURE_TAP_MIN_MS'],
    ['GESTURE_LONG_PRESS_MS', 'GESTURE_LONG_PRESS_MS'],
  ];
  for (const [fw, sim] of pairs) {
    assert.equal(
      fwMacro(fw),
      simConst(sim),
      `${fw}(固件) 与 ${sim}(模拟器) 数值须一致 —— 两侧同源,别各改各的`,
    );
  }
});
