# 底座固件 —— ESP-IDF 工程(ESP32-S3,与杯盖同款主控)。
# 放在仓库顶层 firmware/ 下,故意**不**进 npm workspace(npm 只 glob apps/* 与 packages/*),
# 于是不碰根 package.json / 根 tsconfig / 契约,和软件线目录完全不重叠。
cmake_minimum_required(VERSION 3.16)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(cup_base)
