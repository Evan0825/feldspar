#pragma once

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ---- MQTT over TLS 客户端（好眠）----
 * 职责：WiFi 拿到 IP 后自动连接 MQTT broker（mqtts + CA 证书 + 账号密码），
 *       WiFi 断开则停止，重连由 esp-mqtt 内部/重新获 IP 后恢复。
 * 状态经 mqtt_mgr_set_event_cb 注册的回调上报（BLE 层推送到 0xFF04），格式：
 *   MQTT,CONNECTED,<host>
 *   MQTT,DISCONNECTED
 *   MQTT,ERR,<msg>
 * broker 地址、账号、密码见 mqtt_mgr.c 顶部宏（当前为 EMQX Cloud Serverless 深圳节点）。
 */

/* 初始化 MQTT 客户端并注册 WiFi/IP 事件（不立即连接，获 IP 后自动连） */
esp_err_t mqtt_mgr_init(void);

/* 当前 MQTT 是否已连接 */
bool mqtt_mgr_is_connected(void);

/* 发布消息（QoS1）；未连接时返回 ESP_ERR_INVALID_STATE */
esp_err_t mqtt_mgr_publish(const char *topic, const char *payload, int len);

/* 注册状态上报回调（由 BLE 层注入，避免 mqtt_mgr 反向依赖 ble） */
void mqtt_mgr_set_event_cb(void (*cb)(const char *msg));
typedef void (*mqtt_message_cb_t)(const char *topic, int topic_len, const char *data,
    int data_len, int total_len, int offset, bool retained);
void mqtt_mgr_set_message_cb(mqtt_message_cb_t callback);
void mqtt_mgr_set_ready_cb(void (*callback)(void));
esp_err_t mqtt_mgr_subscribe(const char *topic);
/* Empty unless the opt-in structured link has device-specific NVS credentials. */
const char *mqtt_mgr_device_id(void);

/* ---- 心跳（heartbeat）----
 * MQTT 连接成功后自动运行（服务自启动 + 断线恢复）：
 *   - 连接建立即发首跳，之后按间隔周期发送（默认 30s，可配置，最小 5s）
 *   - 主题默认 "testtopic/<MAC>"（MAC 为 12 位大写十六进制，动态替换 ${设备mac地址}）
 *   - 内容为 JSON：设备标识 / 时间戳 / 运行状态；可用模板自定义（见下）
 *   - 发送失败自动重试（间隔 5s，每拍最多 3 次）；未连接时跳过不计时
 *   - 断线自动停止，重连后自动恢复；每次发送记录日志与统计
 * 模板占位符（mqtt_mgr_hb_set_payload_template）：
 *   ${id} 设备标识(haomian-XXXXXX)  ${mac} 完整MAC  ${ts} Unix时间戳(未同步时为0)
 *   ${uptime} 开机秒数  ${fw} 固件版本  ${rssi} WiFi信号  ${heap} 空闲堆  ${status} 状态
 */

/* 启动心跳（默认已启用；一般无需手动调用） */
esp_err_t mqtt_mgr_hb_start(void);

/* 停止心跳（断线时内部自动停止） */
void mqtt_mgr_hb_stop(void);

/* 设置发送间隔（秒），>=5；连接中立即生效 */
esp_err_t mqtt_mgr_hb_set_interval(uint32_t interval_s);

/* 设置主题格式，须含 "%s"（被 MAC 替换），如 "testtopic/%s" 或 "hb/${mac}" 式固定串 */
esp_err_t mqtt_mgr_hb_set_topic_fmt(const char *fmt);

/* 自定义消息模板（JSON 片段均可），占位符见上；空串/超长(>=384B)拒绝 */
esp_err_t mqtt_mgr_hb_set_payload_template(const char *tpl);

/* 手动立即发送一拍（须已连接） */
esp_err_t mqtt_mgr_hb_send_now(void);

/* 心跳统计 */
typedef struct {
    uint32_t sent_ok;       /* 成功发送次数 */
    uint32_t sent_fail;     /* 发布失败次数（含重试） */
    uint32_t skipped;       /* 未连接跳过的周期数 */
    int64_t  last_ok_us;    /* 最近一次成功发送时刻（esp_timer 时间轴） */
} mqtt_mgr_hb_stats_t;
void mqtt_mgr_hb_get_stats(mqtt_mgr_hb_stats_t *out);

#ifdef __cplusplus
}
#endif
