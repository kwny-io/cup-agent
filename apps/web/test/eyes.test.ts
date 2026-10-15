/**
 * 眼睛状态机 + 128×128 点阵渲染的回归 —— 只验逻辑与像素,不碰 DOM。
 * 对应创意备忘 §3 十二态词汇表。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Eyes, DEFAULT_EYE_PARAMS, type EyeInputs } from '../src/lib/eyes.ts';
import { renderEyeGrid, litCount, EYE_W, EYE_H } from '../src/lib/eye-render.ts';

const DT = 1 / 120;

function inp(over: Partial<EyeInputs> = {}): EyeInputs {
  return {
    owner: 'lid',
    motion: null,
    tiltDeg: 0,
    tiltDir: 0,
    batteryPct: 80,
    charging: false,
    level01: 0.6,
    tempC: 30,
    disposition: 'normal',
    idleSec: 0,
    forgotSec: 0,
    ...over,
  };
}

/** 用固定输入推进 n 秒,返回期间出现过的状态集合(眨眼是瞬态,要收集) */
function run(e: Eyes, seconds: number, i: EyeInputs): Set<string> {
  const seen = new Set<string>();
  const steps = Math.round(seconds / DT);
  for (let k = 0; k < steps; k++) {
    e.step(DT, i);
    seen.add(e.current);
  }
  return seen;
}

// ── 状态决议(§1.3 优先级)──────────────────────────────────────

test('交接最高优先:owner=screen → 闭眼(sleep)', () => {
  const e = new Eyes();
  e.step(DT, inp({ owner: 'screen', motion: 'shake' })); // 即便在摇
  assert.equal(e.current, 'sleep');
});

test('摇杯受惊:瞳孔放大且压制其它心情', () => {
  const e = new Eyes();
  e.step(DT, inp({ motion: 'shake', disposition: 'sulky' }));
  assert.equal(e.current, 'startled');
  assert.ok(e.currentPose.pupilScale > 1.2, '瞳孔应放大');
  assert.ok(e.currentPose.openness > 1, '应瞪大');
});

test('受惊会自收,回落到底色(sulky)', () => {
  const e = new Eyes();
  const s = inp({ motion: 'shake', disposition: 'sulky' });
  run(e, 0.4, s);
  assert.equal(e.current, 'startled');
  // 摇停 + 受惊计时走完 → 回落
  run(e, 2, inp({ motion: null, disposition: 'sulky' }));
  assert.equal(e.current, 'sulky');
});

test('lifted → 看主人,瞳孔上看', () => {
  const e = new Eyes();
  e.step(DT, inp({ motion: 'lifted' }));
  assert.equal(e.current, 'look');
  assert.ok(e.currentPose.gazeY < 0, '瞳孔应上移(gazeY 负)');
});

test('倾斜 → 跟随:视线朝低处,整眼微转', () => {
  const e = new Eyes();
  e.step(DT, inp({ motion: 'tilt', tiltDeg: 40, tiltDir: 0 }));
  assert.equal(e.current, 'tilt');
  assert.ok(Math.abs(e.currentPose.rotate) > 0.01, '应有旋转');
});

test('低电 → 虚弱:半闭 + 瞳孔缩小;充电时不算', () => {
  const e = new Eyes();
  e.step(DT, inp({ batteryPct: 10 }));
  assert.equal(e.current, 'weak');
  assert.ok(e.currentPose.openness < 0.6, '应半闭');
  assert.ok(e.currentPose.pupilScale < 1, '瞳孔应缩小');

  const e2 = new Eyes();
  e2.step(DT, inp({ batteryPct: 10, charging: true }));
  assert.notEqual(e2.current, 'weak');
});

test('低电 → 虚弱:三次慢眨(§3 #11),状态名仍是 weak,靠眼睑下压表现', () => {
  const e = new Eyes();
  const weak = inp({ batteryPct: 10 });
  // 慢眨是 weak 态内眼睑从 0.42 基线继续下压 → 数"低于基线"的连续段
  const runs: number[] = [];
  let run = 0;
  const steps = Math.round(9 / DT);
  for (let k = 0; k < steps; k++) {
    e.step(DT, weak);
    assert.equal(e.current, 'weak', '慢眨期间状态名不变(半闭是常驻)');
    if (e.currentPose.openness < 0.41) run += 1;
    else if (run > 0) { runs.push(run); run = 0; }
  }
  if (run > 0) runs.push(run);
  assert.equal(runs.length, 3, `9s 内应恰好慢眨三次,实得 ${runs.length}`);
  const slowest = Math.max(...runs) * DT;
  assert.ok(slowest > 0.5, `慢眨一拍应 ~0.7s(远长于常态 0.18s),实得 ${slowest.toFixed(2)}s`);
});

test('喝一口 → 满足(弧眼),有时限会自收', () => {
  const e = new Eyes();
  e.noteDrink();
  e.step(DT, inp());
  assert.equal(e.current, 'content');
  assert.equal(e.currentPose.arc, true);
  run(e, 5, inp()); // 超过 3.5s
  assert.equal(e.current, 'idle');
});

test('手势语法:一次性强制表情会点亮指定态,时长到点回落', () => {
  const e = new Eyes();
  e.noteExpression('content', 2.5);
  e.step(DT, inp({ disposition: 'sulky' }));
  assert.equal(e.current, 'content', '强制表情应压过长期底色');
  run(e, 3, inp({ disposition: 'sulky' })); // 超过 2.5s
  assert.equal(e.current, 'sulky', '到点应收,回落到长焦底色');
});

test('手势语法:强制表情不越交接铁律(屏幕持脸仍闭眼)', () => {
  const e = new Eyes();
  e.noteExpression('smug', 2);
  e.step(DT, inp({ owner: 'screen' }));
  assert.equal(e.current, 'sleep', '交接是铁律:同一时刻只允许一处睁眼');
});

test('被遗忘(抗议):转开视线,且压过普通长期性格', () => {
  const e = new Eyes();
  e.step(DT, inp({ forgotSec: 3 * 3600, disposition: 'smug' }));
  assert.equal(e.current, 'forgotten');
  assert.ok(e.currentPose.gazeX < -0.5, '应坚决转开');
});

test('长期性格底色:smug → 得意(微眯);sulky → 蔫(下垂)', () => {
  const esm = new Eyes();
  esm.step(DT, inp({ disposition: 'smug' }));
  assert.equal(esm.current, 'smug');
  assert.ok(esm.currentPose.squint > 0.4, '得意应眯眼');

  const esu = new Eyes();
  esu.step(DT, inp({ disposition: 'sulky' }));
  assert.equal(esu.current, 'sulky');
  assert.ok(esu.currentPose.gazeY > 0, '蔫应视线向下');
});

test('打盹:长时间无事件(且无其它更优先态)', () => {
  const e = new Eyes();
  e.step(DT, inp({ idleSec: 31 * 60 }));
  assert.equal(e.current, 'nap');
  assert.ok(e.currentPose.openness < 0.1, '打盹是两条线');
});

test('优先级:受惊 > 低电 > 满足 > 被遗忘 > 底色', () => {
  const e = new Eyes();
  e.noteDrink();
  e.step(DT, inp({ motion: 'shake', batteryPct: 5, forgotSec: 9 * 3600, disposition: 'smug' }));
  assert.equal(e.current, 'startled'); // 摇杯受惊最优先(本地物理)
});

// ── 眨眼(§3 #4,"活着的第一要素")──────────────────────────────

test('待机会眨眼,且眨眼是瞬态终会睁开', () => {
  const e = new Eyes();
  const seen = run(e, 8, inp());
  assert.ok(seen.has('blink'), '8s 内应至少眨一次');
  // 眨完后回到 idle(眨眼不常驻)
  run(e, 2, inp());
  assert.ok(e.current === 'idle' || e.current === 'blink');
});

test('闭眼/睡眠态不眨眼', () => {
  const e = new Eyes();
  const seen = run(e, 10, inp({ owner: 'screen' }));
  assert.ok(!seen.has('blink'), '闭眼时不该眨眼');
});

// ── 点阵渲染(§3 像素级描述)────────────────────────────────────

test('点阵尺寸恒为 128×128', () => {
  const e = new Eyes();
  e.step(DT, inp());
  const g = renderEyeGrid(e.currentPose);
  assert.equal(g.length, EYE_W * EYE_H);
});

test('睁眼有内容;闭眼只剩两条线(亮像素大幅减少)', () => {
  const open = new Eyes();
  open.step(DT, inp());
  const openLit = litCount(renderEyeGrid(open.currentPose));

  const shut = new Eyes();
  shut.step(DT, inp({ owner: 'screen' }));
  const shutLit = litCount(renderEyeGrid(shut.currentPose));

  assert.ok(openLit > 200, `睁眼应点亮较多像素,实得 ${openLit}`);
  assert.ok(shutLit > 0 && shutLit < openLit, `闭眼应更少,实得 ${shutLit}`);
});

test('瞳孔是挖空的暗区:眼窝中心随 gaze 偏移而变化', () => {
  const a = new Eyes();
  a.step(DT, inp({ motion: 'tilt', tiltDeg: 45, tiltDir: 0 })); // 视线偏
  const pb = a.currentPose;
  // 找瞳孔中心(眼窝内挖空区):统计暗像素质心,应与 gazeX 同向偏
  const g = renderEyeGrid(pb);
  // 左眼窝中心 x=44 附近,瞳孔暗区质心应 > 44(向右偏)
  let sumX = 0;
  let n = 0;
  for (let y = 45; y < 84; y++) {
    for (let x = 30; x < 58; x++) {
      if (g[y * EYE_W + x] === 0) {
        sumX += x;
        n++;
      }
    }
  }
  assert.ok(n > 0, '左眼窝内应有瞳孔暗像素');
  assert.ok(sumX / n > 44, '瞳孔质心应随视线右偏');
  void pb;
});

test('满足态:arc 换弧眼,与常态点阵不同', () => {
  const idleE = new Eyes();
  idleE.step(DT, inp());
  const idleGrid = renderEyeGrid(idleE.currentPose);

  const contentE = new Eyes();
  contentE.noteDrink();
  contentE.step(DT, inp());
  const contentGrid = renderEyeGrid(contentE.currentPose);

  let diff = 0;
  for (let i = 0; i < idleGrid.length; i++) if (idleGrid[i] !== contentGrid[i]) diff++;
  assert.ok(diff > 50, `弧眼应与常态明显不同,差异像素 ${diff}`);
});

// ── 加分项:水烫 → 蒸汽纹 + 眯眼(§3,叠加态不新增状态)────────

test('水烫不新增状态,只在 idle 姿态上叠眯眼', () => {
  const cool = new Eyes();
  cool.step(DT, inp({ tempC: 30 }));
  const hot = new Eyes();
  hot.step(DT, inp({ tempC: 70 }));

  assert.equal(hot.current, 'idle', '烫仍属待机态(叠加,非独立状态)');
  assert.equal(cool.currentPose.hot, false);
  assert.equal(hot.currentPose.hot, true);
  assert.ok(hot.currentPose.squint > cool.currentPose.squint, '烫应叠一层眯眼');
});

test('水烫在点阵上多出蒸汽纹(眼窝上方,且随时间飘动)', () => {
  // 蒸汽画在眼窝上沿之上(y < 38):常态该带应无亮像素,烫时出现
  const countSteamBand = (grid: Uint8Array): number => {
    let n = 0;
    for (let y = 0; y < 38; y++) for (let x = 0; x < EYE_W; x++) if (grid[y * EYE_W + x]) n++;
    return n;
  };

  const cool = new Eyes();
  cool.step(DT, inp({ tempC: 30 }));
  const coolGrid = renderEyeGrid(cool.currentPose);

  const hot = new Eyes();
  hot.step(DT, inp({ tempC: 70 }));
  const hotGrid = renderEyeGrid(hot.currentPose);
  assert.equal(countSteamBand(coolGrid), 0, '常态眼窝上方不应有像素');
  assert.ok(countSteamBand(hotGrid) > 0, '烫应在上方多出蒸汽像素');

  // 相位推进 → 蒸汽纹位置变化(hot 与后续帧点阵不同)
  run(hot, 0.5, inp({ tempC: 70 }));
  const hotGrid2 = renderEyeGrid(hot.currentPose);
  let moved = 0;
  for (let i = 0; i < hotGrid.length; i++) if (hotGrid[i] !== hotGrid2[i]) moved++;
  assert.ok(moved > 0, '蒸汽纹应随时间飘动');
});

test('水温未知(null)不蒸汽;降温到阈值下蒸汽消失', () => {
  const e = new Eyes();
  e.step(DT, inp({ tempC: null }));
  assert.equal(e.currentPose.hot, false, '未知水温不应蒸汽');

  e.step(DT, inp({ tempC: 70 }));
  assert.equal(e.currentPose.hot, true);
  run(e, 0.2, inp({ tempC: 40 }));
  assert.equal(e.currentPose.hot, false, '降温后应停止蒸汽');
});

// ── 交接协议 §1.3:"交接是一个动作,不是一次切换"─────────────

test('交接给屏幕:状态当帧即切,但眼睑在 ~0.4s 内**逐渐闭合**(签名时刻)', () => {
  const e = new Eyes();
  e.step(DT, inp({ owner: 'lid' }));
  assert.ok(e.currentPose.openness > 0.99, '先前应睁着');

  e.step(DT, inp({ owner: 'screen' }));
  assert.equal(e.current, 'sleep', '状态当帧即交接');
  assert.ok(e.currentPose.openness > 0 && e.currentPose.openness < 1, '但开度应在中途(不是瞬灭屏)');

  run(e, 0.5, inp({ owner: 'screen' })); // 走满 0.4s 交接时长
  assert.ok(e.currentPose.openness < 0.02, `应已闭全,实得 ${e.currentPose.openness}`);
});

test('交接回盖子:眼睑**逐渐睁开**(反向同样平滑)', () => {
  const e = new Eyes();
  run(e, 0.6, inp({ owner: 'screen' })); // 先闭全
  assert.ok(e.currentPose.openness < 0.02);

  e.step(DT, inp({ owner: 'lid' }));
  assert.ok(e.currentPose.openness > 0 && e.currentPose.openness < 1, '应处于睁眼中途');
  run(e, 0.6, inp({ owner: 'lid' }));
  assert.ok(e.currentPose.openness > 0.98, '应已睁回');
});

// ── P4.2 人格包注入口(setParams)────────────────────────────────

test('注入口:CONTENT_S 拉长 → "满足"表情更久才自收', () => {
  // 出厂 3.5s;包里给 8s → noteDrink 后 5s 仍应 content
  const e = new Eyes();
  e.setParams({ contentS: 8 });
  e.noteDrink();
  run(e, 5, inp()); // 越过出厂 3.5s
  assert.equal(e.current, 'content');

  // 对照:出厂参数下同样过 5s 早该散
  const d = new Eyes();
  d.noteDrink();
  run(d, 5, inp());
  assert.notEqual(d.current, 'content');
});

test('注入口:默认参数 = 出厂体质(不装包时行为一致)', () => {
  const a = new Eyes();
  const b = new Eyes();
  b.setParams(DEFAULT_EYE_PARAMS);
  a.noteDrink();
  b.noteDrink();
  run(a, 2, inp());
  run(b, 2, inp());
  assert.equal(a.current, b.current);
});
