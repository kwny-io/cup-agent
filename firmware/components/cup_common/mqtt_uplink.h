/**
 * MQTT 上行/下行 —— 与后端 `apps/server/src/ingest/mqtt-adapter.ts` 对接(ADR T17)。
 *
 * topic 契约(与后端逐字一致):
 *   上行: `dev/<device_id>/up`   —— 设备发遥测/事件信封
 *   下行: `dev/<device_id>/down` —— 后端捎回 Command[](JSON 数组)
 *
 * 关键约定(全是单测/联调踩过的点):
 *   1. broker 连上后**先订阅自己的 down topic**,再发 `{kind:"hello"}` 握手
 *      (后端 handleLine 对 hello 在 schema 校验前放行);
 *   2. 上行每条信封**单独一条 publish**,QoS1、retain=false;
 *   3. topic 里的 device_id 必须 == 报文里的 device_id,否则后端拒收;
 *   4. 下行是 JSON **数组**;QoS1 可能重投 → 交给 command_parse 的 cmd_id 去重。
 *
 * 传输是 esp-mqtt(esp_event 风格);薄壳只做"连/订/发/收",业务判定在上层。
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * 收到一条可执行指令时的回调(cmd 已过 target/expires/去重校验)。
 *
 * `raw_json` 是**整条下行数组原文**(以 NUL 结尾,回调期间有效)。为什么传出原文:
 * `cmd_t` 只留 cmd_id/type/expires_at,丢掉了 payload —— 而 config.report_ms /
 * sync_time.server_ts 都住在 payload 里。上层用 `cmd_payload_i64(raw_json, cmd_id, …)`
 * 按 cmd_id 精确定位取值(见 cmd_payload.h)。
 */
typedef void (*cmd_handler_t)(const char *raw_json, const char *cmd_id, int type, uint64_t expires_at);

/**
 * 启动 MQTT(用 menuconfig 的 broker URI / device_id)。
 * **非阻塞**:esp-mqtt 后台自行连接/重连,连上会触发 CONNECTED 事件(那时才订 down + 握手)。
 * 返回 false 仅表示初始化失败(配置/内存),不代表 broker 未连 —— 用 mqtt_uplink_connected() 查。
 */
bool mqtt_uplink_start(cmd_handler_t on_cmd);

/** 断开并释放。 */
void mqtt_uplink_stop(void);

/** 是否已连上 broker(未连时 publish 会被丢弃并记一条)。 */
bool mqtt_uplink_connected(void);

/**
 * 发一条上行报文到 `dev/<device_id>/up`。`payload` 是完整信封 JSON 文本
 * (由 contract_dev 生成)。QoS1、retain=false。
 *
 * 未连 broker 或入队失败时,该帧会被**暂存**到有界上行缓存(见 uplink_buffer),
 * 连上后按序补发 —— 故返回 false 不代表数据丢了,只代表本次未即时发出。
 * @return true 已交给 esp-mqtt;false = 未连接/入队失败(已暂存)。
 */
bool mqtt_uplink_publish(const char *payload);

/** 上行缓存当前暂存条数(未连 broker 期间攒下的)。 */
int mqtt_uplink_pending(void);

#ifdef __cplusplus
}
#endif
