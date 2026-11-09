#pragma once
#include "esp_err.h"

typedef struct { int unused; } esp_netif_t;
typedef struct { struct { unsigned char ip[4]; } ip_info; } ip_event_got_ip_t;
#define IPSTR "%u.%u.%u.%u"
#define IP2STR(ip) (ip)[0][0], (ip)[0][1], (ip)[0][2], (ip)[0][3]

esp_err_t esp_netif_init(void);
esp_netif_t *esp_netif_create_default_wifi_sta(void);
