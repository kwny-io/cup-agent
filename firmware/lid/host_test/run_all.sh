#!/usr/bin/env bash
# 宿主单测总入口 —— 在 PC 上把**零 IDF 依赖**的所有模块编译并跑绿。
#
# 为什么这条线重要:固件里最容易错的两类东西 —— 契约字段名/数值区间、下行指令的
# 过滤与去重 —— 全在被抽出的纯 C 层里。它们不依赖 ESP-IDF,于是不必等真板、
# 不必装 toolchain 就能在提交前跑一遍。真板上的逻辑与这些文件**逐字一致**。
#
# 注意:契约层(command_parse / contract_dev)现在在**共享组件** firmware/components/cup_common/,
# 杯盖与底座共用同一份 —— 故这里从仓库根(firmware/)编译,include 路径同时给两处。
#
# 跑法:
#   bash lid/host_test/run_all.sh                 # 用 PATH 里的 cc
#   CC=/c/mingw64/mingw64/bin/gcc.exe bash lid/host_test/run_all.sh
set -u

CC="${CC:-cc}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"   # firmware/
cd "$ROOT" || exit 1

TMP="${TMPDIR:-/tmp}"
INC="-Icomponents/cup_common -Ilid/main -Ibase/main"
fail=0

# 每个单测 = 一组要编译的 .c(源 + 对应 test_*.c)
run_one() {
  local name="$1"; shift
  local out="$TMP/cup_${name}.exe"
  echo "──────── $name ────────"
  if "$CC" -Wall -Wextra -std=c11 $INC "$@" -o "$out" -lm; then
    if "$out"; then :; else fail=1; fi
  else
    echo "编译失败:$name"; fail=1
  fi
  echo
}

run_one contract_dev   components/cup_common/contract_dev.c  lid/host_test/test_contract_dev.c
run_one lid_logic      lid/main/lid_logic.c                  lid/host_test/test_lid_logic.c
run_one command_parse  components/cup_common/command_parse.c lid/host_test/test_command_parse.c
run_one sensor_source  lid/main/sensor_source.c              lid/host_test/test_sensor_source.c
# 杯盖传感器换算(纯 C):芯片字节 → 物理量(BMI160/DS18B20/VL53L0X/INA219 手册算例)
run_one sensor_convert lid/main/sensor_convert.c             lid/host_test/test_sensor_convert.c
run_one base_weight    base/main/base_weight.c               base/host_test/test_base_weight.c
run_one weight_source  base/main/weight_source.c             base/host_test/test_weight_source.c
# 底座称重换算(纯 C):HX711 24 位补码 + 零点/灵敏度 → 克
run_one weight_convert base/main/weight_convert.c            base/host_test/test_weight_convert.c
# 温补单测需 base_weight(复用 base_window_std)+ weight_source(E2E 用合成源带温漂)
run_one weight_comp    base/main/base_weight.c base/main/weight_comp.c base/main/weight_source.c base/host_test/test_weight_comp.c
# 整链单测:单元(温漂+噪声)→ 温补 → 判定 → 量值误差(M6 验收 #1)
run_one chain          base/main/base_weight.c base/main/weight_comp.c base/main/weight_source.c base/host_test/test_chain.c
# 下行指令实际执行(纯 C 两层):payload 取值 + 生效值夹紧
run_one cmd_payload    components/cup_common/cmd_payload.c   lid/host_test/test_cmd_payload.c
run_one cmd_exec       components/cup_common/cmd_exec.c      lid/host_test/test_cmd_exec.c
# ToF 液位 α-β 滤波(纯 C):晃动噪声压制 + 新息门(架构 §4.2 / 风险 R2)
run_one level_filter   lid/main/level_filter.c               lid/host_test/test_level_filter.c
# 实时档决策(纯 C):晃动/请求 → 40Hz 带 imu,保持窗退出(RATE.fast_hz)
run_one realtime       lid/main/realtime.c                   lid/host_test/test_realtime.c
# 上行缓存(纯 C):断网暂存,有界 FIFO 丢最旧,重连按序补发
run_one uplink_buffer  components/cup_common/uplink_buffer.c  lid/host_test/test_uplink_buffer.c
# remind 灯效(纯 C):led 名字串 → 效果序列(单色 LED 只驱动亮/灭),越界钳制 + 未知名回落
run_one led_pattern    components/cup_common/led_pattern.c   lid/host_test/test_led_pattern.c
# 下行 ota 的 manifest 解析与校验(纯 C):url 前缀/长度、sha256 恰 64 hex、size 范围、hex→bytes
run_one ota_manifest   components/cup_common/ota_manifest.c  lid/host_test/test_ota_manifest.c
# 硬件脸 · 眼睛状态机(纯 C,双形体人格的硬件半边):十二态优先级 / 交接闭眼 / 水烫叠加 / 低电慢眨
run_one eye_state      components/cup_common/eye_state.c     lid/host_test/test_eye_state.c
# 硬件脸 · 点阵渲染(纯 C):128×128 单色,瞳孔挖空 / 弧眼 / 蒸汽带 / 1bpp 打包(2048 字节整屏)
run_one eye_render     components/cup_common/eye_render.c    lid/host_test/test_eye_render.c
# 设备一次性 claim code(纯 C,可信绑定设备端半):生成/规范化容错/常量时间比对/时效/一站式校验
run_one claim_code     components/cup_common/claim_code.c    lid/host_test/test_claim_code.c

if [ "$fail" -eq 0 ]; then
  echo "== 全部宿主单测通过 =="
else
  echo "== 有失败,见上 =="
fi
exit "$fail"
