/**
 * 宿主侧单测 —— 契约对齐层(contract_dev.c)。
 *
 * 为什么能在 PC 上跑:这一层**零 IDF 依赖**(只用 stdio/stdarg),故用宿主编译器
 * (gcc/clang)即可编译运行,不必等真板。真板上的端侧判定(F2)同理、也走这条路。
 *
 * 断言用的是"序列化结果里必须出现某个子串",因为这里要验的正是**契约字段名一字不差** ——
 * 后端 zod 就是按名字收的。若要更强的结构校验,可在下游接一个 JSON 解析器,
 * 但 bring-up 阶段字符串级足够,且零依赖。
 *
 * 跑法:见 lid/host_test/run_all.sh(契约层在共享组件 cup_common,故从 firmware/ 根编译)。
 *   gcc -Wall -Wextra -std=c11 -Icomponents/cup_common -Ilid/main \
 *       components/cup_common/contract_dev.c lid/host_test/test_contract_dev.c -o t && ./t
 */
#include "contract_dev.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

static int g_fail = 0;
static int g_total = 0;

static void ok(int cond, const char *what) {
    g_total++;
    if (!cond) {
        g_fail++;
        printf("  ✗ %s\n", what);
    } else {
        printf("  ✓ %s\n", what);
    }
}

static int has(const char *hay, const char *needle) {
    return strstr(hay, needle) != NULL;
}

static void test_enum_strings(void) {
    printf("[契约枚举字符串]\n");
    ok(strcmp(motion_state_str(MOTION_IDLE), "idle") == 0, "motion idle");
    ok(strcmp(motion_state_str(MOTION_TILT), "tilt") == 0, "motion tilt");
    ok(strcmp(motion_state_str(MOTION_SHAKE), "shake") == 0, "motion shake");
    ok(strcmp(motion_state_str(MOTION_LIFTED), "lifted") == 0, "motion lifted");
    ok(strcmp(event_type_str(EVENT_DRINK), "drink") == 0, "event drink");
    ok(strcmp(event_type_str(EVENT_TEMP_ALERT), "temp_alert") == 0, "event temp_alert");
    ok(strcmp(event_type_str(EVENT_OFF_BASE), "off_base") == 0, "event off_base");
    ok(strcmp(event_type_str(EVENT_TAP), "tap") == 0, "event tap(手势加法)");
    ok(strcmp(event_type_str(EVENT_LONG_PRESS), "long_press") == 0, "event long_press(手势加法)");
    ok(strcmp(derived_by_str(DERIVED_BY_LID), "lid") == 0, "derived_by lid");
    ok(strcmp(derived_by_str(DERIVED_BY_BASE), "base") == 0, "derived_by base");
}

static void test_conversions(void) {
    printf("[换算助手 对齐 constants.ts]\n");
    // 130mm 满杯 = 400ml
    ok(fabsf(ml_to_level_mm(400.0f) - 130.0f) < 0.01f, "400ml -> 130mm");
    ok(ml_to_level_pct(400.0f) == 100, "400ml -> 100%");
    ok(ml_to_level_pct(200.0f) == 50, "200ml -> 50%");
    ok(ml_to_level_mm(-5.0f) == 0.0f, "负量 -> 0mm(夹下界)");
    ok(ml_to_level_mm(9999.0f) == 130.0f, "超量 -> 130mm(夹上界)");
    // 重量:tare 285g,水 1g/ml
    ok(fabsf(volume_ml_from_weight(685.0f) - 400.0f) < 0.01f, "685g -> 400ml 水");
    ok(volume_ml_from_weight(200.0f) == 0.0f, "轻于皮重 -> 0ml(截到 0)");
    ok(level_pct_from_weight(485.0f) == 50, "485g -> 50%");
}

static void test_lid_envelope(void) {
    printf("[lid 遥测信封]\n");
    lid_telemetry_t t = {0};
    t.ts = 1730000000000ull;  // 13 位 Unix 毫秒(2024 年)—— 必须 64 位承载
    t.seq = 42;
    t.sample_ms = 1000;
    t.temp_c = 52.3f;
    t.level_mm = 65.0f;
    t.level_pct = 50;
    t.motion = MOTION_SHAKE;
    t.tilt_deg = 12.0f;
    t.tilt_dir = 90;
    t.battery_pct = 88;
    t.charging = false;
    t.has_imu = true;
    t.imu.ax = 0.02f; t.imu.ay = 0.98f; t.imu.az = 0.01f;
    t.imu.gx = 10.0f; t.imu.gy = -5.0f; t.imu.gz = 0.0f;
    t.rssi = -58;  // sane dBm → 序列化时带上

    char buf[512];
    int n = lid_telemetry_to_envelope(&t, "lid-A1B2C3", "cup-A1B2C3", buf, sizeof(buf));
    ok(n > 0, "序列化成功(n>0)");
    ok(has(buf, "\"kind\":\"lid\""), "kind=lid");
    ok(has(buf, "\"v\":1"), "v=1");
    ok(has(buf, "\"device_id\":\"lid-A1B2C3\""), "device_id 正确");
    ok(has(buf, "\"cup_id\":\"cup-A1B2C3\""), "cup_id 正确");
    ok(has(buf, "\"ts\":1730000000000"), "ts 完整 13 位(64 位不回绕)");
    ok(has(buf, "\"seq\":42"), "seq");
    ok(has(buf, "\"sample_ms\":1000"), "sample_ms");
    ok(has(buf, "\"temp_c\":52.3"), "temp_c 一位小数");
    ok(has(buf, "\"level_pct\":50"), "level_pct");
    ok(has(buf, "\"motion\":\"shake\""), "motion=shake");
    ok(has(buf, "\"tilt_dir\":90"), "tilt_dir");
    ok(has(buf, "\"charging\":false"), "charging=false");
    ok(has(buf, "\"imu\":{\"ax\":0.020"), "imu 出现(实时档)");
    ok(has(buf, "\"rssi\":-58"), "rssi 出现");
    ok(buf[n] == '\0', "n 处是结尾 NUL");
    printf("    payload: %s\n", buf);
}

static void test_lid_no_optional(void) {
    printf("[lid 遥测 · 无 imu/rssi(常规档)]\n");
    lid_telemetry_t t = {0};
    t.sample_ms = 1000;
    t.motion = MOTION_IDLE;
    t.level_pct = 30;
    t.has_imu = false;
    t.rssi = 0;  // 占位默认 → 不合法 dBm,不应序列化
    char buf[512];
    ok(lid_telemetry_to_envelope(&t, "lid-A1B2C3", "cup-A1B2C3", buf, sizeof(buf)) > 0, "序列化成功");
    ok(!has(buf, "imu"), "常规档不带 imu 字段");
    ok(!has(buf, "rssi"), "rssi=0(占位)不带 rssi 字段");
}

static void test_event_envelope(void) {
    printf("[事件信封 · amount_ml 仅 drink/refill]\n");
    char buf[512];
    cup_event_t d = {0};
    d.ts = 1000; d.type = EVENT_DRINK; d.has_amount = true; d.amount_ml = 210.0f;
    d.confidence = 0.95f; d.derived_by = DERIVED_BY_BASE;
    ok(cup_event_to_envelope(&d, "cup-A1B2C3", "base-A1B2C3", buf, sizeof(buf)) > 0, "drink 序列化成功");
    ok(has(buf, "\"kind\":\"event\""), "kind=event");
    ok(has(buf, "\"type\":\"drink\""), "type=drink");
    ok(has(buf, "\"amount_ml\":210.0"), "drink 带 amount_ml");
    ok(has(buf, "\"derived_by\":\"base\""), "derived_by=base");

    // 即使调用方误置 has_amount,temp_alert 也**不得**带 amount_ml(契约 .refine 会拒收)
    cup_event_t a = {0};
    a.ts = 2000; a.type = EVENT_TEMP_ALERT; a.has_amount = true; a.amount_ml = 5.0f;
    a.has_temp = true; a.temp_c = 70.0f; a.confidence = 1.0f; a.derived_by = DERIVED_BY_LID;
    ok(cup_event_to_envelope(&a, "cup-A1B2C3", "lid-A1B2C3", buf, sizeof(buf)) > 0, "temp_alert 序列化成功");
    ok(!has(buf, "amount_ml"), "temp_alert 不带 amount_ml(关键:契约 refine)");
    ok(has(buf, "\"temp_c\":70.0"), "temp_alert 带 temp_c");
}

static void test_gesture_envelope(void) {
    printf("[手势事件 · duration_ms 仅 tap/long_press]\n");
    char buf[512];
    cup_event_t g = {0};
    g.ts = 3000; g.type = EVENT_TAP; g.has_duration = true; g.duration_ms = 120;
    g.confidence = 0.9f; g.derived_by = DERIVED_BY_LID;
    ok(cup_event_to_envelope(&g, "cup-A1B2C3", "lid-A1B2C3", buf, sizeof(buf)) > 0, "tap 序列化成功");
    ok(has(buf, "\"type\":\"tap\""), "type=tap");
    ok(has(buf, "\"duration_ms\":120"), "tap 带 duration_ms");
    ok(!has(buf, "amount_ml"), "tap 不带 amount_ml");

    cup_event_t l = {0};
    l.ts = 4000; l.type = EVENT_LONG_PRESS; l.has_duration = true; l.duration_ms = 900;
    l.confidence = 0.9f; l.derived_by = DERIVED_BY_LID;
    ok(cup_event_to_envelope(&l, "cup-A1B2C3", "lid-A1B2C3", buf, sizeof(buf)) > 0, "long_press 序列化成功");
    ok(has(buf, "\"type\":\"long_press\""), "type=long_press");
    ok(has(buf, "\"duration_ms\":900"), "long_press 带 duration_ms");

    // 即使调用方误置 has_duration 与 has_amount,drink 也**不得**带 duration_ms(契约 .refine 会拒收)
    cup_event_t d = {0};
    d.ts = 5000; d.type = EVENT_DRINK; d.has_amount = true; d.amount_ml = 180.0f;
    d.has_duration = true; d.duration_ms = 50; d.confidence = 0.95f; d.derived_by = DERIVED_BY_BASE;
    ok(cup_event_to_envelope(&d, "cup-A1B2C3", "base-A1B2C3", buf, sizeof(buf)) > 0, "drink 序列化成功");
    ok(has(buf, "\"amount_ml\":180.0"), "drink 带 amount_ml");
    ok(!has(buf, "duration_ms"), "drink 不带 duration_ms(关键:契约 refine)");
}

static void test_base_envelope(void) {
    printf("[base 遥测信封]\n");
    base_telemetry_t b = {0};
    b.ts = 1730000000000ull;
    b.seq = 7;
    b.weight_g = 512.4f;
    b.stable = true;
    b.present = true;
    b.temp_c = 28.6f;
    b.charging = false;
    b.battery_pct = 77;
    char buf[512];
    int n = base_telemetry_to_envelope(&b, "base-A1B2C3", "cup-A1B2C3", buf, sizeof(buf));
    ok(n > 0, "序列化成功");
    ok(has(buf, "\"kind\":\"base\""), "kind=base");
    ok(has(buf, "\"device_id\":\"base-A1B2C3\""), "device_id 正确");
    ok(has(buf, "\"ts\":1730000000000"), "ts 完整 13 位");
    ok(has(buf, "\"seq\":7"), "seq");
    ok(has(buf, "\"weight_g\":512.4"), "weight_g 一位小数");
    ok(has(buf, "\"stable\":true"), "stable=true");
    ok(has(buf, "\"present\":true"), "present=true");
    ok(has(buf, "\"temp_c\":28.6"), "temp_c");
    ok(has(buf, "\"charging\":false"), "charging=false");
    ok(has(buf, "\"battery_pct\":77"), "battery_pct");
    ok(!has(buf, "imu") && !has(buf, "rssi"), "base 无 imu/rssi 字段(schema 就没有)");
    ok(buf[n] == '\0', "n 处是结尾 NUL");
    printf("    payload: %s\n", buf);

    // 越界保险:weight_g 超 2000 应被夹(否则 zod 拒收)
    base_telemetry_t big = {0};
    big.weight_g = 99999.0f;
    base_telemetry_to_envelope(&big, "base-A1B2C3", "cup-A1B2C3", buf, sizeof(buf));
    ok(!has(buf, "99999"), "超上界 weight_g 被夹住");
}

static void test_buffer_guard(void) {
    printf("[缓冲不足 → 报错不越界]\n");
    lid_telemetry_t t = {0};
    t.sample_ms = 1000;
    char small[8];
    int n = lid_telemetry_to_envelope(&t, "lid-A1B2C3", "cup-A1B2C3", small, sizeof(small));
    ok(n < 0, "小缓冲返回 <0");
    printf("    (小缓冲返回 %d)\n", n);
}

int main(void) {
    printf("== contract_dev 宿主单测 ==\n");
    test_enum_strings();
    test_conversions();
    test_lid_envelope();
    test_lid_no_optional();
    test_base_envelope();
    test_event_envelope();
    test_gesture_envelope();
    test_buffer_guard();
    printf("\n== %d/%d 通过,%d 失败 ==\n", g_total - g_fail, g_total, g_fail);
    return g_fail == 0 ? 0 : 1;
}
