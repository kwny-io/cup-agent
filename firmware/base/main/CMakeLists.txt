# 底座主组件 —— 只放**底座特有**的源;设备无关的契约/通信在共享组件 cup_common。
#
#   base_weight.c  端侧称重判定(纯 C,零 IDF —— 见 host_test)
#   weight_comp.c  称重温漂补偿:自标定两点法(纯 C)
#   weight_convert.c HX711 24 位字节→克换算(纯 C,零 IDF —— 真板到货后接"读字节"半截)
#   weight_source.c 称重源(合成默认;纯 C)
#   base_main.c     app_main + 主循环(ESP-IDF)
idf_component_register(
    SRCS
        "base_weight.c"
        "weight_comp.c"
        "weight_convert.c"
        "weight_source.c"
        "base_main.c"
    INCLUDE_DIRS "."
    REQUIRES
        cup_common
)
