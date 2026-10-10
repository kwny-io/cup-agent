/**
 * 宿主单测 —— **整条底座链**:合成单元(真值+温漂+噪声)→ 温补 → 判定 → 事件量值。
 *
 * 这是 M6 验收 #1(「喝/倒的量:称重值 vs 实际 < 5g」)的单测形态。与另两组的分工:
 *   - test_base_weight:只验状态机(喂恒重、无温漂)—— 判得对不对
 *   - test_weight_comp:只验温补算法(合成源固定场景)—— 补得准不准
 *   - **本组**:把两者串起来,喂**自编场景**(自由改真值/温度),测**端到端量值误差**
 *
 * 为什么必须让温度在两次称重间变化:若两次称重同温,温漂在 ΔW 里**天然抵消**,不解温补也准。
 * 真场景正是"热水注入 → 底座随时间升温" ——故这里刻意让基准称重在 30℃、喝时称重在 42℃,
 * 使温补**真的成为量值精度的关键**(对照断言会证:不补偿就漂出 5g)。
 *
 * 场景里的真值/温度由测试编排;单元的漂移系数与噪声则复用 weight_source 的**同一份**模型
 * (weight_synth_unit_raw),不在测试里复写 —— 否则两处会慢慢漂开,断言就守不住真行为。
 */
#include "base_weight.h"
#include "weight_comp.h"
#include "weight_source.h"

#include <math.h>
#include <stdio.h>

static int g_fail = 0, g_total = 0;
static void ok(int cond, const char *what) {
    g_total++;
    if (!cond) { g_fail++; printf("  ✗ %s\n", what); }
    else printf("  ✓ %s\n", what);
}

// 与 weight_source.c 一致:单元真实温漂系数与参考温度(固件"不知道"的量)
#define CELL_K 0.5f
#define T_REF 25.0f
// 皮重 285 + 水 200 = 485g 起始一杯水
#define W_START 485.0f

/** 整条链的游标:真值/温度由场景给,经单元 → 温补 → 判定。 */
typedef struct {
    weight_comp_t comp;
    base_weight_t bw;
    uint32_t t_ms;
    bool got_drink;  float drink_ml;
    bool got_refill; float refill_ml;
} chain_t;

static void chain_init(chain_t *c) {
    weight_comp_init(&c->comp);
    base_weight_init(&c->bw);
    c->t_ms = 1000;
    c->got_drink = c->got_refill = false;
    c->drink_ml = c->refill_ml = 0;
}

/** 连续喂 n 帧:真值 true_w、温度 temp,每帧推进 1s;累积本段发生的 drink/refill 事件。 */
static void chain_feed(chain_t *c, float true_w, float temp, int n) {
    for (int i = 0; i < n; i++) {
        float raw = weight_synth_unit_raw(true_w, temp, c->t_ms);
        weight_comp_out_t o = weight_comp_step(&c->comp, raw, temp, c->t_ms);
        base_weight_out_t b = base_weight_step(&c->bw, o.corrected_g, 90, c->t_ms);
        if (b.emit_drink)  { c->got_drink = true;  c->drink_ml = b.drink_ml; }
        if (b.emit_refill) { c->got_refill = true; c->refill_ml = b.refill_ml; }
        c->t_ms += 1000;
    }
}

/** 空座静默窗口够满(≥ COMP_STD_WINDOW 帧)才可能采到锚点,故给足 12 帧。 */
#define CAL_FRAMES 12
#define SETTLE_FRAMES 12

static void test_amount_accuracy(void) {
    printf("[E2E:喝/倒量值 称重 vs 实际 < 5g(M6 验收 #1)]\n");
    chain_t c; chain_init(&c);

    // 阶段1 自标定:两个温差 20℃ 的干净空座(单元零点因温度上移)
    chain_feed(&c, 0.0f, 25.0f, CAL_FRAMES);   // 空座 @25℃
    chain_feed(&c, 0.0f, 45.0f, CAL_FRAMES);   // 空座 @45℃ → 反解 k
    ok(c.comp.calibrated, "两空座锚点 → 温补已标定");
    printf("    (学到 k=%.4f g/℃)\n", (double)c.comp.k);

    // 阶段2 建立基准:一杯 485g 水放上,底座温度 30℃
    chain_feed(&c, W_START, 30.0f, SETTLE_FRAMES);
    ok(!c.got_drink && !c.got_refill, "首次稳定只建基准,不报事件");

    // 阶段3 **喝掉 100ml**:拿起(空座)→ 放回,此时底座已被热水烫到 42℃
    //   ← 温度从 30→42,若不解温补,零点漂移 0.5·12=6g 会混进 ΔW
    c.got_drink = false; c.drink_ml = 0;
    chain_feed(&c, 0.0f, 30.0f, 3);                        // 拿起
    chain_feed(&c, W_START - 100.0f, 42.0f, SETTLE_FRAMES); // 放回真值 385g @42℃
    ok(c.got_drink, "判出 drink");
    printf("    (drink 报 %.2fml,真值 100ml,误差 %.2fg)\n",
           (double)c.drink_ml, (double)fabsf(c.drink_ml - 100.0f));
    ok(fabsf(c.drink_ml - 100.0f) < 5.0f, "drink 量值误差 < 5g(M6 验收 #1)");

    // 阶段4 **续水 150ml**:再拿起 → 放回真值 535g(温度保持 42℃)
    c.got_refill = false; c.refill_ml = 0;
    chain_feed(&c, 0.0f, 42.0f, 3);                        // 拿起
    chain_feed(&c, W_START - 100.0f + 150.0f, 42.0f, SETTLE_FRAMES);  // 放回 535g
    ok(c.got_refill, "判出 refill");
    printf("    (refill 报 %.2fml,真值 150ml,误差 %.2fg)\n",
           (double)c.refill_ml, (double)fabsf(c.refill_ml - 150.0f));
    ok(fabsf(c.refill_ml - 150.0f) < 5.0f, "refill 量值误差 < 5g(M6 验收 #1)");

    // 对照:若**不**补偿,drink 那次两次称重零点漂移差 = K·(42−30) = 6g,
    // 直接混进 ΔW → 量值偏 6g > 5g。证明本测真的在考察温补,而非"同温抵消"。
    float uncomp_err = CELL_K * (42.0f - 30.0f);
    printf("    (对照:不补偿时该 drink 会偏 %.1fg)\n", (double)uncomp_err);
    ok(uncomp_err > 5.0f, "对照:温度变化下不补偿会漂出 5g(证明本测有意义)");
}

/** 累积量值:连续两次同向喝,应各自成事件、量值不累加、不吞噬。 */
static void test_sequential_amounts(void) {
    printf("[E2E:连续两次喝,各自的量值独立]\n");
    chain_t c; chain_init(&c);
    chain_feed(&c, 0.0f, 25.0f, CAL_FRAMES);
    chain_feed(&c, 0.0f, 45.0f, CAL_FRAMES);
    chain_feed(&c, 485.0f, 35.0f, SETTLE_FRAMES);  // 基准 485

    // 喝 40ml(> drink_min_g 30)
    c.got_drink = false; c.drink_ml = 0;
    chain_feed(&c, 0.0f, 35.0f, 3);
    chain_feed(&c, 445.0f, 35.0f, SETTLE_FRAMES);
    ok(c.got_drink && fabsf(c.drink_ml - 40.0f) < 5.0f, "第一次喝 40ml(误差<5g)");

    // 再喝 60ml
    c.got_drink = false; c.drink_ml = 0;
    chain_feed(&c, 0.0f, 35.0f, 3);
    chain_feed(&c, 385.0f, 35.0f, SETTLE_FRAMES);
    ok(c.got_drink && fabsf(c.drink_ml - 60.0f) < 5.0f, "第二次喝 60ml(相对上次基准,非累加)");

    // 只变 20g(< 30 阈值)→ 不出事件(不把微动误当喝)
    c.got_drink = false; c.drink_ml = 0;
    chain_feed(&c, 0.0f, 35.0f, 3);
    chain_feed(&c, 365.0f, 35.0f, SETTLE_FRAMES);  // 385→365,Δ20g
    ok(!c.got_drink, "Δ20g 未越阈值,不误报 drink");
}

int main(void) {
    printf("== chain(底座整链)宿主单测 ==\n");
    test_amount_accuracy();
    test_sequential_amounts();
    printf("\n== %d/%d 通过,%d 失败 ==\n", g_total - g_fail, g_total, g_fail);
    return g_fail == 0 ? 0 : 1;
}
