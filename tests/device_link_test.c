#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include "../firmware/components/device_link/device_link.c"
#include "lighting.h"
#include "audio.h"
#include "sfx.h"

static bool configured, connected=true, stopped=true, queue_full;
static bool light_enabled, light_breathing;
static uint8_t light_r, light_g, light_b;
static int sound_track, pending_track;
static uint8_t sound_volume, sound_timer;
static bool vibration_active;
static unsigned vibration_starts;
static uint64_t fake_utc_ms=1001000;
static int64_t fake_us=1000000;
static unsigned queue_count, published_acks, global_stops, motor_stops;
static char ack[2048], feature_json[2048], queued_command[LINK_COMMAND_MAX+1];
static mqtt_message_cb_t message_callback;
static void (*ready_callback)(void);

const char *mqtt_mgr_device_id(void) { return configured ? "test" : ""; }
bool mqtt_mgr_is_connected(void) { return connected; }
void mqtt_mgr_set_message_cb(mqtt_message_cb_t cb) { message_callback=cb; }
void mqtt_mgr_set_ready_cb(void (*cb)(void)) { ready_callback=cb; }
esp_err_t mqtt_mgr_subscribe(const char *topic) {
    assert(!strcmp(topic,"snoozmate/v1/devices/test/commands/down")); return ESP_OK;
}
esp_err_t mqtt_mgr_publish(const char *topic,const char *data,int length) {
    assert(length>=0 && length<2048);
    if (strstr(topic,"/acks/")) { memcpy(ack,data,(size_t)length); ack[length]=0; ++published_acks; }
    if (strstr(topic,"/features/")) { memcpy(feature_json,data,(size_t)length); feature_json[length]=0; }
    return connected ? ESP_OK : ESP_FAIL;
}
bool haptic_is_active(void) { return vibration_active; }
bool haptic_stop_latched(void) { return stopped; }
esp_err_t haptic_execute(const ag_request_t *request) {
    assert(request->source==AG_MANUAL_TEST && request->percent==50 && request->duration_ms==2000);
    if (stopped || vibration_active) return ESP_ERR_INVALID_STATE;
    ++vibration_starts; vibration_active=true; return ESP_OK;
}
esp_err_t haptic_emergency_stop(void) { ++motor_stops; stopped=true; return ESP_OK; }
esp_err_t device_control_stop_all(void) { ++global_stops; stopped=true; return ESP_OK; }
esp_err_t lighting_set_enabled(bool enabled) { light_enabled=enabled; light_breathing=false; return ESP_OK; }
esp_err_t lighting_set_rgb(uint8_t r, uint8_t g, uint8_t b) {
    light_r=r; light_g=g; light_b=b; light_enabled=true; light_breathing=false; return ESP_OK;
}
esp_err_t lighting_set_breathing(uint8_t r, uint8_t g, uint8_t b) {
    lighting_set_rgb(r,g,b); light_breathing=true; return ESP_OK;
}
void lighting_get_output(uint8_t *r, uint8_t *g, uint8_t *b, bool *enabled, bool *breathing) {
    if (r) *r=light_r;
    if (g) *g=light_g;
    if (b) *b=light_b;
    if (enabled) *enabled=light_enabled;
    if (breathing) *breathing=light_breathing;
}
int sfx_count(void) { return 1; }
bool sfx_info(int index, char *name, size_t length, uint32_t *size, uint8_t *format) {
    (void)size; (void)format;
    if (index!=1) return false;
    snprintf(name,length,"sleep"); return true;
}
int sfx_current(void) { return sound_track; }
esp_err_t sfx_play_timed(int index, uint8_t minutes) { pending_track=index; sound_timer=minutes; return ESP_OK; }
esp_err_t sfx_set_timer(uint8_t minutes) { sound_timer=minutes; return ESP_OK; }
uint16_t sfx_timer_state(uint8_t *minutes) { *minutes=sound_timer; return sound_timer*60; }
esp_err_t sfx_stop(void) { pending_track=sound_track=0; return ESP_OK; }
esp_err_t audio_stop(void) { return ESP_OK; }
esp_err_t audio_set_volume(uint8_t volume) { sound_volume=volume; return ESP_OK; }
uint8_t audio_get_volume(void) { return sound_volume; }
audio_state_t audio_get_state(void) { return sound_track ? AUDIO_STATE_PLAYING : AUDIO_STATE_STOPPED; }
int64_t esp_timer_get_time(void) { return fake_us; }
int gettimeofday(struct timeval *tv, void *zone) {
    (void)zone; tv->tv_sec=(long)(fake_utc_ms/1000); tv->tv_usec=(int)(fake_utc_ms%1000)*1000; return 0;
}
uint32_t esp_random(void) { static uint32_t value; return ++value; }
const esp_app_desc_t *esp_app_get_description(void) { static esp_app_desc_t desc={.version="host-fixture"}; return &desc; }
esp_err_t esp_netif_sntp_init(const esp_sntp_config_t *config) { assert(config->sync_cb); return ESP_OK; }
QueueHandle_t xQueueCreate(unsigned count,unsigned size) {
    assert(count==4 && (size==sizeof(af_features_t) || size==LINK_COMMAND_MAX+1));
    return (void *)(uintptr_t)++queue_count;
}
int xQueueSend(QueueHandle_t queue,const void *item,uint32_t timeout) {
    assert(timeout==0);
    if (queue_full) return 0;
    if (queue==s_commands) memcpy(queued_command,item,sizeof(queued_command));
    return pdTRUE;
}
int xQueueReceive(QueueHandle_t queue,void *item,uint32_t timeout) {
    (void)queue; (void)item; (void)timeout; return 0;
}
int xTaskCreate(void (*fn)(void *),const char *name,unsigned stack,void *context,unsigned priority,void *handle) {
    (void)name; (void)context; (void)priority; (void)handle;
    assert(fn && stack>=6144); return pdPASS;
}
static const char *ack_value(const char *key) {
    static char value[128];
    cJSON *object=cJSON_Parse(ack);
    cJSON *item=cJSON_GetObjectItemCaseSensitive(object,key);
    assert(cJSON_IsString(item));
    snprintf(value,sizeof(value),"%s",item->valuestring);
    cJSON_Delete(object); return value;
}

int main(int argc,char **argv) {
    assert(device_link_init()==ESP_OK && !device_link_enabled() && queue_count==0);
    configured=true;
    assert(device_link_init()==ESP_OK && device_link_enabled() && message_callback && ready_callback);
    af_features_t features={.sequence=1,.monotonic_end_ms=1000,.rms=.1f,.band_ratio=.9f,
        .volume_ratio=4,.periodicity=.9f,.context_blocks=300};
    assert(device_link_enqueue_features(&features));
    queue_full=true;
    assert(!device_link_enqueue_features(&features));
    queue_full=false;
    publish_features(&features);
    cJSON *object=cJSON_Parse(feature_json);
    assert(cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(object,"clock_valid")));
    cJSON_Delete(object);
    clock_sync(NULL);
    publish_features(&features);
    if (argc==2 && !strcmp(argv[1],"--features")) { puts(feature_json); return 0; }
    object=cJSON_Parse(feature_json);
    assert(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(object,"clock_valid")));
    assert(cJSON_GetObjectItemCaseSensitive(object,"timestamp_ms")->valuedouble==1001000);
    cJSON_Delete(object);
    const char *stop="{\"command_id\":\"stop_1\",\"type\":\"stop_all\",\"expires_at\":1061}";
    int length=(int)strlen(stop), topic_len=(int)strlen(s_topic);
    message_callback(s_topic,topic_len,stop,10,length,0,false);
    message_callback(NULL,0,stop+10,length-10,length,10,false);
    command(queued_command);
    assert(global_stops==1 && !strcmp(ack_value("status"),"applied"));
    object=cJSON_Parse(ack);
    assert(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(cJSON_GetObjectItemCaseSensitive(object,"readback"),"outputs_stopped")));
    cJSON_Delete(object);
    command(stop);
    assert(global_stops==1 && published_acks==2);
    command("{\"command_id\":\"old\",\"type\":\"stop_all\",\"expires_at\":1}");
    assert(!strcmp(ack_value("error_code"),"COMMAND_EXPIRED") && global_stops==1);
    command("{\"command_id\":\"auto\",\"type\":\"cloud_intervention\",\"expires_at\":1061}");
    assert(!strcmp(ack_value("error_code"),"AUTOMATIC_DISABLED") && global_stops==1);
    command("{\"command_id\":\"light_locked\",\"type\":\"set_light\",\"expires_at\":1010,"
            "\"payload\":{\"patch\":{\"enabled\":true},\"light\":{\"enabled\":true,\"brightness\":25,\"mode\":\"night-low\",\"color\":\"amber\"}}}");
    assert(!light_enabled && !strcmp(ack_value("error_code"),"DEVICE_STOPPED"));
    stopped=false;
    command("{\"command_id\":\"light_start\",\"type\":\"set_light\",\"expires_at\":1010,"
            "\"payload\":{\"patch\":{\"enabled\":true},\"light\":{\"enabled\":true,\"brightness\":25,\"mode\":\"bedtime-breathe\",\"color\":\"amber\"}}}");
    assert(light_enabled && light_breathing && light_r==25 && light_g==13 && light_b==3);
    assert(!strcmp(ack_value("status"),"applied"));
    command("{\"command_id\":\"light_off\",\"type\":\"set_light\",\"expires_at\":1010,"
            "\"payload\":{\"patch\":{\"enabled\":false},\"light\":{\"enabled\":false,\"brightness\":25,\"mode\":\"night-low\",\"color\":\"amber\"}}}");
    assert(!light_enabled && !strcmp(ack_value("status"),"applied"));
    command("{\"command_id\":\"light_stale\",\"type\":\"set_light\",\"expires_at\":1010,"
            "\"payload\":{\"patch\":{\"brightness\":30},\"light\":{\"enabled\":true,\"brightness\":30,\"mode\":\"night-low\",\"color\":\"amber\"}}}");
    assert(!light_enabled && !strcmp(ack_value("error_code"),"LIGHT_STATE_CHANGED"));
    unsigned prior_sound_acks=published_acks;
    command("{\"command_id\":\"sound_start\",\"type\":\"set_sound\",\"expires_at\":1010,"
            "\"payload\":{\"patch\":{\"playing\":true},\"sound\":{\"playing\":true,\"volume\":32,\"scene\":\"sleep\",\"timer\":30}}}");
    assert(pending_track==1 && sound_track==0 && published_acks==prior_sound_acks);
    poll_sound_result();
    assert(published_acks==prior_sound_acks);
    sound_track=pending_track;
    poll_sound_result();
    assert(published_acks==prior_sound_acks+1 && !strcmp(ack_value("status"),"applied"));
    command("{\"command_id\":\"sound_off\",\"type\":\"set_sound\",\"expires_at\":1010,"
            "\"payload\":{\"patch\":{\"playing\":false},\"sound\":{\"playing\":false,\"volume\":32,\"scene\":\"sleep\",\"timer\":30}}}");
    assert(sound_track==0 && !strcmp(ack_value("status"),"applied"));
    char trial[256];
    snprintf(trial,sizeof(trial),"{\"command_id\":\"trial_1\",\"type\":\"vibration_test\",\"expires_at\":1006,\"payload\":{\"session_id\":\"%s\"}}",s_session);
    command(trial);
    assert(vibration_starts==1 && !strcmp(ack_value("status"),"applied"));
    command(trial);
    assert(vibration_starts==1);
    unsigned before=published_acks;
    command("{\"command_id\":\"wrong\",\"type\":\"stop_all\",\"device_id\":\"other\"}");
    command("{}garbage");
    assert(published_acks==before);
    command("{\"command_id\":\"cycle\",\"type\":\"stop_intervention\",\"expires_at\":1061}");
    assert(motor_stops==1 && global_stops==1);
    s_clock_synced=false;
    command("{\"command_id\":\"clockless\",\"type\":\"stop_all\"}");
    assert(global_stops==2);
    fake_us+=86400000001LL;
    assert(!clock_valid());
    puts("Device-link JSON, command/ACK, clock and opt-in checks passed (stub transport).");
}
