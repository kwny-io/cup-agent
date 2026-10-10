/**
 * 下行指令生效值裁定实现。见 cmd_exec.h 的分工说明。
 */
#include "cmd_exec.h"

int cmd_exec_clamp_report_ms(int64_t raw) {
    if (raw <= 0) return 0;                       // 非法 → 调用方保持原值
    if (raw < CMD_REPORT_MS_MIN) return CMD_REPORT_MS_MIN;
    if (raw > CMD_REPORT_MS_MAX) return CMD_REPORT_MS_MAX;
    return (int)raw;
}
