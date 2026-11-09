#pragma once
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

typedef const char *esp_event_base_t;
typedef void (*esp_event_handler_t)(void *, esp_event_base_t, int32_t, void *);
#define ESP_EVENT_DEFINE_BASE(name) esp_event_base_t name = #name
#define ESP_EVENT_ANY_ID (-1)
extern esp_event_base_t WIFI_EVENT, IP_EVENT;
enum { WIFI_EVENT_STA_START, WIFI_EVENT_STA_CONNECTED, WIFI_EVENT_STA_DISCONNECTED, WIFI_EVENT_SCAN_DONE };
#define IP_EVENT_STA_GOT_IP 1

esp_err_t esp_event_loop_create_default(void);
esp_err_t esp_event_handler_register(esp_event_base_t, int32_t, esp_event_handler_t, void *);
esp_err_t esp_event_post(esp_event_base_t, int32_t, const void *, size_t, uint32_t);
