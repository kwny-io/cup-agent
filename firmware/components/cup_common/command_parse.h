/**
 * 下行指令解析(纯 C,零 IDF/零 esp-mqtt 依赖)—— 可宿主单测。
 *
 * 契约(§5 下行):后端把给某设备的指令打包成 **JSON 数组** `Command[]` 发到
 * `dev/<device_id>/down`。真后端只会发合法 Command,但固件仍要**防御式**解析:
 *   - 只挑 `target == 本机 device_id` 的(下游可能混入别的设备?)
 *   - `type` 未知 → 记一条 + 跳过
 *   - `expires_at < 现在` → 跳过(过期指令不执行,契约要求设备 honor expires_at)
 *   - **cmd_id 去重**:同一 cmd_id 只执行一次(MQTT QoS1 可能重投)
 *
 * 抽出来的理由:这层判断最容易出错(QoS1 重投 + 过期 + 广播),放宿主单测里跑透,
 * 真板上的行为与此逐字一致。JSON 解析用手写的极小 tokenizer —— 只认本契约的
 * 扁平形状(顶层数组 + 对象 + 字符串/数字),不引 cJSON(与 contract 层同立场)。
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** 去重表容量:记住最近 N 个 cmd_id,按 (device_id 无关,本设备维度即可)。 */
#define CMD_DEDUP_SLOTS 16

typedef enum {
    CMD_TYPE_UNKNOWN = 0,
    CMD_TYPE_REMIND,
    CMD_TYPE_CONFIG,
    CMD_TYPE_OTA,
    CMD_TYPE_SYNC_TIME,
} cmd_type_t;

/** 一条通过校验、可执行的指令。 */
typedef struct {
    char cmd_id[40];
    cmd_type_t type;
    uint64_t expires_at;  // Unix ms;0 视为"永不过期"
} cmd_t;

/** 解析器状态:仅持有 cmd_id 去重环。 */
typedef struct {
    char seen[CMD_DEDUP_SLOTS][40];
    int seen_count;   // 已占用的槽数(<= SLOTS)
    int seen_head;    // 下一个覆盖位置
} cmd_dedup_t;

void cmd_dedup_init(cmd_dedup_t *d);

/** 该 cmd_id 是否见过;没见过则登记并返回 false(调用方据此决定要不要执行)。 */
bool cmd_dedup_seen(cmd_dedup_t *d, const char *cmd_id);

const char *cmd_type_str(cmd_type_t t);

/**
 * 解析一段下行 payload(JSON 数组文本),挑出**本机应执行**的指令。
 *
 * @param json         下行原文(可含 '\n';本函数只处理单行扁平数组)
 * @param device_id    本机 device_id(形如 lid-XXXXXX);用于 target 过滤
 * @param now_ms       当前 Unix 毫秒;用于 expires_at 过期判断
 * @param dedup        去重状态(可 NULL → 不去重)
 * @param out          输出数组
 * @param out_cap      out 容量
 * @return 写入 out 的指令条数(-1 表示 json 非法)
 */
int cmd_parse_payload(const char *json, const char *device_id, uint64_t now_ms,
                      cmd_dedup_t *dedup, cmd_t *out, int out_cap);

#ifdef __cplusplus
}
#endif
