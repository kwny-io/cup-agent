/**
 * 杯盖/底座 · 下行 `ota` 的 manifest 解析与校验(纯 C,零 IDF 依赖)—— 可宿主单测。
 *
 * 为什么拆出这半:ota 的执行分两半 —— (1)**下载 + esp_https_ota + 分区切换**(需 IDF + 真板);
 * (2)**manifest 的解析与校验**(纯算术,与板无关)。做法同 M9 硬件换算层:先把与板无关、且
 * **最容易和契约对不齐**的那半(字段名、sha256 格式、size 范围)在 PC 上钉死,真板到货后 ota
 * 只剩"下载 + 交给校验"。真板逻辑与这里逐字一致。
 *
 * 契约 §5:`ota` 的 payload = `{ "url": "...", "sha256": "...", "size": 0 }`。
 * zod 把 payload 定义为自由记录(record<string,unknown>),**不强制内容** —— 故校验由固件侧做。
 * 注意契约示例里 `size: 0` 是**占位**(同 `server_ts: 0`);一次**真** ota 必须带**正**的字节数,
 * 故这里 `size <= 0`(含占位的 0)一律拒 —— 无大小的下载无法校验完整性,宁可不做。
 *
 * 立场同 led 未知名"不点亮":**任一字段不满足 → 返回 false,调用方不下载、整齐回落日志**。
 * 复用 cmd_payload.c 的同一立场(按 cmd_id 定位后取值,手写极小 JSON,不引 cJSON)。
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define OTA_URL_MAX 512          /* url 最大字节数(不含结尾 NUL) */
#define OTA_SHA256_HEX 64        /* sha256 十六进制字符数(32 字节 × 2) */
#define OTA_SHA256_BYTES 32      /* sha256 原始字节数 */
#define OTA_SIZE_MAX (4 * 1024 * 1024)  /* 固件包上限 4MB(超过显然不是本设备的镜像) */

/** 校验通过的 ota manifest(字段已规范化:url NUL 结尾、sha256 小写化保留原样)。 */
typedef struct {
    char url[OTA_URL_MAX + 1];         /* NUL 结尾;长度 ∈ [8, OTA_URL_MAX] */
    char sha256[OTA_SHA256_HEX + 1];   /* 恰好 64 个 hex 字符 + NUL(可为大写) */
    int64_t size;                      /* 固件包字节数,∈ (0, OTA_SIZE_MAX] */
} ota_manifest_t;

/**
 * 按 cmd_id 在下行数组原文里定位那条 `ota` 指令,取 payload 的 url/sha256/size 并校验。
 *
 * 校验项(任一不过 → false,不改 *out):
 *   - url:存在、长度 [8, OTA_URL_MAX]、以 `http://` 或 `https://` 开头
 *   - sha256:存在、**恰好 64 个 hex 字符**(0-9a-fA-F)
 *   - size:存在、整数、> 0 且 ≤ OTA_SIZE_MAX
 *
 * @return true = 三字段齐全且全部校验通过,*out 已填充;false = 任一环节没命中/不合法
 */
bool ota_manifest_parse(const char *json, const char *cmd_id, ota_manifest_t *out);

/**
 * 把 64 个 hex 字符的 sha256 解成 32 字节(**给真板做 esp_https_ota 的校验输入**)。
 *
 * @param hex 恰好 64 个 hex 字符(含结尾 NUL 的第 65 个字符)
 * @param out 32 字节输出
 * @return true = 长度恰为 64 且全为 hex;false = 长度不符或含非 hex 字符
 */
bool ota_sha256_to_bytes(const char *hex, uint8_t out[OTA_SHA256_BYTES]);

#ifdef __cplusplus
}
#endif
