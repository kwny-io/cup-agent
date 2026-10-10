/**
 * 称重源实现。
 *
 * 合成源(weight_synth_read)是纯函数、零依赖:裸板 bring-up、宿主单测、温补演示共用。
 * 它模拟一个**真实的称重单元**,因此刻意带上两样东西,好让上层(weight_comp / base_weight)
 * 有真正的活儿可干:
 *
 *   1. **温漂**:raw = 真值 + K_CELL·(T − T_REF)。K_CELL/T_REF 是单元的*真实*系数,
 *      固件**不知道**(正是 weight_comp 要自标定的对象)。
 *   2. **慢场景**:温度 25→50℃ 慢正弦(周期 30min);每 5min 一次"拿起 20s 再放回同重量" ——
 *      20s < off_base 延迟 120s 故不误报 off_base,ΔW=0 故不误报 drink/refill,但给 weight_comp
 *      提供了**不同温度下的干净空座锚点**,于是裸板也能演示 M6 验收 #2(温补)。
 *
 * 这样"轨迹很真"而不是"制造事件":事件仍由 base_weight 从补偿后的重量推。
 */
#include "weight_source.h"

#include <math.h>
#include <string.h>

// ── 合成源(默认;裸板无称重传感器时用它把链路先跑通)──────────────

/** 单元真实温漂系数(g/℃)与参考温度(℃)—— 固件不知道,靠 weight_comp 自标定。 */
#define CELL_K_G_PER_C 0.5f
#define CELL_T_REF_C 25.0f
/** 场景参数:皮重+水、拿起窗口、周期、温度周期。 */
#define SYNTH_TARE_G 285.0f
#define SYNTH_WATER_G 200.0f
#define SYNTH_PERIOD_MS 300000u    // 5min
#define SYNTH_AIR_MS 20000u        // 每周期前 20s:杯子被拿起(给温补喂空座锚点)
#define SYNTH_TEMP_PERIOD_MS 1800000u  // 30min 温度周期

/**
 * 单元特性:真值 + 温漂 + 噪声 → 原始读数。weight_synth_read 与宿主单测共用这一份,
 * 保证"测试里跑的单元"与"裸板上跑的单元"是同一个模型(测试自编场景,但系数/噪声不另写)。
 */
float weight_synth_unit_raw(float true_w_g, float temp_c, uint32_t now_ms) {
    float t_s = (float)now_ms / 1000.0f;
    // 噪声:两个不同频正弦叠加,峰峰 ~1.6g、std ~0.57g(< settle_std_g 1.5)
    float noise = 0.4f * sinf(t_s * 37.0f) + 0.4f * sinf(t_s * 23.3f);
    // 温漂:单元零点随温度上移
    float drift = CELL_K_G_PER_C * (temp_c - CELL_T_REF_C);
    float raw = true_w_g + drift + noise;
    return raw < 0.0f ? 0.0f : raw;
}

/**
 * 生成一帧缓慢变化的合成读数。波形由 now_ms 驱动 → 确定性、可复现:
 *   - 温度:25..50℃ 慢正弦(周期 30min)
 *   - 重量:在座 485g(皮重+200ml)/ 空座 0g,叠加 ±0.8g 噪声,再叠加剧温漂
 */
void weight_synth_read(weight_sample_t *out, uint32_t now_ms) {
    if (!out) return;
    memset(out, 0, sizeof(*out));

    float t_s = (float)now_ms / 1000.0f;

    // 温度:37.5 + 12.5·sin(...-π/2),t=0 时为 25℃,范围 [25,50]
    float temp = 37.5f + 12.5f * sinf(6.2831853f * t_s / 1800.0f - 1.5707963f);

    // 场景:每周期前 20s 杯子被拿起
    bool air = (now_ms % SYNTH_PERIOD_MS) < SYNTH_AIR_MS;
    float true_w = air ? 0.0f : (SYNTH_TARE_G + SYNTH_WATER_G);

    out->has_weight = true;
    out->weight_g = weight_synth_unit_raw(true_w, temp, now_ms);

    out->has_temp = true;
    out->temp_c = temp;

    out->has_battery = true;
    int drop = (int)(t_s / 3600.0f);   // 每小时 -1%
    out->battery_pct = 88 - drop;
    if (out->battery_pct < 0) out->battery_pct = 0;
    out->charging = false;
}

// ── 真实驱动(按需打开;未接的传感器 has_* 为 false)──────────────

// 选路:bring-up 阶段默认合成源。接真称重时把对应分支填进 weight_real_*。
#ifndef CUP_WEIGHT_USE_SYNTH
#define CUP_WEIGHT_USE_SYNTH 1
#endif

#if CUP_WEIGHT_USE_SYNTH

void weight_source_init(void) {}
void weight_source_read(weight_sample_t *out, uint32_t now_ms) {
    weight_synth_read(out, now_ms);
}
const char *weight_source_name(void) { return "synthetic"; }

#else
// ── 真称重路径(占位:接上真芯片后在此实现)──────────────────────
// HX711 + 应变片(2 路 DOUT/SCK):has_weight —— 需去皮校准 + 温漂补偿。
//   温漂补偿:本模块只出**原始**读数,补偿交给 weight_comp(自标定两点法,在线学习 K/T_REF);
//   若已知本批应变片系数,也可改为在 weight_comp.h 里固化。架构 §4.3 / 风险 R1。
// DS18B20 / NTC               :has_temp(weight_comp 的输入)
// INA219 (I2C)                :has_battery
//
// 引脚只作**示例**,接线时按自己板子的实际走线定,再改这里:
//   HX711  DOUT=GPIO5  SCK=GPIO6 (电源 3V3,应变片桥接 E+/E-/A+/A-)
//   NTC/DS18B20 温度输入见文档
// 注意:每个传感器独立可选 —— 没接的把对应 has_* 留 false,主循环照常上报其余字段。
#error "真称重路径尚未实现;先用合成源(CUP_WEIGHT_USE_SYNTH=1)把链路跑通。"
#endif
