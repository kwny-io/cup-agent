/**
 * MQTT 实现(esp-mqtt)。只做"连/订/发/收",业务判定交给上层。
 */
#include "mqtt_uplink.h"

#include <stdio.h>
#include <string.h>
#include <time.h>

#include "command_parse.h"
#include "esp_event.h"
#include "esp_log.h"
#include "mqtt_client.h"
#include "sdkconfig.h"
#include "uplink_buffer.h"

static const char *TAG = "mqtt";

static esp_mqtt_client_handle_t s_client;
static volatile bool s_connected = false;
static cmd_handler_t s_on_cmd;
static cmd_dedup_t s_dedup;
static char s_up_topic[64];
static char s_down_topic[64];
/** 未连 broker 时暂存的信封;连上后按序补发(见 uplink_buffer)。 */
static uplink_buffer_t s_pending;

/** uplink_buffer_drain 的发送适配器:签名对上 esp-mqtt 直发路径。 */
static bool drain_send(const char *payload, void *ctx) {
    (void)ctx;
    if (!s_client || !s_connected) return false;
    int len = (int)strlen(payload);
    return esp_mqtt_client_publish(s_client, s_up_topic, payload, len, 1, 0) >= 0;
}

static void on_mqtt_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg; (void)base;
    esp_mqtt_event_handle_t ev = (esp_mqtt_event_handle_t)data;
    switch ((esp_mqtt_event_id_t)id) {
        case MQTT_EVENT_CONNECTED:
            s_connected = true;
            ESP_LOGI(TAG, "已连接 broker");
            // 1) 先订自己的下行 topic
            esp_mqtt_client_subscribe(s_client, s_down_topic, 1);
            // 2) 再发 hello 握手(镜像模拟器出口;后端在 schema 校验前放行)
            esp_mqtt_client_publish(s_client, s_up_topic, "{\"kind\":\"hello\",\"v\":1}", 0, 1, 0);
            ESP_LOGI(TAG, "已订阅 %s 并握手", s_down_topic);
            // 3) 补发断网期间暂存的上行(按入队顺序;失败则留到下次)
            {
                int n = uplink_buffer_drain(&s_pending, drain_send, NULL);
                if (n > 0) {
                    ESP_LOGI(TAG, "重连后补发暂存上行 %d 条(剩 %d)", n,
                             uplink_buffer_count(&s_pending));
                }
                if (uplink_buffer_dropped(&s_pending) > 0) {
                    ESP_LOGW(TAG, "上行缓存曾溢出丢弃 %u 条",
                             (unsigned)uplink_buffer_dropped(&s_pending));
                }
            }
            break;

        case MQTT_EVENT_DISCONNECTED:
            s_connected = false;
            ESP_LOGW(TAG, "与 broker 断开");
            break;

        case MQTT_EVENT_DATA: {
            // 下行必须是我们的 down topic;否则忽略
            if (ev->topic_len != (int)strlen(s_down_topic) ||
                strncmp(ev->topic, s_down_topic, (size_t)ev->topic_len) != 0) {
                ESP_LOGW(TAG, "未知 topic,忽略:%.*s", ev->topic_len, ev->topic);
                break;
            }
            // 拼成以 NUL 结尾的副本(esp-mqtt 给的不是 C 串)
            static char buf[1024];
            int n = ev->data_len < (int)sizeof(buf) - 1 ? ev->data_len : (int)sizeof(buf) - 1;
            memcpy(buf, ev->data, (size_t)n);
            buf[n] = '\0';

            cmd_t cmds[8];
            // expires_at 是 Unix ms。时钟 sane(SNTP 对时后)才做过期判断;对时前传 now_ms=0
            // (约定与两个 main 的 now_unix_ms 一致:1600000000 = 2020-09-13)不误杀指令。
            time_t sec = time(NULL);
            uint64_t now_ms = (sec > 1600000000) ? (uint64_t)sec * 1000ULL : 0;
            int cnt = cmd_parse_payload(buf, CONFIG_CUP_DEVICE_ID, now_ms, &s_dedup, cmds, 8);
            if (cnt < 0) {
                ESP_LOGW(TAG, "下行非数组,忽略:%.*s", n, buf);
                break;
            }
            ESP_LOGI(TAG, "收到下行 %d 条可执行指令", cnt);
            for (int i = 0; i < cnt; i++) {
                ESP_LOGI(TAG, "  cmd %s type=%s expires_at=%llu", cmds[i].cmd_id,
                         cmd_type_str(cmds[i].type), (unsigned long long)cmds[i].expires_at);
                if (s_on_cmd) s_on_cmd(buf, cmds[i].cmd_id, (int)cmds[i].type, cmds[i].expires_at);
            }
            break;
        }

        case MQTT_EVENT_ERROR:
            ESP_LOGE(TAG, "MQTT 错误");
            break;

        default:
            break;
    }
}

bool mqtt_uplink_start(cmd_handler_t on_cmd) {
    s_on_cmd = on_cmd;
    cmd_dedup_init(&s_dedup);
    uplink_buffer_init(&s_pending);
    snprintf(s_up_topic, sizeof(s_up_topic), "dev/%s/up", CONFIG_CUP_DEVICE_ID);
    snprintf(s_down_topic, sizeof(s_down_topic), "dev/%s/down", CONFIG_CUP_DEVICE_ID);

    esp_mqtt_client_config_t cfg = {0};
    cfg.broker.address.uri = CONFIG_CUP_MQTT_URI;
    cfg.credentials.client_id = CONFIG_CUP_DEVICE_ID;
    cfg.session.keepalive = 30;
    cfg.network.reconnect_timeout_ms = 2000;

    s_client = esp_mqtt_client_init(&cfg);
    if (!s_client) {
        ESP_LOGE(TAG, "esp_mqtt_client_init 失败");
        return false;
    }
    esp_mqtt_client_register_event(s_client, ESP_EVENT_ANY_ID, on_mqtt_event, NULL);
    esp_mqtt_client_start(s_client);
    ESP_LOGI(TAG, "连接 %s (client_id=%s)", CONFIG_CUP_MQTT_URI, CONFIG_CUP_DEVICE_ID);
    return true;
}

void mqtt_uplink_stop(void) {
    if (s_client) {
        esp_mqtt_client_stop(s_client);
        esp_mqtt_client_destroy(s_client);
        s_client = NULL;
    }
    s_connected = false;
}

bool mqtt_uplink_connected(void) { return s_connected; }

int mqtt_uplink_pending(void) { return uplink_buffer_count(&s_pending); }

bool mqtt_uplink_publish(const char *payload) {
    if (!payload) return false;
    // 未连 broker → 暂存,连上后补发(不再直接丢帧,断网不再留数据空洞)。
    if (!s_client || !s_connected) {
        bool kept = uplink_buffer_push(&s_pending, payload);
        ESP_LOGW(TAG, "未连 broker,暂存上行(队列 %d%s)", uplink_buffer_count(&s_pending),
                 kept ? "" : ",溢出丢最旧");
        return false;
    }
    int len = (int)strlen(payload);
    int mid = esp_mqtt_client_publish(s_client, s_up_topic, payload, len, 1, 0);  // QoS1, retain0
    if (mid < 0) {
        ESP_LOGW(TAG, "publish 失败,暂存");
        uplink_buffer_push(&s_pending, payload);
        return false;
    }
    return true;
}
