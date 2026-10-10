/**
 * 契约对齐层的实现 —— 手写 JSON 序列化 + 换算助手。
 * 字段名/枚举字符串与 `packages/contract/src/schemas.ts` 逐字一致;
 * 改契约时这里必须同步(唯一落点)。
 */
#include "contract_dev.h"

#include <stdarg.h>
#include <stdio.h>

// ── 内部工具 ─────────────────────────────────────────────────────

static float clampf(float x, float lo, float hi) {
    if (x < lo) return lo;
    if (x > hi) return hi;
    return x;
}

static int clampi(int x, int lo, int hi) {
    if (x < lo) return lo;
    if (x > hi) return hi;
    return x;
}

/** 非负浮点四舍五入成整数(用于百分比)。 */
static int round_nonneg(float x) {
    return (int)(x + 0.5f);
}

/**
 * 往 out 追加格式化文本;越界即把 *off 置 -1 并返回 -1(后续追加全部短路)。
 * 用 vsnprintf 一次拿到所需长度,不用自己数。
 */
static int app(char *out, size_t size, int *off, const char *fmt, ...) {
    if (*off < 0) return -1;
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(out + *off, size - (size_t)*off, fmt, ap);
    va_end(ap);
    if (n < 0 || (size_t)(*off + n) >= size) {
        *off = -1;
        return -1;
    }
    *off += n;
    return n;
}

// ── 枚举 → 字符串(必须与契约枚举逐字一致)────────────────────────

const char *motion_state_str(motion_state_t m) {
    switch (m) {
        case MOTION_IDLE: return "idle";
        case MOTION_TILT: return "tilt";
        case MOTION_SHAKE: return "shake";
        case MOTION_LIFTED: return "lifted";
    }
    return "idle";
}

const char *event_type_str(event_type_t t) {
    switch (t) {
        case EVENT_DRINK: return "drink";
        case EVENT_REFILL: return "refill";
        case EVENT_SHAKE: return "shake";
        case EVENT_TEMP_ALERT: return "temp_alert";
        case EVENT_TILT_ALERT: return "tilt_alert";
        case EVENT_LOW_BATTERY: return "low_battery";
        case EVENT_OFF_BASE: return "off_base";
    }
    return "drink";
}

const char *derived_by_str(derived_by_t d) {
    switch (d) {
        case DERIVED_BY_BASE: return "base";
        case DERIVED_BY_LID: return "lid";
        case DERIVED_BY_BACKEND: return "backend";
    }
    return "lid";
}

// ── 换算(镜像 constants.ts)──────────────────────────────────────

float ml_to_level_mm(float ml) {
    return clampf(ml / CUP_ML_PER_MM, 0.0f, (float)CUP_INNER_MM);
}

int ml_to_level_pct(float ml) {
    float pct = (ml / (float)CUP_CAPACITY_ML) * 100.0f;
    return clampi(round_nonneg(pct), 0, 100);
}

float volume_ml_from_weight(float weight_g) {
    float water = weight_g - (float)CUP_TARE_G;
    if (water < 0.0f) water = 0.0f;
    return water / CUP_G_PER_ML;
}

int level_pct_from_weight(float weight_g) {
    return ml_to_level_pct(volume_ml_from_weight(weight_g));
}

// ── 序列化 ───────────────────────────────────────────────────────

int lid_telemetry_to_envelope(const lid_telemetry_t *t, const char *device_id,
                              const char *cup_id, char *out, size_t out_size) {
    if (!t || !device_id || !cup_id || !out || out_size == 0) return -1;

    // 先 clamp,别把越界值发上去被 zod 拒收(schema 上界:level_mm<=999 但实现侧按 130 校)。
    float temp = clampf(t->temp_c, -10.0f, 120.0f);
    float level_mm = clampf(t->level_mm, 0.0f, (float)CUP_INNER_MM);
    int level_pct = clampi(t->level_pct, 0, 100);
    float tilt_deg = clampf(t->tilt_deg, 0.0f, 180.0f);
    int tilt_dir = clampi(t->tilt_dir, 0, 359);
    int batt = clampi(t->battery_pct, 0, 100);

    int off = 0;
    app(out, out_size, &off, "{\"kind\":\"lid\",\"payload\":{\"v\":1");
    app(out, out_size, &off, ",\"device_id\":\"%s\",\"cup_id\":\"%s\"", device_id, cup_id);
    app(out, out_size, &off, ",\"ts\":%llu,\"seq\":%u,\"sample_ms\":%u",
        (unsigned long long)t->ts, (unsigned)t->seq, (unsigned)t->sample_ms);
    app(out, out_size, &off, ",\"temp_c\":%.1f,\"level_mm\":%.2f,\"level_pct\":%d",
        (double)temp, (double)level_mm, level_pct);
    app(out, out_size, &off, ",\"motion\":\"%s\",\"tilt_deg\":%.1f,\"tilt_dir\":%d",
        motion_state_str(t->motion), (double)tilt_deg, tilt_dir);
    app(out, out_size, &off, ",\"battery_pct\":%d,\"charging\":%s", batt,
        t->charging ? "true" : "false");

    if (t->has_imu) {
        app(out, out_size, &off,
            ",\"imu\":{\"ax\":%.3f,\"ay\":%.3f,\"az\":%.3f,\"gx\":%.1f,\"gy\":%.1f,\"gz\":%.1f}",
            (double)t->imu.ax, (double)t->imu.ay, (double)t->imu.az,
            (double)t->imu.gx, (double)t->imu.gy, (double)t->imu.gz);
    }
    // rssi:契约上 rssi 是 int(z.int(),无范围约束),负值 dBm。
    // 真机由通信层填;合成源默认填 0 —— 0 不是合法 dBm(会是 -30~-90),
    // 故只在 sane 负区间才带,免得把占位的 0 当成"强度 0"发出去。
    if (t->rssi < 0 && t->rssi > -140) {
        app(out, out_size, &off, ",\"rssi\":%d", t->rssi);
    }
    app(out, out_size, &off, "}}");

    return off;
}

int base_telemetry_to_envelope(const base_telemetry_t *t, const char *device_id,
                               const char *cup_id, char *out, size_t out_size) {
    if (!t || !device_id || !cup_id || !out || out_size == 0) return -1;

    // 先 clamp:weight_g schema 上界 2000;temp_c [-10,120];battery [0,100]。
    float weight = clampf(t->weight_g, 0.0f, 2000.0f);
    float temp = clampf(t->temp_c, -10.0f, 120.0f);
    int batt = clampi(t->battery_pct, 0, 100);

    int off = 0;
    app(out, out_size, &off, "{\"kind\":\"base\",\"payload\":{\"v\":1");
    app(out, out_size, &off, ",\"device_id\":\"%s\",\"cup_id\":\"%s\"", device_id, cup_id);
    app(out, out_size, &off, ",\"ts\":%llu,\"seq\":%u", (unsigned long long)t->ts,
        (unsigned)t->seq);
    app(out, out_size, &off, ",\"weight_g\":%.1f,\"stable\":%s,\"present\":%s",
        (double)weight, t->stable ? "true" : "false", t->present ? "true" : "false");
    app(out, out_size, &off, ",\"temp_c\":%.1f,\"charging\":%s,\"battery_pct\":%d",
        (double)temp, t->charging ? "true" : "false", batt);
    app(out, out_size, &off, "}}");

    return off;
}

int cup_event_to_envelope(const cup_event_t *e, const char *cup_id,
                          const char *derived_by_device_id, char *out, size_t out_size) {
    if (!e || !cup_id || !derived_by_device_id || !out || out_size == 0) return -1;

    // 契约 .refine:amount_ml 必须且仅在 drink/refill 时携带 —— 这里再兜一道,
    // 免得调用方忘了置 has_amount 也发出非法帧。
    bool allow_amount = (e->type == EVENT_DRINK || e->type == EVENT_REFILL);
    bool emit_amount = allow_amount && e->has_amount;

    int off = 0;
    app(out, out_size, &off, "{\"kind\":\"event\",\"payload\":{\"v\":1");
    app(out, out_size, &off, ",\"cup_id\":\"%s\",\"device_id\":\"%s\"", cup_id,
        derived_by_device_id);
    app(out, out_size, &off, ",\"ts\":%llu,\"type\":\"%s\"", (unsigned long long)e->ts,
        event_type_str(e->type));
    if (emit_amount) {
        float amt = e->amount_ml < 0.0f ? 0.0f : e->amount_ml;
        app(out, out_size, &off, ",\"amount_ml\":%.1f", (double)amt);
    }
    if (e->has_temp) {
        app(out, out_size, &off, ",\"temp_c\":%.1f", (double)e->temp_c);
    }
    app(out, out_size, &off, ",\"confidence\":%.2f,\"derived_by\":\"%s\"",
        (double)clampf(e->confidence, 0.0f, 1.0f), derived_by_str(e->derived_by));
    app(out, out_size, &off, "}}");

    return off;
}
