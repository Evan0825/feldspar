#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "esp_event.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "nvs.h"
#include "wifi_mgr.h"

ESP_EVENT_DEFINE_BASE(WIFI_EVENT);
ESP_EVENT_DEFINE_BASE(IP_EVENT);
static esp_event_handler_t wifi_handler, ip_handler, scan_handler;
static esp_event_base_t queued_base;
static int32_t queued_id;
static bool driver_connecting, driver_scanning;
static int connect_calls, scan_calls, started, ended, failed, credential_writes;
static esp_err_t scan_error, post_error;

static void on_status(const char *msg)
{
    if (!strcmp(msg, "WIFI,SCANNING")) started++;
    if (!strcmp(msg, "WIFI,SCANEND,0")) ended++;
    if (!strcmp(msg, "WIFI,SCANERR")) failed++;
}

static void run_queued_scan(void)
{
    assert(queued_base && scan_handler);
    esp_event_base_t base = queued_base;
    queued_base = NULL;
    scan_handler(NULL, base, queued_id, NULL);
}

static void disconnect(void)
{
    wifi_event_sta_disconnected_t event = {.reason = 201};
    driver_connecting = false;
    wifi_handler(NULL, WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, &event);
}

static void finish_scan(void)
{
    assert(driver_scanning);
    driver_scanning = false;
    wifi_handler(NULL, WIFI_EVENT, WIFI_EVENT_SCAN_DONE, NULL);
}

int main(void)
{
    wifi_mgr_set_event_cb(on_status);
    assert(wifi_mgr_init() == ESP_OK);
    wifi_handler(NULL, WIFI_EVENT, WIFI_EVENT_STA_START, NULL);
    assert(connect_calls == 1 && driver_connecting);

    /* The actual driver rejects scans during reconnect. Keep the request,
       scan before the next reconnect and then resume using the saved AP. */
    assert(wifi_mgr_scan_start() == ESP_OK);
    assert(wifi_mgr_scan_start() == ESP_ERR_INVALID_STATE);
    run_queued_scan();
    assert(scan_calls == 1 && !driver_scanning && !started && !failed);
    assert(wifi_mgr_connect("test-network", "") == ESP_ERR_INVALID_STATE);
    assert(!credential_writes);
    disconnect();
    assert(driver_scanning && started == 1 && connect_calls == 1);
    finish_scan();
    assert(ended == 1 && connect_calls == 2 && !wifi_mgr_scan_running());

    /* A successful association also unblocks scanning without dropping it. */
    assert(wifi_mgr_scan_start() == ESP_OK);
    run_queued_scan();
    driver_connecting = false;
    wifi_handler(NULL, WIFI_EVENT, WIFI_EVENT_STA_CONNECTED, NULL);
    assert(driver_scanning && started == 2);
    finish_scan();
    assert(ended == 2 && connect_calls == 2);

    /* If the driver rejects a deferred scan, report it and resume reconnect. */
    disconnect();
    assert(connect_calls == 3);
    assert(wifi_mgr_scan_start() == ESP_OK);
    run_queued_scan();
    scan_error = ESP_FAIL;
    disconnect();
    assert(failed == 1 && connect_calls == 4 && !wifi_mgr_scan_running());

    /* Forgetting during a scan must not reconnect the erased network. */
    scan_error = ESP_OK;
    assert(wifi_mgr_scan_start() == ESP_OK);
    run_queued_scan();
    disconnect();
    assert(driver_scanning);
    wifi_mgr_forget();
    finish_scan();
    assert(ended == 3 && connect_calls == 4 && !wifi_mgr_scan_running());

    post_error = ESP_FAIL;
    assert(wifi_mgr_scan_start() == ESP_FAIL && !wifi_mgr_scan_running());
    puts("Wi-Fi scan and saved-network reconnect ordering passed (stub radio).");
}

esp_err_t esp_event_handler_register(esp_event_base_t base, int32_t id,
                                     esp_event_handler_t handler, void *arg)
{
    (void)id; (void)arg;
    if (base == WIFI_EVENT) wifi_handler = handler;
    else if (base == IP_EVENT) ip_handler = handler;
    else scan_handler = handler;
    return ESP_OK;
}

esp_err_t esp_event_post(esp_event_base_t base, int32_t id, const void *data, size_t size, uint32_t ticks)
{
    (void)data; (void)size; (void)ticks;
    if (post_error != ESP_OK) return post_error;
    assert(!queued_base);
    queued_base = base;
    queued_id = id;
    return ESP_OK;
}

esp_err_t esp_wifi_connect(void)
{
    assert(!driver_scanning);
    driver_connecting = true;
    connect_calls++;
    return ESP_OK;
}

esp_err_t esp_wifi_disconnect(void) { driver_connecting = false; return ESP_OK; }

esp_err_t esp_wifi_scan_start(const wifi_scan_config_t *config, bool block)
{
    assert(config->scan_type == WIFI_SCAN_TYPE_ACTIVE && !block);
    scan_calls++;
    if (driver_connecting) return ESP_ERR_WIFI_STATE;
    if (scan_error != ESP_OK) return scan_error;
    driver_scanning = true;
    return ESP_OK;
}

esp_err_t esp_wifi_scan_get_ap_num(uint16_t *n) { *n = 0; return ESP_OK; }
esp_err_t esp_wifi_scan_get_ap_records(uint16_t *n, wifi_ap_record_t *aps) { (void)n; (void)aps; return ESP_FAIL; }
esp_err_t esp_wifi_clear_ap_list(void) { return ESP_OK; }
esp_err_t esp_event_loop_create_default(void) { return ESP_OK; }
esp_err_t esp_netif_init(void) { return ESP_OK; }
esp_netif_t *esp_netif_create_default_wifi_sta(void) { static esp_netif_t sta; return &sta; }
esp_err_t esp_wifi_init(const wifi_init_config_t *c) { (void)c; return ESP_OK; }
esp_err_t esp_wifi_set_mode(int mode) { (void)mode; return ESP_OK; }
esp_err_t esp_wifi_start(void) { return ESP_OK; }
esp_err_t esp_wifi_set_config(int iface, const wifi_config_t *c) { (void)iface; (void)c; return ESP_OK; }
const char *esp_err_to_name(esp_err_t err) { (void)err; return "test error"; }
int64_t esp_timer_get_time(void) { return 3000000; }
esp_err_t nvs_open(const char *ns, int mode, nvs_handle_t *h) { (void)ns; (void)mode; *h = 1; return ESP_OK; }
esp_err_t nvs_get_str(nvs_handle_t h, const char *key, char *out, size_t *size)
{
    (void)h;
    const char *value = !strcmp(key, "ssid") ? "old-test-network" : "";
    assert(*size > strlen(value));
    strcpy(out, value);
    return ESP_OK;
}
esp_err_t nvs_set_str(nvs_handle_t h, const char *key, const char *value)
{ (void)h; (void)key; (void)value; credential_writes++; return ESP_OK; }
esp_err_t nvs_erase_all(nvs_handle_t h) { (void)h; return ESP_OK; }
esp_err_t nvs_commit(nvs_handle_t h) { (void)h; return ESP_OK; }
void nvs_close(nvs_handle_t h) { (void)h; }
