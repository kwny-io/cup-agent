/**
 * claim code 的持久化(NVS 薄壳)—— 掉电续存 + 记"是否已用"。
 *
 * 与 cmd_store 同款纪律:自带**幂等**的 nvs_flash_init(裸板/未配 Wi-Fi 时 wifi_sta
 * 不会初始化 NVS,故这里不能假设它已就绪)。零业务判断 —— 生成/规范化/校验的裁定全在
 * 纯 C 的 claim_code。
 *
 * 首次配网成功后由固件调 `claim_store_ensure(now_ms)` 发一枚码(NVS 里已有且未用则保留,
 * 不重发 —— 否则用户刚抄下就被换掉)。App 读到码 → 拿去 `POST /social/cup` 绑定;
 * 绑定成功后服务端通知设备(下行指令)或设备下次上线查询来置"已用",之后不再接受。
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "claim_code.h"  // CUP_CLAIM_BUF / 码的裁定全在纯 C 层;本头按需透传

#ifdef __cplusplus
extern "C" {
#endif

/** 幂等初始化 NVS。启动时调一次。 */
bool claim_store_init(void);

/**
 * 确保设备上有一枚可用的 claim code:
 *   · NVS 里已有未用的码且未过期 → 原样保留(返回 false)。
 *   · 否则(没有/已用/已过期)→ 用 seed 生成新码 + 记签发时刻 now_ms,落盘(返回 true)。
 * @param seed   随机种子(设备侧拼 esp_random();测试喂定值)
 * @param now_ms 当前墙钟毫秒(作 issued_at)
 * @param out    若非 NULL,输出当前生效的码(NUL 结尾,至少 CUP_CLAIM_BUF 字节)
 * @return true = 本次**新发**了一枚;false = 沿用旧的 / 失败。
 */
bool claim_store_ensure(uint64_t seed, uint64_t now_ms, char *out);

/**
 * 读当前生效的码及其元数据。
 * @param out_code    输出码(NUL 结尾,至少 CUP_CLAIM_BUF 字节)
 * @param out_issued  输出签发时刻;可为 NULL
 * @param out_used    输出是否已用;可为 NULL
 * @return true = NVS 里有码;false = 还没有(未发过)。
 */
bool claim_store_load(char *out_code, uint64_t *out_issued, bool *out_used);

/** 标记当前码已用(一次性:用过即废)。@return true = 写成功。 */
bool claim_store_mark_used(void);

/**
 * 上线便利入口:init NVS + 用 esp_random() 作种子确保有一枚有效码 + 打日志。
 * 两个主循环应在 SNTP 对时**之后**调(issued_at 要真实墙钟,否则服务端一算就过期)。
 * 首次配网成功会新发(串口打出来,用户抄给 App);已有效码则原样沿用,不刷屏。
 * @param now_ms 当前墙钟毫秒(通常取 now_unix_ms())
 */
void claim_bringup(uint64_t now_ms);

#ifdef __cplusplus
}
#endif
