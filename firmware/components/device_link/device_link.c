#include "device_link.h"
#include "link_frames.h"
#include "mqtt_mgr.h"
#include "haptic.h"
#include "device_control.h"
#include "esp_timer.h"
#include "esp_random.h"
#include "esp_app_desc.h"
#include "esp_netif_sntp.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "cJSON.h"
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>

static QueueHandle_t s_features, s_commands;
static bool s_enabled;
static bool s_clock_synced;
static portMUX_TYPE s_clock_lock=portMUX_INITIALIZER_UNLOCKED;
static volatile uint32_t s_dropped;
static int64_t s_sync_us;
static char s_topic[192], s_session[24], s_last_id[65], s_last_ack[512];
static link_frame_t s_frame;
static uint32_t s_snapshot_sequence;

static bool clock_valid(void) {
    portENTER_CRITICAL(&s_clock_lock);
    bool synced=s_clock_synced;
    int64_t last=s_sync_us;
    portEXIT_CRITICAL(&s_clock_lock);
    int64_t elapsed=esp_timer_get_time()-last;
    return synced && elapsed>=0 && elapsed<86400000000LL;
}
static uint64_t utc_ms(void) {
    struct timeval tv; gettimeofday(&tv,NULL);
    return (uint64_t)tv.tv_sec*1000+(uint64_t)tv.tv_usec/1000;
}
static void clock_sync(struct timeval *tv) {
    (void)tv;
    portENTER_CRITICAL(&s_clock_lock);
    s_sync_us=esp_timer_get_time(); s_clock_synced=true;
    portEXIT_CRITICAL(&s_clock_lock);
}
static void ready(void) { mqtt_mgr_subscribe(s_topic); }
static void incoming(const char *topic, int topic_len, const char *data, int length,
                     int total, int offset, bool retained) {
    if (!s_enabled) return;
    lf_result_t result=link_frame_push(&s_frame,s_topic,topic,topic_len,data,length,total,offset,retained);
    if (result==LF_COMPLETE && xQueueSend(s_commands,s_frame.data,0)!=pdTRUE) ++s_dropped;
}
static void publish_json(const char *channel, cJSON *object) {
    char topic[192];
    snprintf(topic,sizeof(topic),"snoozmate/v1/devices/%s/%s/up",mqtt_mgr_device_id(),channel);
    char *json=cJSON_PrintUnformatted(object);
    if (!json || strlen(json)>2048 || mqtt_mgr_publish(topic,json,(int)strlen(json))!=ESP_OK) ++s_dropped;
    cJSON_free(json);
    cJSON_Delete(object);
}
static void publish_features(const af_features_t *f) {
    uint64_t now=(uint64_t)esp_timer_get_time()/1000;
    bool timed=clock_valid() && f->monotonic_end_ms<=now;
    cJSON *p=cJSON_CreateObject();
    cJSON_AddStringToObject(p,"protocol_version",AF_VERSION);
    cJSON_AddStringToObject(p,"device_id",mqtt_mgr_device_id());
    cJSON_AddStringToObject(p,"session_id",s_session);
    cJSON_AddNumberToObject(p,"sequence",f->sequence);
    cJSON_AddNumberToObject(p,"timestamp_ms",timed ? (double)(utc_ms()-(now-f->monotonic_end_ms)) : 0);
    cJSON_AddNumberToObject(p,"monotonic_end_ms",(double)f->monotonic_end_ms);
    cJSON_AddBoolToObject(p,"clock_valid",timed);
    cJSON_AddNumberToObject(p,"sample_rate",16000);
    cJSON_AddNumberToObject(p,"sample_count",AF_SAMPLES);
    cJSON_AddNumberToObject(p,"window_ms",1000);
    cJSON_AddNumberToObject(p,"context_blocks",f->context_blocks);
    cJSON_AddNumberToObject(p,"quality_flags",f->quality_flags);
    cJSON_AddNumberToObject(p,"rms",f->rms);
    cJSON_AddNumberToObject(p,"clipped_ratio",f->clipped_ratio);
    cJSON_AddNumberToObject(p,"band_ratio",f->band_ratio);
    cJSON_AddNumberToObject(p,"volume_ratio",f->volume_ratio);
    cJSON_AddNumberToObject(p,"periodicity",f->periodicity);
    publish_json("features",p);
}
static void telemetry(const af_features_t *features) {
    cJSON *p=cJSON_CreateObject();
    cJSON_AddStringToObject(p,"device_id",mqtt_mgr_device_id());
    cJSON_AddStringToObject(p,"session_id",s_session);
    cJSON_AddNumberToObject(p,"sequence",++s_snapshot_sequence);
    cJSON_AddNumberToObject(p,"device_time",clock_valid() ? (double)(utc_ms()/1000) : 0);
    cJSON_AddBoolToObject(p,"clock_valid",clock_valid());
    bool stopped=haptic_stop_latched();
    cJSON_AddBoolToObject(p,"stop_latched",stopped);
    cJSON_AddBoolToObject(p,"manual_active",haptic_is_active());
    cJSON_AddStringToObject(p,"state",stopped ? "SAFETY_LOCKED" : "MONITORING");
    cJSON_AddStringToObject(p,"firmware_version",esp_app_get_description()->version);
    cJSON_AddStringToObject(p,"feature_version",AF_VERSION);
    cJSON_AddStringToObject(p,"model_version","");
    cJSON_AddNullToObject(p,"in_bed");
    cJSON_AddNullToObject(p,"body_motion_level");
    cJSON_AddNullToObject(p,"temperature_ok");
    cJSON_AddStringToObject(p,"radar_status","not_installed");
    cJSON_AddStringToObject(p,"pad_status","unknown");
    cJSON_AddStringToObject(p,"mic_status",features && !features->quality_flags ? "ready" : "calibrating");
    if (features) cJSON_AddNumberToObject(p,"feature_quality_flags",features->quality_flags);
    cJSON *cap=cJSON_AddObjectToObject(p,"capabilities");
    cJSON_AddNumberToObject(cap,"actuation_guard",1);
    cJSON_AddNumberToObject(cap,"microphone_count",1);
    cJSON_AddBoolToObject(cap,"automatic_enabled",false);
    cJSON_AddBoolToObject(cap,"local_model",false);
    cJSON_AddBoolToObject(cap,"radar_driver",false);
    cJSON_AddBoolToObject(cap,"pad_detection",false);
    cJSON_AddNumberToObject(cap,"feature_queue_dropped",s_dropped);
    publish_json("telemetry",p);
}
static bool valid_id(const char *id) {
    if (!id || !id[0] || strlen(id)>64) return false;
    for (const char *p=id;*p;++p)
        if (!((*p>='a' && *p<='z') || (*p>='A' && *p<='Z') || (*p>='0' && *p<='9') || *p=='_' || *p=='-')) return false;
    return true;
}
static void command(const char *json) {
    cJSON *p=cJSON_ParseWithOpts(json,NULL,true);
    if (!cJSON_IsObject(p)) { cJSON_Delete(p); return; }
    const cJSON *id=cJSON_GetObjectItemCaseSensitive(p,"command_id");
    const cJSON *type=cJSON_GetObjectItemCaseSensitive(p,"type");
    const cJSON *target=cJSON_GetObjectItemCaseSensitive(p,"device_id");
    if (!cJSON_IsString(id) || !valid_id(id->valuestring) || !cJSON_IsString(type) ||
        (target && (!cJSON_IsString(target) || strcmp(target->valuestring,mqtt_mgr_device_id())))) goto done;
    if (!strcmp(id->valuestring,s_last_id)) {
        char topic[192]; snprintf(topic,sizeof(topic),"snoozmate/v1/devices/%s/acks/up",mqtt_mgr_device_id());
        mqtt_mgr_publish(topic,s_last_ack,(int)strlen(s_last_ack));
        goto done;
    }
    const char *status="rejected", *error="NOT_IMPLEMENTED";
    const cJSON *expires=cJSON_GetObjectItemCaseSensitive(p,"expires_at");
    bool stop=!strcmp(type->valuestring,"stop_intervention") || !strcmp(type->valuestring,"stop_all");
    if (clock_valid() && (!cJSON_IsNumber(expires) || !isfinite(expires->valuedouble) ||
        floor(expires->valuedouble)!=expires->valuedouble || expires->valuedouble<=(double)(utc_ms()/1000))) {
        error="COMMAND_EXPIRED";
    } else if (stop) {
        /* Stop is safe even before wall clock sync; it never enables output. */
        bool global=!strcmp(type->valuestring,"stop_all");
        bool ok=(global ? device_control_stop_all() : haptic_emergency_stop())==ESP_OK;
        status=ok ? "applied" : "failed"; error=ok ? "" : "DRIVER_STOP_FAILED";
    } else if (!clock_valid()) {
        error="CLOCK_UNKNOWN";
    } else if (!strcmp(type->valuestring,"cloud_intervention")) {
        error="AUTOMATIC_DISABLED";
    }
    cJSON *ack=cJSON_CreateObject();
    cJSON_AddStringToObject(ack,"command_id",id->valuestring);
    cJSON_AddStringToObject(ack,"status",status);
    cJSON_AddStringToObject(ack,"error_code",error);
    cJSON *readback=cJSON_AddObjectToObject(ack,"readback");
    cJSON_AddBoolToObject(readback,"stop_latched",haptic_stop_latched());
    cJSON_AddBoolToObject(readback,"physical_feedback",false);
    if (stop && !strcmp(status,"applied")) cJSON_AddNumberToObject(readback,"vibration_level",0);
    if (stop && !strcmp(status,"applied") && !strcmp(type->valuestring,"stop_all"))
        cJSON_AddBoolToObject(readback,"outputs_stopped",true);
    char *text=cJSON_PrintUnformatted(ack);
    if (text && strlen(text)<sizeof(s_last_ack)) {
        strcpy(s_last_id,id->valuestring); strcpy(s_last_ack,text);
        char topic[192]; snprintf(topic,sizeof(topic),"snoozmate/v1/devices/%s/acks/up",mqtt_mgr_device_id());
        if (mqtt_mgr_publish(topic,text,(int)strlen(text))!=ESP_OK) ++s_dropped;
    }
    cJSON_free(text); cJSON_Delete(ack);
    telemetry(NULL);
done:
    cJSON_Delete(p);
}
static void worker(void *context) {
    (void)context;
    char json[LINK_COMMAND_MAX+1];
    af_features_t features;
    int64_t last_report=0;
    for (;;) {
        if (xQueueReceive(s_commands,json,0)==pdTRUE) command(json);
        if (xQueueReceive(s_features,&features,pdMS_TO_TICKS(100))==pdTRUE) {
            publish_features(&features);
            telemetry(&features);
            last_report=esp_timer_get_time();
        } else if (esp_timer_get_time()-last_report>=5000000) {
            telemetry(NULL); last_report=esp_timer_get_time();
        }
    }
}
bool device_link_enabled(void) { return s_enabled; }
bool device_link_enqueue_features(const af_features_t *features) {
    if (!s_enabled || !features) return false;
    if (xQueueSend(s_features,features,0)==pdTRUE) return true;
    ++s_dropped; return false;
}
esp_err_t device_link_init(void) {
    const char *id=mqtt_mgr_device_id();
    if (!id || !id[0]) return ESP_OK; /* default: no structured uplink */
    s_features=xQueueCreate(4,sizeof(af_features_t));
    s_commands=xQueueCreate(4,LINK_COMMAND_MAX+1);
    if (!s_features || !s_commands) return ESP_ERR_NO_MEM;
    snprintf(s_session,sizeof(s_session),"%08lx%08lx",(unsigned long)esp_random(),(unsigned long)esp_random());
    snprintf(s_topic,sizeof(s_topic),"snoozmate/v1/devices/%s/commands/down",id);
    esp_sntp_config_t clock=ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    clock.sync_cb=clock_sync;
    esp_netif_sntp_init(&clock); /* failure leaves clock_valid false */
    if (xTaskCreate(worker,"device_link",6144,NULL,3,NULL)!=pdPASS) return ESP_ERR_NO_MEM;
    s_enabled=true;
    mqtt_mgr_set_message_cb(incoming);
    mqtt_mgr_set_ready_cb(ready);
    if (mqtt_mgr_is_connected()) ready();
    return ESP_OK;
}
