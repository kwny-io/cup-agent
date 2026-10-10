/**
 * 行为脚本:典型一天。
 *
 * 目标不只是"看起来合理",而是**恰好覆盖每种事件**:
 *   drink × N / refill / shake / temp_alert(过热) / low_battery / off_base
 * 以及**否定用例**:拿起又放下(未越阈值)→ 不应产生事件。
 */
import {
  drinkStep,
  hotWaterStep,
  refillStep,
  shakeStep,
  step,
  hhmm,
  type ScriptStep,
} from '../core/engine.ts';

/** 典型一天:从 07:00 到 21:00 */
export function typicalDay(): ScriptStep[] {
  return [
    // 早上:续杯(隔夜水凉了,倒掉换热的)
    refillStep(hhmm('07:00'), 350, 60),
    drinkStep(hhmm('07:30'), 120),
    drinkStep(hhmm('08:15'), 100),

    // 上午:拿起又放下(否定用例,不应产生事件)
    step(hhmm('09:00'), '拿起又放下(未喝,应无事件)', (ctx) => {
      ctx.world.setOnBase(false);
      ctx.world.setMotion('lifted');
      ctx.scheduler.at(ctx.clock.nowMs + 2000, () => {
        ctx.world.setOnBase(true);
        ctx.world.setMotion('idle');
      }, '放回');
    }),

    drinkStep(hhmm('10:00'), 80),
    shakeStep(hhmm('10:30'), 1500), // 摇杯(英雄功能的数据源)

    // 中午:倒热水 → 触发 temp_alert
    hotWaterStep(hhmm('12:00'), 360, 72),
    drinkStep(hhmm('12:20'), 90),

    // 下午
    drinkStep(hhmm('14:00'), 110),
    shakeStep(hhmm('15:00'), 2000),
    refillStep(hhmm('15:30'), 380, 45),
    drinkStep(hhmm('16:30'), 130),
    drinkStep(hhmm('18:00'), 100),

    // 傍晚:把杯子拿走离开(触发 off_base,之后一直不在座上)
    step(hhmm('19:30'), '拿走杯子离开(off_base,之后不在座)', (ctx) => {
      ctx.world.setOnBase(false);
      ctx.world.setMotion('lifted');
    }),

    // 晚上回来放回
    step(hhmm('21:00'), '回来放回杯子', (ctx) => {
      ctx.world.setOnBase(true);
      ctx.world.setMotion('idle');
    }),
  ];
}

/** 简短冒烟脚本:跑几十秒就覆盖主要路径(给测试/快速演示) */
export function smoke(): ScriptStep[] {
  return [
    step(5_000, '倒热水到 70°C(触发 temp_alert)', (ctx) => {
      ctx.world.setOnBase(false);
      ctx.world.setMotion('lifted');
      // 换一壶热水(而非兑入),整杯变为 70°C,才能越过 65°C 阈值
      ctx.world.refillTo(350, 70);
      ctx.scheduler.at(ctx.clock.nowMs + 3000, () => {
        ctx.world.setOnBase(true);
        ctx.world.setMotion('idle');
      }, '放回');
    }),
    drinkStep(30_000, 120),
    shakeStep(60_000, 1500),
    drinkStep(90_000, 90),
    step(120_000, '拿起又放下(应无事件)', (ctx) => {
      ctx.world.setOnBase(false);
      ctx.scheduler.at(ctx.clock.nowMs + 2000, () => ctx.world.setOnBase(true), '放回');
    }),
  ];
}
