/* Compile the actual ESP adapter against memory-only peripheral boundaries. */
#include <assert.h>
#include <string.h>
#include <stdio.h>
#include "../firmware/components/haptic/haptic.c"
#include "../firmware/components/device_control/device_control.c"

static int64_t time_us;
static uint32_t duty;
static bool flash_ok=true, timer_ok=true, pwm_ok=true, flash_present;
static safety_record_t stored, pending;
static void (*timer_callback)(void *);
static bool playing, light_on, auto_play;
static uint8_t volume;

int64_t esp_timer_get_time(void) { return time_us; }
SemaphoreHandle_t xSemaphoreCreateMutex(void) { return (void *)1; }
int xSemaphoreTake(SemaphoreHandle_t h, uint32_t wait) { (void)h; (void)wait; return pdTRUE; }
int xSemaphoreGive(SemaphoreHandle_t h) { (void)h; return pdTRUE; }
esp_err_t ledc_timer_config(const ledc_timer_config_t *c) { (void)c; return ESP_OK; }
esp_err_t ledc_channel_config(const ledc_channel_config_t *c) { duty=(uint32_t)c->duty; return ESP_OK; }
esp_err_t ledc_set_duty(int mode, int channel, uint32_t value) {
    (void)mode; (void)channel;
    if (!pwm_ok) { pwm_ok=true; return ESP_FAIL; }
    duty=value; return ESP_OK;
}
esp_err_t ledc_update_duty(int m, int c) { (void)m; (void)c; return ESP_OK; }
esp_err_t esp_timer_create(const esp_timer_create_args_t *args, esp_timer_handle_t *out) {
    timer_callback=args->callback; *out=(void *)1; return ESP_OK;
}
esp_err_t esp_timer_start_periodic(esp_timer_handle_t h, uint64_t period) {
    (void)h; assert(period==20000); return timer_ok ? ESP_OK : ESP_FAIL;
}
esp_err_t nvs_open(const char *name, int mode, nvs_handle_t *out) {
    (void)name; (void)mode; *out=1; return ESP_OK;
}
esp_err_t nvs_get_blob(nvs_handle_t h, const char *key, void *out, size_t *size) {
    (void)h; (void)key;
    if (!flash_present) return ESP_ERR_NOT_FOUND;
    assert(*size>=sizeof(stored)); memcpy(out,&stored,sizeof(stored)); *size=sizeof(stored); return ESP_OK;
}
esp_err_t nvs_set_blob(nvs_handle_t h, const char *key, const void *value, size_t size) {
    (void)h; (void)key; assert(size==sizeof(pending));
    /* Checkpoint writes must never block the deadline while output is on. */
    assert(duty==0); memcpy(&pending,value,size); return ESP_OK;
}
esp_err_t nvs_commit(nvs_handle_t h) {
    (void)h; if (!flash_ok) return ESP_FAIL;
    stored=pending; flash_present=true; return ESP_OK;
}
esp_err_t audio_set_volume(uint8_t v) { volume=v; return ESP_OK; }
void sfx_set_auto(bool on) { auto_play=on; }
esp_err_t sfx_stop(void) { playing=false; return ESP_OK; }
esp_err_t audio_stop(void) { playing=false; return ESP_OK; }
esp_err_t lighting_set_enabled(bool on) { light_on=on; return ESP_OK; }

void lighting_get_state(uint8_t *r, uint8_t *g, uint8_t *b, bool *enabled) {
    (void)r; (void)g; (void)b; *enabled=light_on;
}

int main(void) {
    assert(haptic_erm_set(50)==ESP_ERR_INVALID_STATE);
    assert(haptic_erm_init()==ESP_OK && duty==0 && haptic_stop_latched());
    assert(haptic_erm_set(50)!=ESP_OK && duty==0);
    assert(haptic_resume_manual()==ESP_OK && !haptic_stop_latched());
    assert(haptic_erm_set(50)==ESP_OK && duty==1023);
    assert(haptic_resume_manual()!=ESP_OK); /* no flash write during output */
    time_us=9000000;
    assert(haptic_erm_set(80)==ESP_OK && duty==1637);
    time_us=10000000;
    timer_callback(NULL); /* no mic/BLE/MQTT task called */
    assert(duty==0 && !s_guard.active);
    assert(haptic_erm_set(80)!=ESP_OK && duty==0);
    assert(haptic_resume_manual()==ESP_OK);
    ag_request_t cloud={.source=AG_CLOUD,.command_id="cloud",.percent=20,.duration_ms=1000,
        .expires_ms=20000,.authorized=true,.hardware_ready=true,.evidence_fresh=true,.clock_valid=true};
    assert(haptic_execute(&cloud)!=ESP_OK && duty==0);
    assert(haptic_erm_set(40)==ESP_OK);
    playing=light_on=auto_play=true; volume=80;
    assert(device_control_stop_all()==ESP_OK);
    assert(!playing && !light_on && !auto_play && volume==0 && duty==0 && haptic_stop_latched());
    assert(device_control_toggle_light()!=ESP_OK && !light_on);
    s_erm_inited=false;
    assert(haptic_erm_init()==ESP_OK && haptic_stop_latched());
    flash_ok=false;
    assert(haptic_resume_manual()!=ESP_OK && haptic_stop_latched());
    flash_ok=true;
    assert(haptic_resume_manual()==ESP_OK && duty==0);
    assert(device_control_toggle_light()==ESP_OK && light_on);
    assert(device_control_toggle_light()==ESP_OK && !light_on);
    pwm_ok=false;
    assert(haptic_erm_set(20)!=ESP_OK && duty==0 && haptic_stop_latched());
    s_erm_inited=false; timer_ok=false;
    assert(haptic_erm_init()!=ESP_OK && duty==0);
    puts("ESP adapter timer, stop, persistence and failure checks passed (stub peripherals).");
}
