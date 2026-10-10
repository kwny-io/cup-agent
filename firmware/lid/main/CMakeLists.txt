# 杯盖主组件 —— 只放**杯盖特有**的源;设备无关的契约/通信在共享组件 cup_common。
#
#   lid_logic.c      端侧判定(纯 C,零 IDF —— 见 host_test)
#   level_filter.c   ToF 液位 α-β 滤波(纯 C,零 IDF)
#   realtime.c       实时档决策(纯 C,零 IDF)
#   sensor_source.c  传感源(合成默认;纯 C)
#   sensor_convert.c 芯片字节→物理量换算(纯 C,零 IDF —— 真板到货后接"读字节"半截)
#   lid_main.c       app_main + 主循环(ESP-IDF)
idf_component_register(
    SRCS
        "lid_logic.c"
        "level_filter.c"
        "realtime.c"
        "sensor_source.c"
        "sensor_convert.c"
        "lid_main.c"
    INCLUDE_DIRS "."
    REQUIRES
        cup_common
)
