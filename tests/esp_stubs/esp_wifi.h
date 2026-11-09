#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

#define ESP_ERR_WIFI_STATE 30
#define WIFI_INIT_CONFIG_DEFAULT() ((wifi_init_config_t){0})
#define WIFI_MODE_STA 1
#define WIFI_IF_STA 1
#define WIFI_SCAN_TYPE_ACTIVE 1
#define WIFI_AUTH_OPEN 0

typedef struct { int unused; } wifi_init_config_t;
typedef struct { int reason; } wifi_event_sta_disconnected_t;
typedef struct { unsigned char ssid[33]; int rssi, authmode; } wifi_ap_record_t;
typedef struct { const void *ssid, *bssid; int channel; bool show_hidden; int scan_type; } wifi_scan_config_t;
typedef struct { struct { unsigned char ssid[32], password[64]; struct { int authmode; } threshold; } sta; } wifi_config_t;

const char *esp_err_to_name(esp_err_t);
esp_err_t esp_wifi_init(const wifi_init_config_t *);
esp_err_t esp_wifi_set_mode(int);
esp_err_t esp_wifi_start(void);
esp_err_t esp_wifi_connect(void);
esp_err_t esp_wifi_disconnect(void);
esp_err_t esp_wifi_set_config(int, const wifi_config_t *);
esp_err_t esp_wifi_scan_start(const wifi_scan_config_t *, bool);
esp_err_t esp_wifi_scan_get_ap_num(uint16_t *);
esp_err_t esp_wifi_scan_get_ap_records(uint16_t *, wifi_ap_record_t *);
esp_err_t esp_wifi_clear_ap_list(void);
