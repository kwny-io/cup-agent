/**
 * 宿主单测 —— 底座称重判定(base_weight.c)。零 IDF,mingw 直接跑。
 * 覆盖:present/stable 窗口、drink/refill 阈值、off_base 120s 延迟、
 *       短暂拿起不误报、低电量滞回、窗口标准差。
 */
#include "base_weight.h"

#include <math.h>
#include <stdio.h>

static int g_fail = 0, g_total = 0;
static void ok(int cond, const char *what) {
    g_total++;
    if (!cond) { g_fail++; printf("  ✗ %s\n", what); }
    else printf("  ✓ %s\n", what);
}

// 皮重 285 + 水 200 = 485g 是"一杯水"的常用基准
#define TARE 285.0f

/**
 * 在座上稳定到 RESTING:喂满窗口 + 跨过 800ms。
 * 事件是**单帧上升沿**(落在某帧上),故这里把各帧输出并起来,返回"这段里发生过的"事件。
 */
static base_weight_out_t settle_at(base_weight_t *st, float w, uint32_t *t) {
    base_weight_out_t acc = {0};
    for (int i = 0; i < BASE_STD_WINDOW + 2; i++) {
        base_weight_out_t o = base_weight_step(st, w, 80, *t);  // 恒重 → 标准差 0
        if (o.emit_drink)  { acc.emit_drink = true;  acc.drink_ml = o.drink_ml; }
        if (o.emit_refill) { acc.emit_refill = true; acc.refill_ml = o.refill_ml; }
        if (o.emit_off_base) acc.emit_off_base = true;
        if (o.emit_low_battery) acc.emit_low_battery = true;
        acc.state = o.state;       // 末帧状态
        acc.present = o.present;
        acc.stable = o.stable;
        acc.weight_g = o.weight_g;
        *t += 100;
    }
    return acc;
}

static void test_present_and_stable(void) {
    printf("[present / stable 窗口]\n");
    base_weight_t st; base_weight_init(&st);
    uint32_t t = 1000;
    // 空座
    base_weight_out_t o = base_weight_step(&st, 0.0f, 80, t);
    ok(!o.present, "空座 present=false");
    ok(o.state == BASE_OFF, "空座 state=OFF");
    t += 100;
    // 放上杯子 —— 重量 500g
    o = base_weight_step(&st, 500.0f, 80, t);
    ok(o.present, "放上 present=true");
    ok(o.state == BASE_SETTLING, "刚放上 state=SETTLING");
    ok(!o.stable, "刚放上 stable=false");
    t += 100;
    o = settle_at(&st, 500.0f, &t);
    ok(o.state == BASE_RESTING, "恒重够久 → RESTING");
    ok(o.stable, "RESTING 时 stable=true");
    ok(!o.emit_drink && !o.emit_refill, "首次稳定不发 drink/refill(建立基准)");
}

static void test_drink_refill(void) {
    printf("[drink / refill:ΔW 超 30g]\n");
    base_weight_t st; base_weight_init(&st);
    uint32_t t = 1000;
    settle_at(&st, TARE + 300.0f, &t);       // 建立基准:300ml

    // 喝掉 100ml → 重量降 100g(>30)
    base_weight_out_t o = settle_at(&st, TARE + 200.0f, &t);
    ok(o.emit_drink, "降 100g → drink");
    ok(fabsf(o.drink_ml - 100.0f) < 0.5f, "drink 量≈100ml");

    // 续水 150ml → 重量升 150g(>30)
    o = settle_at(&st, TARE + 350.0f, &t);
    ok(o.emit_refill, "升 150g → refill");
    ok(fabsf(o.refill_ml - 150.0f) < 0.5f, "refill 量≈150ml");

    // 只变化 10g(<30 阈值)→ 无事件
    o = settle_at(&st, TARE + 360.0f, &t);
    ok(!o.emit_drink && !o.emit_refill, "Δ10g 未越阈值,无事件");
}

/**
 * 钉死一个易误读的边界:"首次稳定不发事件"只抑制**开机那一次**(prev==0),
 * 不是"第一次 refill 不报"。空杯先稳定(建基准 285g)→ 拿起 → 斟满 → 放回稳定,
 * 该发 refill(ΔW=+480)。
 */
static void test_empty_then_fill(void) {
    printf("[空杯首稳定不发 → 斟满放回发 refill]\n");
    base_weight_t st; base_weight_init(&st);
    uint32_t t = 1000;
    base_weight_out_t o = settle_at(&st, TARE, &t);           // 空杯(皮重)首稳定
    ok(!o.emit_drink && !o.emit_refill, "空杯首稳定只建基准,不发事件");
    base_weight_step(&st, 0.0f, 80, t);                       // 拿起
    uint32_t t2 = t + 1000;
    o = settle_at(&st, TARE + 480.0f, &t2);                   // 斟满 480ml 放回
    ok(o.emit_refill, "空杯→斟满放回 → refill(首次稳定抑制 ≠ 首次 refill 不报)");
    ok(fabsf(o.refill_ml - 480.0f) < 0.5f, "refill 量≈480ml");
}

static void test_off_base_delay(void) {
    printf("[off_base:离座超 120s 才发]\n");
    base_weight_t st; base_weight_init(&st);
    uint32_t t = 1000;
    settle_at(&st, TARE + 200.0f, &t);

    // 拿起(重量骤降为 0)
    base_weight_out_t o = base_weight_step(&st, 0.0f, 80, t);
    ok(!o.emit_off_base, "刚拿起不发 off_base");
    // 119.9s 后仍不发
    o = base_weight_step(&st, 0.0f, 80, t + 119900);
    ok(!o.emit_off_base, "离座 119.9s 仍不发");
    // 120s 后发一次
    o = base_weight_step(&st, 0.0f, 80, t + 120000);
    ok(o.emit_off_base, "离座满 120s 发 off_base");
    // 持续离座不重复发
    o = base_weight_step(&st, 0.0f, 80, t + 300000);
    ok(!o.emit_off_base, "持续离座不重复发");
}

static void test_brief_lift_no_off_base(void) {
    printf("[短暂拿起(喝一口)不算带走]\n");
    base_weight_t st; base_weight_init(&st);
    uint32_t t = 1000;
    settle_at(&st, TARE + 200.0f, &t);
    base_weight_step(&st, 0.0f, 80, t);          // 拿起
    base_weight_step(&st, 0.0f, 80, t + 30000);  // 30s
    base_weight_out_t o = base_weight_step(&st, TARE + 150.0f, 80, t + 60000);  // 放回(少了 50ml)
    ok(!o.emit_off_base, "60s 内放回,不发 off_base");
    // 放回后重新稳定应能判出 drink(50ml)
    uint32_t t2 = t + 60100;
    o = settle_at(&st, TARE + 150.0f, &t2);
    ok(o.emit_drink, "放回后稳定判出 drink(50ml)");
    ok(fabsf(o.drink_ml - 50.0f) < 0.5f, "drink 量≈50ml");
}

static void test_battery_hysteresis(void) {
    printf("[低电量 <=15 报 / >=20 复位]\n");
    base_weight_t st; base_weight_init(&st);
    ok(!base_weight_step(&st, 0.0f, 16, 0).emit_low_battery, "16% 不报");
    ok(base_weight_step(&st, 0.0f, 15, 100).emit_low_battery, "15% 报低电");
    ok(!base_weight_step(&st, 0.0f, 18, 200).emit_low_battery, "18% 不重复");
    base_weight_step(&st, 0.0f, 20, 300);  // 复位
    ok(base_weight_step(&st, 0.0f, 15, 400).emit_low_battery, "复位后再低能重报");
}

static void test_window_std(void) {
    printf("[窗口标准差]\n");
    float flat[4] = {500, 500, 500, 500};
    ok(base_window_std(flat, 4) < 1e-4f, "恒值标准差≈0");
    float vary[4] = {500, 510, 490, 500};
    ok(base_window_std(vary, 4) > SCALE_SETTLE_STD_G, "振荡标准差超阈值");
    ok(base_window_std(flat, 1) == 0.0f, "单样本(不足)→ 0");
}

int main(void) {
    printf("== base_weight 宿主单测 ==\n");
    test_window_std();
    test_present_and_stable();
    test_drink_refill();
    test_empty_then_fill();
    test_off_base_delay();
    test_brief_lift_no_off_base();
    test_battery_hysteresis();
    printf("\n== %d/%d 通过,%d 失败 ==\n", g_total - g_fail, g_total, g_fail);
    return g_fail == 0 ? 0 : 1;
}
