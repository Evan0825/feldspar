#pragma once

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ---- WiFi STA 管理（好眠）----
 * 职责：esp_netif + WiFi STA 初始化、断线重连、NVS 凭据记忆。
 * 由 BLE 0x41 下发 SSID/密码后保存并连接；上电自动重连上次连接的网络。
 * 状态经 wifi_mgr_set_event_cb 注册的回调上报（BLE 层推送到 0xFF04），
 * 字符串格式：
 *   WIFI,CONNECTING,<ssid>
 *   WIFI,CONNECTED,<ssid>,<ip>
 *   WIFI,DISCONNECTED,<ssid>,<reason>
 *   WIFI,IDLE,<ssid>        已保存凭据但未连接
 *   WIFI,FORGOT
 *   WIFI,ERR,<msg>
 * 扫描附近 AP（BLE 0x44 触发，结果逐行上报）：
 *   WIFI,SCANNING           扫描开始
 *   WIFI,AP,<rssi>,<secure>,<ssid>  单个 AP（secure: 1=加密 0=开放；SSID 在末位，
 *                                    允许 SSID 内含逗号；同名 AP 去重后按信号降序）
 *   WIFI,SCANEND,<count>    扫描结束（count 为去重后 AP 数）
 *   WIFI,SCANERR            扫描启动失败
 */

/* 初始化 netif + WiFi STA；若 NVS 有已存凭据则自动重连 */
esp_err_t wifi_mgr_init(void);

/* 保存凭据到 NVS 并连接指定 AP（SSID 1-32B；密码可空表示开放网络，8-63B）
 * 成功返回 ESP_OK（异步连接，实际结果经状态回调上报） */
esp_err_t wifi_mgr_connect(const char *ssid, const char *pass);

/* 清除已存凭据并断开 WiFi */
void wifi_mgr_forget(void);

/* 触发一次附近 AP 扫描（异步，非阻塞）。
 * 结果经状态回调逐行上报：WIFI,SCANNING / WIFI,AP,... / WIFI,SCANEND,<n>。
 * 已在扫描中或 WiFi 未初始化时返回错误。 */
esp_err_t wifi_mgr_scan_start(void);

/* 是否有扫描正在进行（防止重复触发） */
bool wifi_mgr_scan_running(void);

/* 当前是否已连接并获得 IP（网络 OTA 触发的前置条件检查）。 */
bool wifi_mgr_is_connected(void);

/* 查询当前状态文本，写入 buf（与上报回调同格式） */
void wifi_mgr_get_status(char *buf, size_t len);

/* 注册状态上报回调（由 BLE 层注入，避免 wifi_mgr 反向依赖 ble） */
void wifi_mgr_set_event_cb(void (*cb)(const char *msg));

#ifdef __cplusplus
}
#endif
