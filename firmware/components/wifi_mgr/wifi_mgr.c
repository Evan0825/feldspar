#include "wifi_mgr.h"

#include <string.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
#include "esp_log.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "wifi_mgr";

/* ---- 常量 ---- */
#define WIFI_MGR_NVS_NS     "wifi"      /* NVS 命名空间（≤15 字符） */
#define WIFI_SSID_MAX       32          /* IEEE 802.11 SSID 最长 32 字节 */
#define WIFI_PASS_MAX       63          /* WPA2 WPA3 密码最长 63 字节 */
#define WIFI_STATUS_BUF     96          /* 状态文本缓冲 */
#define WIFI_SCAN_MAX_AP    20          /* 扫描结果去重后最多上报的 AP 数 */

/* ---- 运行时状态 ---- */
static bool          s_inited    = false;
static bool          s_scanning  = false;   /* AP 扫描进行中（防重复触发） */
static bool          s_connected = false;
static char          s_ssid[WIFI_SSID_MAX + 1] = {0};
static char          s_pass[WIFI_PASS_MAX + 1] = {0};
static char          s_ip[16]  = {0};    /* 点分十进制（IPv4） */
static esp_netif_t  *s_sta      = NULL;
static void        (*s_event_cb)(const char *msg) = NULL;
static uint32_t      s_last_notify_ms = 0;  /* 断连通知限流 */

/* ---- 状态上报：推送一行到注册回调（如 BLE 0xFF04）---- */
static void notify(const char *fmt, ...)
{
    if (!s_event_cb) return;

    char buf[WIFI_STATUS_BUF];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);

    /* 断连消息可能因自动重连而高频重复，限流到 ≥1.2s 一条，避免刷屏 */
    uint32_t now = (uint32_t)(esp_timer_get_time() / 1000U);
    if (strstr(buf, "DISCONNECTED") && (now - s_last_notify_ms) < 1200) {
        return;
    }
    s_last_notify_ms = now;

    s_event_cb(buf);
    ESP_LOGI(TAG, "notify: %s", buf);
}

/* ---- NVS 凭据读写 ---- */
static void creds_load(char *ssid, size_t ssid_len, char *pass, size_t pass_len)
{
    ssid[0] = 0;
    pass[0] = 0;

    nvs_handle_t h;
    if (nvs_open(WIFI_MGR_NVS_NS, NVS_READONLY, &h) != ESP_OK) {
        return;
    }
    size_t l = ssid_len;
    if (nvs_get_str(h, "ssid", ssid, &l) != ESP_OK || ssid[0] == 0) {
        ssid[0] = 0;
    }
    l = pass_len;
    if (nvs_get_str(h, "pass", pass, &l) != ESP_OK) {
        pass[0] = 0;
    }
    nvs_close(h);
    ESP_LOGI(TAG, "load creds: ssid='%s' pass_set=%d",
             ssid, (int)(pass[0] != 0));
}

static void creds_save(const char *ssid, const char *pass)
{
    nvs_handle_t h;
    if (nvs_open(WIFI_MGR_NVS_NS, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_set_str(h, "ssid", ssid);
    nvs_set_str(h, "pass", pass);
    nvs_commit(h);
    nvs_close(h);
}

static void creds_erase(void)
{
    nvs_handle_t h;
    if (nvs_open(WIFI_MGR_NVS_NS, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_erase_all(h);
    nvs_commit(h);
    nvs_close(h);
}

/* ---- WiFi 事件处理 ---- */
static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT) {
        switch (id) {
        case WIFI_EVENT_STA_START:
            /* STA 启动：若存有凭据则发起连接 */
            if (s_ssid[0]) {
                ESP_LOGI(TAG, "STA start, connect to %s", s_ssid);
                if (esp_wifi_connect() != ESP_OK) notify("WIFI,ERR,connect");
            } else {
                notify("WIFI,IDLE");
            }
            break;

        case WIFI_EVENT_STA_CONNECTED:
            ESP_LOGI(TAG, "STA connected to %s, waiting IP", s_ssid);
            break;

        case WIFI_EVENT_STA_DISCONNECTED: {
            wifi_event_sta_disconnected_t *e =
                (wifi_event_sta_disconnected_t *)data;
            s_connected = false;
            s_ip[0] = 0;
            if (s_ssid[0]) {
                notify("WIFI,DISCONNECTED,%s,%d", s_ssid, (int)e->reason);
                /* 自动重连（凭据仍在 NVS） */
                if (esp_wifi_connect() != ESP_OK) notify("WIFI,ERR,reconnect");
            }
            break;
        }
        case WIFI_EVENT_SCAN_DONE: {
            /* 扫描完成：取结果 → 同名去重（保留最强信号）→ 按信号降序 → 逐条上报 */
            uint16_t ap_num = 0;
            esp_wifi_scan_get_ap_num(&ap_num);
            ESP_LOGI(TAG, "scan done, raw ap_num=%u", (unsigned)ap_num);

            if (ap_num == 0) {
                s_scanning = false;
                notify("WIFI,SCANEND,0");
                break;
            }

            wifi_ap_record_t *aps = calloc(ap_num, sizeof(wifi_ap_record_t));
            if (aps == NULL) {
                esp_wifi_clear_ap_list();
                s_scanning = false;
                notify("WIFI,SCANERR");
                break;
            }
            uint16_t got = ap_num;
            if (esp_wifi_scan_get_ap_records(&got, aps) != ESP_OK) {
                free(aps);
                s_scanning = false;
                notify("WIFI,SCANERR");
                break;
            }

            /* 去重：同 SSID 只保留 RSSI 最大的一条（keep[i]=true 表示保留）；
             * 隐藏网络（空 SSID）不上报。 */
            bool *keep = calloc(got, sizeof(bool));
            if (keep == NULL) {
                free(aps);
                s_scanning = false;
                notify("WIFI,SCANERR");
                break;
            }
            for (uint16_t i = 0; i < got; i++) {
                if (aps[i].ssid[0] == 0) continue;
                bool dup = false;
                for (uint16_t j = 0; j < i; j++) {
                    if (keep[j] &&
                        memcmp(aps[i].ssid, aps[j].ssid, sizeof(aps[i].ssid)) == 0) {
                        dup = true;
                        if (aps[i].rssi > aps[j].rssi) { keep[j] = false; keep[i] = true; }
                        break;
                    }
                }
                if (!dup) keep[i] = true;
            }

            /* 收集去重后的下标并按 RSSI 降序排序（简单选择排序，数量 ≤ 数十） */
            uint16_t n = 0;
            uint16_t *idx = calloc(got, sizeof(uint16_t));
            if (idx != NULL) {
                for (uint16_t i = 0; i < got; i++) {
                    if (keep[i]) idx[n++] = i;
                }
                for (uint16_t i = 0; i < n; i++) {
                    uint16_t best = i;
                    for (uint16_t j = i + 1; j < n; j++) {
                        if (aps[idx[j]].rssi > aps[idx[best]].rssi) best = j;
                    }
                    if (best != i) { uint16_t t = idx[i]; idx[i] = idx[best]; idx[best] = t; }
                }
            }

            uint16_t sent = 0;
            char line[WIFI_STATUS_BUF];
            for (uint16_t k = 0; k < n && sent < WIFI_SCAN_MAX_AP; k++) {
                wifi_ap_record_t *ap = &aps[idx[k]];
                char ssid[WIFI_SSID_MAX + 1];
                memcpy(ssid, ap->ssid, WIFI_SSID_MAX);
                ssid[WIFI_SSID_MAX] = 0;
                int secure = (ap->authmode == WIFI_AUTH_OPEN) ? 0 : 1;
                /* SSID 放末位：即使含逗号也不破坏前 3 个定长字段的解析 */
                snprintf(line, sizeof(line), "WIFI,AP,%d,%d,%s",
                         (int)ap->rssi, secure, ssid);
                if (s_event_cb) s_event_cb(line);
                sent++;
            }
            char end[32];
            snprintf(end, sizeof(end), "WIFI,SCANEND,%u", (unsigned)sent);
            notify(end);

            free(aps);
            free(keep);
            free(idx);
            s_scanning = false;
            break;
        }
        default:
            break;
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
        s_connected = true;
        snprintf(s_ip, sizeof(s_ip), IPSTR, IP2STR(&e->ip_info.ip));
        ESP_LOGI(TAG, "STA got IP: %s", s_ip);
        notify("WIFI,CONNECTED,%s,%s", s_ssid, s_ip);
    }
}

/* ------------------------------------------------------------------ */

esp_err_t wifi_mgr_init(void)
{
    if (s_inited) return ESP_OK;

    esp_err_t err;

    /* netif + 默认事件循环（WiFi 事件与 IP 获取依赖） */
    err = esp_netif_init();
    if (err != ESP_OK) { ESP_LOGE(TAG, "netif init fail: %s", esp_err_to_name(err)); return err; }

    err = esp_event_loop_create_default();
    if (err != ESP_OK) { ESP_LOGE(TAG, "event loop fail: %s", esp_err_to_name(err)); return err; }

    s_sta = esp_netif_create_default_wifi_sta();
    if (s_sta == NULL) { ESP_LOGE(TAG, "create default sta netif fail"); return ESP_ERR_NO_MEM; }

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    err = esp_wifi_init(&cfg);
    if (err != ESP_OK) { ESP_LOGE(TAG, "wifi init fail: %s", esp_err_to_name(err)); return err; }

    err = esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                     wifi_event_handler, NULL);
    if (err != ESP_OK) { ESP_LOGE(TAG, "wifi evt reg fail: %s", esp_err_to_name(err)); return err; }
    err = esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                     wifi_event_handler, NULL);
    if (err != ESP_OK) { ESP_LOGE(TAG, "ip evt reg fail: %s", esp_err_to_name(err)); return err; }

    err = esp_wifi_set_mode(WIFI_MODE_STA);
    if (err != ESP_OK) { ESP_LOGE(TAG, "set mode fail: %s", esp_err_to_name(err)); return err; }

    /* 从 NVS 加载已存凭据；有则在本机 STA_START 后自动连接 */
    creds_load(s_ssid, sizeof(s_ssid), s_pass, sizeof(s_pass));

    err = esp_wifi_start();
    if (err != ESP_OK) { ESP_LOGE(TAG, "wifi start fail: %s", esp_err_to_name(err)); return err; }

    s_inited = true;
    ESP_LOGI(TAG, "wifi init ok, %s", s_ssid[0] ? "will reconnect saved AP" : "no saved credentials");
    return ESP_OK;
}

esp_err_t wifi_mgr_connect(const char *ssid, const char *pass)
{
    if (!s_inited) return ESP_ERR_INVALID_STATE;
    if (ssid == NULL) return ESP_ERR_INVALID_ARG;

    size_t sn = strlen(ssid);
    size_t pn = (pass ? strlen(pass) : 0);
    if (sn == 0 || sn > WIFI_SSID_MAX) return ESP_ERR_INVALID_ARG;
    if (pn > WIFI_PASS_MAX)           return ESP_ERR_INVALID_ARG;

    strncpy(s_ssid, ssid, sizeof(s_ssid));
    s_ssid[sizeof(s_ssid) - 1] = 0;
    strncpy(s_pass, pass ? pass : "", sizeof(s_pass));
    s_pass[sizeof(s_pass) - 1] = 0;

    /* 保存到 NVS（重启后自动重连） */
    creds_save(s_ssid, s_pass);

    /* 配置 STA 并连接 */
    wifi_config_t wc = {0};
    strncpy((char *)wc.sta.ssid, s_ssid, sizeof(wc.sta.ssid));
    wc.sta.ssid[sizeof(wc.sta.ssid) - 1] = 0;
    strncpy((char *)wc.sta.password, s_pass, sizeof(wc.sta.password));
    wc.sta.password[sizeof(wc.sta.password) - 1] = 0;
    /* 阈值设为 OPEN，允许连接开放网络（无密码）；有密码时自动协商安全级别 */
    wc.sta.threshold.authmode = WIFI_AUTH_OPEN;

    esp_err_t err = esp_wifi_set_config(WIFI_IF_STA, &wc);
    if (err != ESP_OK) {
        notify("WIFI,ERR,setconfig");
        return err;
    }

    esp_wifi_disconnect();
    notify("WIFI,CONNECTING,%s", s_ssid);

    err = esp_wifi_connect();
    if (err != ESP_OK) {
        notify("WIFI,ERR,connect");
    }
    return err;
}

void wifi_mgr_forget(void)
{
    creds_erase();
    s_ssid[0] = 0;
    s_pass[0] = 0;
    s_connected = false;
    s_ip[0] = 0;
    if (s_inited) esp_wifi_disconnect();
    notify("WIFI,FORGOT");
}

esp_err_t wifi_mgr_scan_start(void)
{
    if (!s_inited) return ESP_ERR_INVALID_STATE;
    if (s_scanning) return ESP_ERR_INVALID_STATE;

    /* 全信道主动扫描；show_hidden=false 不上报隐藏网络。
     * 非阻塞：扫描完成后 WIFI_EVENT_SCAN_DONE 事件里取结果并上报。 */
    wifi_scan_config_t cfg = {
        .ssid        = NULL,
        .bssid       = NULL,
        .channel     = 0,
        .show_hidden = false,
        .scan_type   = WIFI_SCAN_TYPE_ACTIVE,
    };
    esp_err_t err = esp_wifi_scan_start(&cfg, false);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "scan start fail: %s", esp_err_to_name(err));
        notify("WIFI,SCANERR");
        return err;
    }
    s_scanning = true;
    notify("WIFI,SCANNING");
    ESP_LOGI(TAG, "ap scan started");
    return ESP_OK;
}

bool wifi_mgr_scan_running(void)
{
    return s_scanning;
}

bool wifi_mgr_is_connected(void)
{
    return s_connected;
}

void wifi_mgr_get_status(char *buf, size_t len)
{
    if (buf == NULL || len == 0) return;

    if (!s_inited) {
        snprintf(buf, len, "WIFI,OFF");
        return;
    }
    if (s_connected) {
        snprintf(buf, len, "WIFI,CONNECTED,%s,%s", s_ssid, s_ip);
    } else if (s_ssid[0]) {
        snprintf(buf, len, "WIFI,IDLE,%s", s_ssid);
    } else {
        snprintf(buf, len, "WIFI,OFF");
    }
}

void wifi_mgr_set_event_cb(void (*cb)(const char *msg))
{
    s_event_cb = cb;
}
