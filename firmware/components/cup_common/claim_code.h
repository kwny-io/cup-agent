/**
 * 设备一次性 claim code(可信绑定,纯 C,零 IDF 依赖)—— 可宿主单测。
 *
 * 要解决什么:`POST /social/cup` 过去只校验 cup_id 的**形状**,不验调用者是否真拥有
 * 那台杯 → A 登录后能绑 B 的杯,再用 `DELETE /cups/:id/memory?scope=all` 清掉 B 的数据。
 * 修法:绑定时须出示一枚**设备端生成的一次性码** —— 证明"手上有真设备",自证绑定就堵上了。
 * 该码是第 4 阶段(三档删除)的硬前置:claim code 不落,`scope=all` / 账号级删除不上线。
 *
 * 分工:
 *   · **本模块(纯 C)** = 码的**生成/规范化/校验**逻辑 + 时钟无关的过期判定 —— 全在 PC 上钉死;
 *   · **NVS 薄壳**(claim_store)= 存/取/标记已用,掉电续存;
 *   · **服务端半(窗口 A)** = `POST /social/cup` 收 claim_code 字段并按同一套规则校验。
 *
 * 编码用 **Crockford Base32**(`CUP_CLAIM_ALPHABET`)—— 32 字符(2 的幂,取位无模偏差),
 * 且去掉了读起来像数字的 I/L/O/U;规范化时再把用户手抄的 I/L→1、O→0 映射回去。
 * 定长 8 位。两端(固件 + 服务端)必须逐字一致,故规则全写死在头里。
 *
 * 比对用**常量时间**,防时序侧信道。过期判在**调用方传进来的 now_ms** 上算(本模块不读时钟)
 * —— 故宿主单测可注入时间。
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** 码长(字符数)。 */
#define CUP_CLAIM_LEN 8
/** 存码的缓冲大小(含结尾 NUL);比 LEN 富余,容纳规范化中的中间态。 */
#define CUP_CLAIM_BUF 24
/** 缺省有效期:24 小时。过期即废,重新配网再发。 */
#define CUP_CLAIM_TTL_MS (24ull * 3600ull * 1000ull)
/** Crockford Base32 字母表(恰 32 字符;无 I/L/O/U,索引即编码值)。 */
#define CUP_CLAIM_ALPHABET "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
#define CUP_CLAIM_ALPHABET_LEN 32

/**
 * 由 64 位种子生成一枚码,写进 `out`(至少 CUP_CLAIM_BUF 字节,写成 NUL 结尾的大写 8 串)。
 * seed 由调用方给(设备侧拼两次 esp_random();测试喂定值 → 可复现)。
 * 8 字符 × 5 bit = 40 bit 编码空间,种子经 splitmix64 扩展。
 * @return true = 写入成功。
 */
bool claim_code_generate(uint64_t seed, char *out, size_t out_len);

/**
 * 把输入**规范化**到标准形:丢弃空格/连字符/下划线、转大写、按 Crockford 容错映射
 * (I/i/L/l→1,O/o→0)。手抄必然带空格/大小写/把 0 写成 O,严比对等于把正常用户挡在门外
 * —— 容错全在这一步。
 * @return true = 规范化后**恰为 CUP_CLAIM_LEN 且每个字符都在字母表内**(形状合法);
 *         false = 长度不对或含字母表外字符(必不可能是合法码)。
 */
bool claim_code_normalize(const char *in, char *out, size_t out_len);

/**
 * 常量时间比对两枚**已规范化**的码。长度不等 → false(长度本非秘密)。
 * @return true = 逐字相等。
 */
bool claim_code_equal(const char *a, const char *b);

/**
 * 时效判定:自 issued_at_ms 起算,CUP_CLAIM_TTL_MS 内有效。
 * @param issued_at_ms 码的签发时刻(墙钟毫秒;0 = 未知 → 视为过期,宁缺毋滥)
 * @param now_ms       当前墙钟毫秒
 * @return true = 仍在有效期内。
 */
bool claim_code_fresh(uint64_t issued_at_ms, uint64_t now_ms);

/**
 * 一站式校验:规范化输入 → 恒定时间比对存储码 → 查未过期 → 查未用过。
 * 任一不过即 false。**不改状态**("用过即废"的落地是 NVS 壳 + 服务端的事,见 claim_store)。
 * @return true = 这枚码此刻可用于绑定。
 */
bool claim_code_verify(const char *input, const char *stored_code,
                       uint64_t issued_at_ms, bool used, uint64_t now_ms);

#ifdef __cplusplus
}
#endif
