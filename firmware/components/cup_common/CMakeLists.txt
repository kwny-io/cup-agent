# 共享组件 —— 杯盖与底座共用的**设备无关**代码。
#
#   contract_dev.c   契约对齐(手写 JSON:lid/base/event 信封 + 换算 + 枚举串)
#   command_parse.c  下行指令解析(target 过滤 / 过期 / cmd_id 去重)—— 纯 C
#   cmd_payload.c    下行 payload 取值(按 cmd_id 定位后取整数)—— 纯 C
#   cmd_exec.c       下行生效值裁定(report_ms 夹紧)—— 纯 C
#   cmd_store.c      config 持久化(NVS 薄壳)
#   uplink_buffer.c  上行缓存(断网暂存,有界 FIFO)—— 纯 C
#   led_pattern.c    remind 灯效决策(纯 C,零 IDF)
#   led_driver.c     板载 LED 驱动(LEDC/PWM 薄壳)
#   ota_manifest.c   ota manifest 解析与校验(纯 C,零 IDF;下载/分区归 IDF 半、待真板)
#   celebr.c         成长庆祝(纯 C,零 IDF):remind(reason=milestone)→ 庆祝表情/灯效
#   eye_state.c      硬件脸眼睛状态机(十二态,纯 C,零 IDF;双形体人格的硬件半边)
#   eye_render.c     硬件脸点阵渲染(128×128 单色 + 1bpp 打包,纯 C,零 IDF)
#   claim_code.c     设备一次性 claim code:生成/规范化/校验(纯 C,零 IDF;可信绑定设备端半)
#   claim_store.c    claim code 持久化(NVS 薄壳)
#   wifi_sta.c       Wi-Fi STA
#   mqtt_uplink.c    esp-mqtt 上行/下行
#   prov.c           BLE 配网(wifi_prov_mgr 薄壳,首次拿 Wi-Fi 凭据)
#
# 为什么是组件而不是各拷一份:契约层是"字段名一字不差"的**唯一落点**。两设备各持一份
# 副本必然漂移(改一处忘了另一处),而 zod 会静默拒收 —— 正是本项目最忌的那类 bug。
# 抽成组件后 lid/ 与 base/ 都 REQUIRES cup_common,只有一份契约。
idf_component_register(
    SRCS
        "contract_dev.c"
        "command_parse.c"
        "cmd_payload.c"
        "cmd_exec.c"
        "cmd_store.c"
        "uplink_buffer.c"
        "led_pattern.c"
        "led_driver.c"
        "ota_manifest.c"
        "celebr.c"
        "eye_state.c"
        "eye_render.c"
        "claim_code.c"
        "claim_store.c"
        "wifi_sta.c"
        "mqtt_uplink.c"
        "prov.c"
    INCLUDE_DIRS "."
    REQUIRES
        esp_wifi
        esp_netif
        esp_event
        nvs_flash
        mqtt
        esp_http_client
        wifi_provisioning
        driver
)
