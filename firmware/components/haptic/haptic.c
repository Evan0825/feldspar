#include "haptic.h"
#include <stdio.h>
#include "esp_log.h"
#include "driver/ledc.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "nvs.h"

static const char *TAG = "haptic";
#define ERM_SIG_GPIO GPIO_NUM_42
#define ERM_MAX_DUTY 2047
#define ERM_LEDC_CHANNEL LEDC_CHANNEL_4
#define ERM_LEDC_TIMER LEDC_TIMER_1
#define RECORD_MAGIC 0x48415031u

static bool s_erm_inited;
static volatile bool s_commanded_active;
static SemaphoreHandle_t s_lock;
static esp_timer_handle_t s_timer;
static nvs_handle_t s_nvs;
static bool s_storage_ready;
static ag_guard_t s_guard;
static ag_result_t s_result = AG_STOPPED;
static uint32_t s_manual_sequence;
typedef struct { uint32_t magic; ag_checkpoint_t checkpoint; } safety_record_t;

static uint64_t now_ms(void) { return (uint64_t)esp_timer_get_time() / 1000; }

static bool save_checkpoint(void *context, const ag_checkpoint_t *checkpoint) {
    (void)context;
    if (!s_storage_ready) return false;
    safety_record_t record = {0};
    record.magic = RECORD_MAGIC;
    record.checkpoint = *checkpoint;
    return nvs_set_blob(s_nvs, "guard", &record, sizeof(record)) == ESP_OK && nvs_commit(s_nvs) == ESP_OK;
}

/* The only PWM writer. Call with s_lock held. */
static esp_err_t apply_output(void) {
    esp_err_t err = ledc_set_duty(LEDC_LOW_SPEED_MODE, ERM_LEDC_CHANNEL,
                                (uint32_t)s_guard.percent * ERM_MAX_DUTY / 100);
    if (err == ESP_OK) err = ledc_update_duty(LEDC_LOW_SPEED_MODE, ERM_LEDC_CHANNEL);
    if (err != ESP_OK) {
        s_guard.active = false;
        s_guard.percent = 0;
        s_guard.stop_latched = true;
        s_guard.budget_restored = false;
        s_result = AG_UNSAFE;
        ledc_set_duty(LEDC_LOW_SPEED_MODE, ERM_LEDC_CHANNEL, 0);
        ledc_update_duty(LEDC_LOW_SPEED_MODE, ERM_LEDC_CHANNEL);
    }
    s_commanded_active = err == ESP_OK && s_guard.active && s_guard.percent != 0;
    return err;
}

/* Independent of audio/BLE/MQTT task progress. Never writes NVS. */
static void cutoff_tick(void *arg) {
    (void)arg;
    if (!s_erm_inited || xSemaphoreTake(s_lock, 0) != pdTRUE) return;
    bool active = s_guard.active;
    ag_tick(&s_guard, now_ms());
    if (active && !s_guard.active) {
        s_result = AG_STOPPED;
        apply_output();
    }
    xSemaphoreGive(s_lock);
}

esp_err_t haptic_erm_init(void) {
    if (s_erm_inited) return ESP_OK;
    ledc_timer_config_t timer = {.speed_mode=LEDC_LOW_SPEED_MODE, .timer_num=ERM_LEDC_TIMER,
        .freq_hz=20000, .duty_resolution=LEDC_TIMER_11_BIT, .clk_cfg=LEDC_AUTO_CLK};
    esp_err_t err = ledc_timer_config(&timer);
    if (err != ESP_OK) return err;
    ledc_channel_config_t channel = {.gpio_num=ERM_SIG_GPIO, .speed_mode=LEDC_LOW_SPEED_MODE,
        .channel=ERM_LEDC_CHANNEL, .timer_sel=ERM_LEDC_TIMER, .intr_type=LEDC_INTR_DISABLE,
        .hpoint=0, .duty=0};
    err = ledc_channel_config(&channel);
    if (err != ESP_OK) return err;
    s_lock = xSemaphoreCreateMutex();
    if (!s_lock) return ESP_ERR_NO_MEM;
    /* Legacy manual range + documented 10 s engineering ceiling, not a
     * validated physical profile. No automatic actuation is enabled. */
    ag_init(&s_guard, (ag_policy_t){.max_percent=100, .max_duration_ms=10000,
        .cooldown_ms=60000, .max_per_night=0, .automatic_enabled=false,
        .profile_validated=false}, save_checkpoint, NULL);
    s_guard.stop_latched = true;
    s_guard.checkpoint.stop_latched = true;
    s_storage_ready = nvs_open("haptic_safety", NVS_READWRITE, &s_nvs) == ESP_OK;
    safety_record_t record = {0};
    size_t size = sizeof(record);
    if (s_storage_ready && nvs_get_blob(s_nvs, "guard", &record, &size) == ESP_OK &&
        size == sizeof(record) && record.magic == RECORD_MAGIC)
        ag_restore(&s_guard, &record.checkpoint, now_ms());
    esp_timer_create_args_t args = {.callback=cutoff_tick, .name="haptic_cutoff"};
    err = esp_timer_create(&args, &s_timer);
    if (err != ESP_OK) return err;
    err = esp_timer_start_periodic(s_timer, 20000);
    if (err != ESP_OK) return err;
    s_erm_inited = true;
    ESP_LOGI(TAG, "bounded manual control ready; automatic disabled; stopped=%d", s_guard.stop_latched);
    return ESP_OK;
}

esp_err_t haptic_execute(const ag_request_t *request) {
    if (!s_erm_inited) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    ag_tick(&s_guard, now_ms());
    if (apply_output() != ESP_OK) {
        xSemaphoreGive(s_lock);
        return ESP_FAIL;
    }
    s_result = ag_start(&s_guard, request, now_ms());
    esp_err_t err = apply_output();
    ag_result_t result = s_result;
    xSemaphoreGive(s_lock);
    return err != ESP_OK ? err : result == AG_OK ? ESP_OK : ESP_ERR_INVALID_STATE;
}

esp_err_t haptic_erm_set(uint8_t percent) {
    if (!s_erm_inited) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    uint64_t now = now_ms();
    ag_tick(&s_guard, now);
    if (!percent) {
        ag_stop(&s_guard, now, false);
        s_result = AG_OK;
    } else if (s_guard.active && s_guard.source == AG_MANUAL) {
        s_result = ag_adjust_manual(&s_guard, percent);
    } else {
        char id[32];
        snprintf(id, sizeof(id), "manual-%lu", (unsigned long)++s_manual_sequence);
        ag_request_t request = {.source=AG_MANUAL, .command_id=id, .percent=percent,
            .duration_ms=10000, .expires_ms=now+1000};
        s_result = ag_start(&s_guard, &request, now);
    }
    esp_err_t err = apply_output();
    ag_result_t result = s_result;
    xSemaphoreGive(s_lock);
    return err != ESP_OK ? err : result == AG_OK ? ESP_OK : ESP_ERR_INVALID_STATE;
}

esp_err_t haptic_emergency_stop(void) {
    if (!s_erm_inited) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    /* Disable PWM before any flash write. */
    s_guard.percent = 0;
    esp_err_t err = apply_output();
    ag_stop(&s_guard, now_ms(), true);
    s_result = err == ESP_OK ? AG_STOPPED : AG_UNSAFE;
    xSemaphoreGive(s_lock);
    return err;
}

esp_err_t haptic_resume_manual(void) {
    if (!s_erm_inited) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_result = ag_resume(&s_guard);
    ag_result_t result = s_result;
    xSemaphoreGive(s_lock);
    return result == AG_OK ? ESP_OK : ESP_ERR_INVALID_STATE;
}

bool haptic_is_active(void) { return s_commanded_active; }

bool haptic_stop_latched(void) {
    if (!s_erm_inited) return true;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    bool stopped = s_guard.stop_latched;
    xSemaphoreGive(s_lock);
    return stopped;
}

void haptic_status_line(char *out, size_t size) {
    if (!s_erm_inited) { snprintf(out, size, "HAPTIC,unavailable,0,0,0,1"); return; }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    uint64_t now = now_ms();
    ag_tick(&s_guard, now);
    apply_output();
    unsigned long remaining = s_guard.active ? (unsigned long)(s_guard.deadline_ms-now) : 0;
    snprintf(out, size, "HAPTIC,%s,%u,%u,%lu,%u", ag_result_name(s_result),
        s_guard.active, s_guard.percent, remaining, s_guard.stop_latched);
    xSemaphoreGive(s_lock);
}
