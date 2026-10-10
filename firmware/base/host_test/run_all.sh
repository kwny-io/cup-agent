#!/usr/bin/env bash
# 底座宿主单测入口 —— 只是转发到统一总入口(lid/host_test/run_all.sh)。
# 为什么只有一个总入口:契约层与下行解析在**共享组件** cup_common,盖与底座跑的是同一份,
# 拆成两个 runner 反而容易漏跑。这里留个转发,方便 `bash base/host_test/run_all.sh` 单跑底座时
# 路径直觉一致。
#
# 跑法:
#   bash base/host_test/run_all.sh
#   CC=/c/mingw64/mingw64/bin/gcc.exe bash base/host_test/run_all.sh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
exec bash "$HERE/../../lid/host_test/run_all.sh"
