#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include "../firmware/components/device_link/device_link.c"

static bool configured, connected=true, stopped=true, queue_full;
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
bool haptic_is_active(void) { return false; }
bool haptic_stop_latched(void) { return stopped; }
esp_err_t haptic_emergency_stop(void) { ++motor_stops; stopped=true; return ESP_OK; }
esp_err_t device_control_stop_all(void) { ++global_stops; stopped=true; return ESP_OK; }
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
