/* MQTT over TLS 客户端（好眠）
 * - WiFi STA 拿到 IP 后自动连接 broker（mqtts，CA 证书校验 + 账号密码）
 * - WiFi 断开则停止 MQTT，重新获 IP 后再次连接
 * - 连接状态经回调上报给 BLE 层（推送到 0xFF04），组件本身不依赖 ble
 */
#include <string.h>
#include <stdio.h>
#include <time.h>

#include "esp_log.h"
#include "esp_event.h"
#include "esp_wifi.h"
#include "esp_netif.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include "esp_system.h"
#include "esp_app_desc.h"
#include "mqtt_client.h"

#include "mqtt_mgr.h"
#include "wifi_mgr.h"
#include "nvs.h"
#include "sdkconfig.h"

static const char *TAG = "mqtt";

/* ===== 连接参数 ===== */
#define MQTT_BROKER_URI     "mqtts://broker.example.invalid:8883"  /* EMQX Cloud Serverless */
#define MQTT_USERNAME       ""
#define MQTT_PASSWORD       ""
#define MQTT_CLIENT_PREFIX  "haomian-"

/* ===== 心跳参数 ===== */
#define MQTT_HB_INTERVAL_S_DEF  30      /* 默认发送间隔 30s */
#define MQTT_HB_INTERVAL_S_MIN  5      /* 最小间隔，防止刷屏 */
#define MQTT_HB_RETRY_DELAY_MS  5000   /* 发送失败重试间隔 */
#define MQTT_HB_RETRY_MAX       3      /* 每拍最多重试次数 */
#define MQTT_HB_TOPIC_FMT_DEF   "testtopic/%s"   /* %s = 设备 MAC（12 位大写） */
#define MQTT_HB_TOPIC_MAX       96
#define MQTT_HB_TPL_MAX         384

static const char *MQTT_HB_TPL_DEF =
    "{\"id\":\"${id}\",\"mac\":\"${mac}\",\"ts\":${ts},\"uptime\":${uptime},"
    "\"fw\":\"${fw}\",\"rssi\":${rssi},\"heap\":${heap},\"status\":\"${status}\"}";

/* 嵌入的 CA 根证书（components/mqtt_mgr/ca.crt，DigiCert Global Root G2）。
 * TEXT 方式嵌入，符号指向以 '\0' 结尾的 PEM 字符串。 */
extern const char  ca_crt_start[] asm("_binary_ca_crt_start");
extern const char  ca_crt_end[]   asm("_binary_ca_crt_end");

static esp_mqtt_client_handle_t s_client   = NULL;
static bool                     s_started  = false;  /* client 已 start（获 IP 后置位） */
static bool                     s_connected = false;
static void (*s_event_cb)(const char *msg) = NULL;
static mqtt_message_cb_t s_message_cb;
static void (*s_ready_cb)(void);
static char s_device_id[65], s_device_key[129], s_device_broker[192];

void mqtt_mgr_set_message_cb(mqtt_message_cb_t callback) { s_message_cb=callback; }
void mqtt_mgr_set_ready_cb(void (*callback)(void)) { s_ready_cb=callback; }
const char *mqtt_mgr_device_id(void) { return s_device_id; }

esp_err_t mqtt_mgr_subscribe(const char *topic) {
    if (!s_client || !s_connected) return ESP_ERR_INVALID_STATE;
    return esp_mqtt_client_subscribe(s_client,topic,1)>=0 ? ESP_OK : ESP_FAIL;
}

#if defined(CONFIG_FELDSPAR_FEATURE_LINK) && CONFIG_FELDSPAR_FEATURE_LINK
static bool load_device_profile(void) {
    nvs_handle_t handle;
    if (nvs_open("device_link",NVS_READONLY,&handle)!=ESP_OK) return false;
    size_t id_size=sizeof(s_device_id), key_size=sizeof(s_device_key), uri_size=sizeof(s_device_broker);
    bool ok=nvs_get_str(handle,"device_id",s_device_id,&id_size)==ESP_OK &&
        nvs_get_str(handle,"device_key",s_device_key,&key_size)==ESP_OK &&
        nvs_get_str(handle,"broker_uri",s_device_broker,&uri_size)==ESP_OK;
    nvs_close(handle);
    if (!ok || !s_device_id[0] || !s_device_key[0] || strncmp(s_device_broker,"mqtts://",8) || strchr(s_device_broker,'@')) goto invalid;
    for (const char *p=s_device_id;*p;++p)
        if (!((*p>='a' && *p<='z') || (*p>='A' && *p<='Z') || (*p>='0' && *p<='9') || *p=='_' || *p=='-')) goto invalid;
    return true;
invalid:
    s_device_id[0]=s_device_key[0]=s_device_broker[0]=0;
    return false;
}
#endif

/* 设备标识（init 时填充）：ClientID 与心跳 JSON 共用 */
static char s_client_id[32] = {0};
static char s_mac_str[16]   = {0};   /* 完整 MAC，12 位大写十六进制 */

/* ---- 心跳状态 ---- */
static char     s_hb_topic_fmt[48] = MQTT_HB_TOPIC_FMT_DEF;
static char     s_hb_tpl[MQTT_HB_TPL_MAX] = {0};
static uint32_t s_hb_interval_s = MQTT_HB_INTERVAL_S_DEF;
static bool     s_hb_enabled = true;             /* 服务自启动：连接后即运行 */
static esp_timer_handle_t s_hb_timer = NULL;     /* 周期拍 */
static esp_timer_handle_t s_hb_retry = NULL;     /* 单次重试拍 */
static uint32_t s_hb_attempts = 0;               /* 当前拍已重试次数 */
static mqtt_mgr_hb_stats_t s_hb_stats;

static void emit(const char *msg)
{
    ESP_LOGI(TAG, "%s", msg);
    if (s_event_cb) s_event_cb(msg);
}

void mqtt_mgr_set_event_cb(void (*cb)(const char *msg))
{
    s_event_cb = cb;
}

bool mqtt_mgr_is_connected(void)
{
    return s_connected;
}

/* ================== 心跳实现 ================== */

/* 当前 WiFi RSSI（未连接/查询失败返回 0） */
static int hb_rssi(void)
{
    wifi_ap_record_t ap;
    if (s_connected && esp_wifi_sta_get_ap_info(&ap) == ESP_OK) return ap.rssi;
    return 0;
}

/* 模板占位符查值；未识别的 key 返回 NULL */
static const char *hb_lookup(const char *key,
                             const char *v_ts, const char *v_up,
                             const char *v_rssi, const char *v_heap)
{
    if (strcmp(key, "id")     == 0) return s_client_id;
    if (strcmp(key, "mac")    == 0) return s_mac_str;
    if (strcmp(key, "ts")     == 0) return v_ts;
    if (strcmp(key, "uptime") == 0) return v_up;
    if (strcmp(key, "fw")     == 0) return esp_app_get_description()->version;
    if (strcmp(key, "rssi")   == 0) return v_rssi;
    if (strcmp(key, "heap")   == 0) return v_heap;
    if (strcmp(key, "status") == 0) return "online";
    return NULL;
}

/* 按模板渲染心跳内容（${key} 替换，未知占位符原样保留） */
static size_t hb_render(char *out, size_t out_size)
{
    char v_ts[20], v_up[20], v_rssi[12], v_heap[12];
    snprintf(v_ts, sizeof(v_ts), "%lld", (long long)time(NULL));      /* Unix 秒，NTP 未同步为 0 */
    snprintf(v_up, sizeof(v_up), "%lld", (long long)(esp_timer_get_time() / 1000000));
    snprintf(v_rssi, sizeof(v_rssi), "%d", hb_rssi());
    snprintf(v_heap, sizeof(v_heap), "%u", (unsigned)esp_get_free_heap_size());

    size_t o = 0;
    const char *p = s_hb_tpl;
    while (*p && o + 1 < out_size) {
        if (p[0] == '$' && p[1] == '{') {
            const char *e = strchr(p + 2, '}');
            if (e && (size_t)(e - (p + 2)) < 16) {
                char key[16];
                size_t kl = (size_t)(e - (p + 2));
                memcpy(key, p + 2, kl);
                key[kl] = 0;
                const char *val = hb_lookup(key, v_ts, v_up, v_rssi, v_heap);
                if (val) {
                    size_t vl = strlen(val);
                    if (o + vl >= out_size) vl = out_size - 1 - o;
                    memcpy(out + o, val, vl);
                    o += vl;
                    p = e + 1;
                    continue;
                }
            }
        }
        out[o++] = *p++;
    }
    out[o] = 0;
    return o;
}

/* 发送一拍（含日志/统计/重试调度） */
static void hb_publish_attempt(void)
{
    char topic[MQTT_HB_TOPIC_MAX];
    char payload[512];

    snprintf(topic, sizeof(topic), s_hb_topic_fmt, s_mac_str);
    hb_render(payload, sizeof(payload));

    esp_err_t rc = mqtt_mgr_publish(topic, payload, (int)strlen(payload));
    if (rc == ESP_OK) {
        s_hb_stats.sent_ok++;
        s_hb_stats.last_ok_us = esp_timer_get_time();
        s_hb_attempts = 0;
        if (esp_timer_is_active(s_hb_retry)) esp_timer_stop(s_hb_retry);
        ESP_LOGI(TAG, "hb ok: topic=%s payload=%s", topic, payload);
    } else {
        s_hb_stats.sent_fail++;
        ESP_LOGW(TAG, "hb fail (0x%x) topic=%s attempt %u/%u",
                 (unsigned)rc, topic, (unsigned)(s_hb_attempts + 1),
                 (unsigned)MQTT_HB_RETRY_MAX);
        if (s_connected && s_hb_attempts + 1 < MQTT_HB_RETRY_MAX) {
            s_hb_attempts++;
            esp_timer_start_once(s_hb_retry, (uint64_t)MQTT_HB_RETRY_DELAY_MS * 1000ULL);
        } else {
            s_hb_attempts = 0;   /* 放弃本拍，等下一周期 */
        }
    }
}

/* 周期拍：连接中发送，未连接跳过（不重试，等重连） */
static void hb_timer_cb(void *arg)
{
    (void)arg;
    if (!s_connected) {
        s_hb_stats.skipped++;
        return;
    }
    s_hb_attempts = 0;
    hb_publish_attempt();
}

/* 重试拍 */
static void hb_retry_cb(void *arg)
{
    (void)arg;
    if (s_connected) hb_publish_attempt();
}

/* （重）启动周期定时器 */
static void hb_timer_restart(void)
{
    if (s_hb_timer == NULL) return;
    if (esp_timer_is_active(s_hb_timer)) esp_timer_stop(s_hb_timer);
    esp_timer_start_periodic(s_hb_timer, (uint64_t)s_hb_interval_s * 1000000ULL);
}

/* ---- 心跳对外接口 ---- */

esp_err_t mqtt_mgr_hb_start(void)
{
    if (s_hb_timer == NULL) return ESP_ERR_INVALID_STATE;
    s_hb_enabled = true;
    hb_timer_restart();
    ESP_LOGI(TAG, "hb started (interval %us)", (unsigned)s_hb_interval_s);
    return ESP_OK;
}

void mqtt_mgr_hb_stop(void)
{
    s_hb_enabled = false;
    if (s_hb_timer) esp_timer_stop(s_hb_timer);
    if (s_hb_retry) esp_timer_stop(s_hb_retry);
    ESP_LOGI(TAG, "hb stopped");
}

esp_err_t mqtt_mgr_hb_set_interval(uint32_t interval_s)
{
    if (interval_s < MQTT_HB_INTERVAL_S_MIN) return ESP_ERR_INVALID_ARG;
    s_hb_interval_s = interval_s;
    if (s_hb_enabled) hb_timer_restart();   /* 连接中/未连接均安全：未连接时拍了也会跳过 */
    ESP_LOGI(TAG, "hb interval -> %us", (unsigned)interval_s);
    return ESP_OK;
}

esp_err_t mqtt_mgr_hb_set_topic_fmt(const char *fmt)
{
    if (fmt == NULL || strchr(fmt, '%') == NULL ||
        strlen(fmt) >= sizeof(s_hb_topic_fmt))
        return ESP_ERR_INVALID_ARG;
    strlcpy(s_hb_topic_fmt, fmt, sizeof(s_hb_topic_fmt));
    ESP_LOGI(TAG, "hb topic fmt -> %s", s_hb_topic_fmt);
    return ESP_OK;
}

esp_err_t mqtt_mgr_hb_set_payload_template(const char *tpl)
{
    if (tpl == NULL || tpl[0] == 0 || strlen(tpl) >= sizeof(s_hb_tpl))
        return ESP_ERR_INVALID_ARG;
    strlcpy(s_hb_tpl, tpl, sizeof(s_hb_tpl));
    ESP_LOGI(TAG, "hb template -> %s", s_hb_tpl);
    return ESP_OK;
}

esp_err_t mqtt_mgr_hb_send_now(void)
{
    if (!s_connected) return ESP_ERR_INVALID_STATE;
    s_hb_attempts = 0;
    hb_publish_attempt();
    return ESP_OK;
}

void mqtt_mgr_hb_get_stats(mqtt_mgr_hb_stats_t *out)
{
    if (out) *out = s_hb_stats;
}

/* ---- MQTT 事件 ---- */
static void mqtt_event_handler(void *arg, esp_event_base_t base,
                               int32_t event_id, void *event_data)
{
    esp_mqtt_event_handle_t event = event_data;
    switch ((esp_mqtt_event_id_t)event_id) {
    case MQTT_EVENT_CONNECTED:
        s_connected = true;
        emit("MQTT,CONNECTED");
        if (s_ready_cb) s_ready_cb();
        /* 心跳自启动/异常恢复：连接即发首跳，随后按周期运行 */
        if (s_hb_enabled) {
            s_hb_attempts = 0;
            hb_timer_restart();
            hb_publish_attempt();
        }
        break;

    case MQTT_EVENT_DATA:
        if (s_message_cb) s_message_cb(event->topic,event->topic_len,event->data,
            event->data_len,event->total_data_len,event->current_data_offset,event->retain);
        break;

    case MQTT_EVENT_DISCONNECTED:
        s_connected = false;
        emit("MQTT,DISCONNECTED");
        if (s_hb_timer) esp_timer_stop(s_hb_timer);
        if (s_hb_retry) esp_timer_stop(s_hb_retry);
        break;

    case MQTT_EVENT_ERROR: {
        s_connected = false;
        const char *reason = "unknown";
        if (event->error_handle->error_type == MQTT_ERROR_TYPE_TCP_TRANSPORT) {
            reason = "transport";
            ESP_LOGE(TAG, "transport error: 0x%x",
                     event->error_handle->esp_tls_last_esp_err);
        } else if (event->error_handle->error_type == MQTT_ERROR_TYPE_CONNECTION_REFUSED) {
            reason = "refused";
            ESP_LOGE(TAG, "connection refused: %d",
                     event->error_handle->connect_return_code);
        }
        char buf[48];
        snprintf(buf, sizeof(buf), "MQTT,ERR,%s", reason);
        emit(buf);
        break;
    }

    default:
        break;
    }
}

/* ---- WiFi/IP 事件：获 IP 启动 MQTT，断网停止 ---- */
static void net_event_handler(void *arg, esp_event_base_t base,
                              int32_t event_id, void *event_data)
{
    if (base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        if (s_client && !s_started) {
            esp_mqtt_client_start(s_client);
            s_started = true;
            ESP_LOGI(TAG, "wifi got ip, mqtt starting");
        }
    } else if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        s_connected = false;
        if (s_client && s_started) {
            /* 网络断开：停止 client 与心跳，避免无网空转；获 IP 后再恢复 */
            esp_mqtt_client_stop(s_client);
            s_started = false;
            if (s_hb_timer) esp_timer_stop(s_hb_timer);
            if (s_hb_retry) esp_timer_stop(s_hb_retry);
            ESP_LOGI(TAG, "wifi lost, mqtt stopped");
        }
    }
}

esp_err_t mqtt_mgr_init(void)
{
    bool structured=false;
#if defined(CONFIG_FELDSPAR_FEATURE_LINK) && CONFIG_FELDSPAR_FEATURE_LINK
    if (!load_device_profile()) {
        ESP_LOGW(TAG,"structured link requires device-specific NVS profile; no legacy credential fallback");
        return ESP_ERR_INVALID_STATE;
    }
    structured=true;
    s_hb_enabled=false; /* device ACL permits structured topics only */
#endif
    /* 设备标识：ClientID = haomian-<MAC后3字节>（与 BLE 名后缀一致）；
     * 心跳 MAC = 完整 12 位大写十六进制（动态替换主题占位符） */
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(s_client_id, sizeof(s_client_id), "%s%02X%02X%02X",
             MQTT_CLIENT_PREFIX, mac[3], mac[4], mac[5]);
    snprintf(s_mac_str, sizeof(s_mac_str), "%02X%02X%02X%02X%02X%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    strlcpy(s_hb_tpl, MQTT_HB_TPL_DEF, sizeof(s_hb_tpl));

    esp_mqtt_client_config_t cfg = {
        .broker = {
            .address.uri = MQTT_BROKER_URI,
            .verification.certificate = ca_crt_start,   /* 显式 CA 校验（mqtts） */
        },
        .credentials = {
            .username = MQTT_USERNAME,
            .authentication.password = MQTT_PASSWORD,
            .client_id = s_client_id,
        },
        .network = {
            .reconnect_timeout_ms = 5000,   /* 断线 5s 后重连 */
            .timeout_ms = 10000,
        },
    };
    if (structured) {
        cfg.broker.address.uri=s_device_broker;
        cfg.credentials.username=s_device_id;
        cfg.credentials.authentication.password=s_device_key;
    }

    s_client = esp_mqtt_client_init(&cfg);
    if (s_client == NULL) {
        ESP_LOGE(TAG, "mqtt client init fail");
        return ESP_FAIL;
    }
    esp_mqtt_client_register_event(s_client, MQTT_EVENT_ANY, mqtt_event_handler, NULL);

    /* 心跳定时器（周期拍 + 重试拍；连接成功后自动启动） */
    const esp_timer_create_args_t hb_args = {
        .callback = hb_timer_cb, .name = "mqtt_hb",
    };
    ESP_ERROR_CHECK(esp_timer_create(&hb_args, &s_hb_timer));
    const esp_timer_create_args_t rty_args = {
        .callback = hb_retry_cb, .name = "mqtt_hb_r",
    };
    ESP_ERROR_CHECK(esp_timer_create(&rty_args, &s_hb_retry));

    /* 注册网络事件（默认事件循环由 wifi_mgr 创建） */
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                               &net_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED,
                                               &net_event_handler, NULL));

    ESP_LOGI(TAG, "mqtt mgr init ok (uri=%s, user=%s, client=%s, ca=%dB, hb=%us topic=%s)",
             cfg.broker.address.uri, cfg.credentials.username, s_client_id,
             (int)(ca_crt_end - ca_crt_start),
             (unsigned)s_hb_interval_s, MQTT_HB_TOPIC_FMT_DEF);
    if (wifi_mgr_is_connected() && !s_started) {
        esp_err_t start=esp_mqtt_client_start(s_client);
        if (start==ESP_OK) s_started=true;
    }
    return ESP_OK;
}

esp_err_t mqtt_mgr_publish(const char *topic, const char *payload, int len)
{
    if (!s_connected || s_client == NULL) return ESP_ERR_INVALID_STATE;
    int msg_id = esp_mqtt_client_publish(s_client, topic, payload, len, 1, 0);
    return (msg_id >= 0) ? ESP_OK : ESP_FAIL;
}
