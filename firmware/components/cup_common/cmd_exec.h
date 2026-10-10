/**
 * 下行指令的**生效值**裁定(纯 C,零 IDF 依赖)—— 可宿主单测。
 *
 * 分工:cmd_payload 负责"从原文里取到整数",本模块负责"这个整数能不能用、用哪个值"。
 * 把合法性/夹紧单独抽出来,是因为边界(过密上报、把上报停掉)最容易写错,而它零依赖、
 * 可在 PC 上钉死。
 */
#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** 上报间隔下限。防后端(或被篡改的指令)下发过密上报 → 打爆链路/电量。 */
#define CMD_REPORT_MS_MIN 5000
/** 上报间隔上限(1h)。防把上报几乎停掉。 */
#define CMD_REPORT_MS_MAX 3600000

/**
 * 裁定 config.report_ms 的生效值。
 * @param raw 从 payload 取到的原始值
 * @return >0:夹紧到 [CMD_REPORT_MS_MIN, CMD_REPORT_MS_MAX] 后的值;
 *         0 :非法(raw<=0)→ 调用方**保持原值**,不应用。
 */
int cmd_exec_clamp_report_ms(int64_t raw);

#ifdef __cplusplus
}
#endif
