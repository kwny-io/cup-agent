/**
 * 下行指令 payload 取值(纯 C,零 IDF 依赖)—— 可宿主单测。
 *
 * 为什么单独一个模块:`command_parse` 只挑出"该不该执行"的指令(cmd_id/type/expires),
 * **刻意不解析 payload**(把它当不透明对象整体跳过,见 command_parse.c 的 skip_value)。
 * 但真执行时要拿到 payload 里的字段(config.report_ms / sync_time.server_ts)。
 *
 * 契约 §5 给了每种 type 的 payload 形状示例(config → {"report_ms":60000}、
 * sync_time → {"server_ts":0}),但 zod 把 payload 定义为自由记录(record<string,unknown>),
 * **不强制内容**。故这里按文档形状取整数字段:取不到就返回 false(调用方保持原值,不乱猜)。
 *
 * 复用 command_parse.c 的同一立场:手写极小 JSON 扫描,只认契约的扁平形状,不引 cJSON。
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * 在下行数组原文里,按 cmd_id 精确定位那条指令对象,取其 `payload.<key>` 的整数值。
 *
 * @param json      下行数组原文(与喂给 cmd_parse_payload 的是同一段)
 * @param cmd_id    目标指令 id(精确匹配;非空)
 * @param key       payload 里的字段名,如 "server_ts" / "report_ms"
 * @param out       命中时写入(可为负;server_ts 是 13 位 Unix ms,故用 int64_t)
 * @return true = 找到该 cmd_id 且 payload.<key> 存在且是整数;false = 任一环节没命中
 */
bool cmd_payload_i64(const char *json, const char *cmd_id, const char *key, int64_t *out);

/**
 * 同上,但取**字符串**值(如 remind 的 `text`)。转义(\\n \\t \\" 等)会解开。
 *
 * @param out 输出缓冲;命中时写入并以 NUL 结尾(超长截断)
 * @param cap out 容量(含结尾 NUL)
 * @return true = 找到该 cmd_id 且 payload.<key> 是字符串;false = 未命中或值非字符串
 */
bool cmd_payload_str(const char *json, const char *cmd_id, const char *key, char *out,
                     size_t cap);

#ifdef __cplusplus
}
#endif
