#include "device_link.h"
#include "link_frames.h"
#include "mqtt_mgr.h"
#include "haptic.h"
#include "device_control.h"
#include "lighting.h"
#include "audio.h"
#include "sfx.h"
#include "esp_timer.h"
#include "esp_random.h"
#include "esp_app_desc.h"
#include "esp_netif_sntp.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "cJSON.h"
#include <ctype.h>
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
static struct {
    char id[65];
    const char *scene;
    int track;
    uint8_t volume, timer;
    int64_t deadline_us;
} s_sound_pending;
static struct { char id[65]; int64_t until_us; } s_manual_commands[16];

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
    uint8_t r,g,b;
    bool on,breathing;
    lighting_get_output(&r,&g,&b,&on,&breathing);
    cJSON *light=cJSON_AddObjectToObject(p,"light_output");
    cJSON_AddBoolToObject(light,"enabled",on);
    cJSON_AddNumberToObject(light,"r",r);
    cJSON_AddNumberToObject(light,"g",g);
    cJSON_AddNumberToObject(light,"b",b);
    cJSON_AddStringToObject(light,"mode",breathing ? "bedtime-breathe" : "night-low");
    cJSON *cap=cJSON_AddObjectToObject(p,"capabilities");
    cJSON_AddNumberToObject(cap,"actuation_guard",1);
    cJSON_AddNumberToObject(cap,"microphone_count",1);
    cJSON_AddBoolToObject(cap,"automatic_enabled",false);
    cJSON_AddBoolToObject(cap,"local_model",false);
    cJSON_AddBoolToObject(cap,"radar_driver",false);
    cJSON_AddBoolToObject(cap,"pad_detection",false);
    cJSON_AddBoolToObject(cap,"cloud_light_control",true);
    cJSON_AddBoolToObject(cap,"cloud_sound_control",true);
    cJSON_AddBoolToObject(cap,"short_sound_timer",true);
    cJSON_AddBoolToObject(cap,"cloud_vibration_test",true);
    uint8_t timer=0;
    uint16_t remaining=sfx_timer_state(&timer);
    cJSON *sound=cJSON_AddObjectToObject(p,"sound_output");
    cJSON_AddBoolToObject(sound,"playing",audio_get_state()==AUDIO_STATE_PLAYING);
    cJSON_AddBoolToObject(sound,"paused",audio_get_state()==AUDIO_STATE_PAUSED);
    cJSON_AddNumberToObject(sound,"volume",audio_get_volume());
    cJSON_AddNumberToObject(sound,"timer_minutes",timer);
    cJSON_AddNumberToObject(sound,"remaining_seconds",remaining);
    cJSON_AddNumberToObject(cap,"feature_queue_dropped",s_dropped);
    publish_json("telemetry",p);
}
static bool valid_id(const char *id) {
    if (!id || !id[0] || strlen(id)>64) return false;
    for (const char *p=id;*p;++p)
        if (!((*p>='a' && *p<='z') || (*p>='A' && *p<='Z') || (*p>='0' && *p<='9') || *p=='_' || *p=='-')) return false;
    return true;
}

static const char *apply_manual_light(const cJSON *payload, cJSON **readback) {
    const cJSON *patch=cJSON_GetObjectItemCaseSensitive(payload,"patch");
    const cJSON *light=cJSON_GetObjectItemCaseSensitive(payload,"light");
    const cJSON *enabled=cJSON_GetObjectItemCaseSensitive(light,"enabled");
    const cJSON *brightness=cJSON_GetObjectItemCaseSensitive(light,"brightness");
    const cJSON *mode=cJSON_GetObjectItemCaseSensitive(light,"mode");
    const cJSON *color=cJSON_GetObjectItemCaseSensitive(light,"color");
    if (!cJSON_IsObject(patch) || !patch->child || !cJSON_IsBool(enabled) ||
        !cJSON_IsNumber(brightness) || !isfinite(brightness->valuedouble) ||
        brightness->valuedouble<5 || brightness->valuedouble>40 ||
        floor(brightness->valuedouble)!=brightness->valuedouble ||
        !cJSON_IsString(mode) || (strcmp(mode->valuestring,"night-low") &&
                                 strcmp(mode->valuestring,"bedtime-breathe")) ||
        !cJSON_IsString(color) || strcmp(color->valuestring,"amber")) return "INVALID_LIGHT_COMMAND";

    bool desired_on=cJSON_IsTrue(enabled), current_on=false;
    const cJSON *switch_patch=cJSON_GetObjectItemCaseSensitive(patch,"enabled");
    if (switch_patch && (!cJSON_IsBool(switch_patch) || cJSON_IsTrue(switch_patch)!=desired_on))
        return "INVALID_LIGHT_COMMAND";
    lighting_get_output(NULL,NULL,NULL,&current_on,NULL);
    /* A brightness or mode edit must not turn on a lamp whose state changed. */
    if (!switch_patch && current_on!=desired_on) return "LIGHT_STATE_CHANGED";
    if (desired_on && haptic_stop_latched()) return "DEVICE_STOPPED";

    uint8_t r=(uint8_t)brightness->valueint, g=(uint8_t)((r*132+127)/255), b=(uint8_t)((r*34+127)/255);
    bool breathe=!strcmp(mode->valuestring,"bedtime-breathe");
    esp_err_t result=desired_on
        ? (breathe ? lighting_set_breathing(r,g,b) : lighting_set_rgb(r,g,b))
        : (current_on ? lighting_set_enabled(false) : ESP_OK);
    if (result!=ESP_OK) return "LIGHT_DRIVER_FAILED";
    uint8_t actual_r,actual_g,actual_b;
    bool actual_on,actual_breathe;
    lighting_get_output(&actual_r,&actual_g,&actual_b,&actual_on,&actual_breathe);
    if (actual_on!=desired_on || (actual_on && (actual_breathe!=breathe ||
        actual_r!=r || actual_g!=g || actual_b!=b))) return "READBACK_MISMATCH";

    *readback=cJSON_CreateObject();
    if (!*readback) return "READBACK_UNAVAILABLE";
    cJSON_AddBoolToObject(*readback,"enabled",actual_on);
    /* With the lamp off, the remaining fields are preferences for the next explicit start. */
    cJSON_AddNumberToObject(*readback,"brightness",actual_on ? actual_r : r);
    cJSON_AddStringToObject(*readback,"mode",mode->valuestring);
    cJSON_AddStringToObject(*readback,"color","amber");
    return "";
}

static const char *const s_scenes[]={"sleep","healing","work","reading"};
static const char *const s_scene_aliases[][8]={
    {"sleep","睡眠","深睡","白噪","安眠","助眠"},
    {"heal","疗愈","愈疗","雨","rain","放松","冥想"},
    {"work","专注","工作","focus","办公"},
    {"read","阅读","读书","看书"},
};

static int find_scene_track(size_t scene) {
    for (int index=1;index<=sfx_count();++index) {
        char name[SFX_NAME_MAX+1];
        if (!sfx_info(index,name,sizeof(name),NULL,NULL)) continue;
        for (char *p=name;*p;++p) *p=(char)tolower((unsigned char)*p);
        for (size_t alias=0;s_scene_aliases[scene][alias];++alias)
            if (strstr(name,s_scene_aliases[scene][alias])) return index;
    }
    return 0;
}

static cJSON *sound_readback(const char *scene, uint8_t timer) {
    cJSON *sound=cJSON_CreateObject();
    if (!sound) return NULL;
    if (scene) cJSON_AddStringToObject(sound,"scene",scene);
    cJSON_AddBoolToObject(sound,"playing",audio_get_state()==AUDIO_STATE_PLAYING);
    cJSON_AddNumberToObject(sound,"volume",audio_get_volume());
    if (timer) cJSON_AddNumberToObject(sound,"timer",timer);
    else cJSON_AddStringToObject(sound,"timer","all-night");
    uint8_t active_timer=0;
    cJSON_AddNumberToObject(sound,"timer_remaining_seconds",sfx_timer_state(&active_timer));
    return sound;
}

static const char *apply_manual_sound(const char *id, const cJSON *payload, cJSON **readback) {
    const cJSON *patch=cJSON_GetObjectItemCaseSensitive(payload,"patch");
    const cJSON *sound=cJSON_GetObjectItemCaseSensitive(payload,"sound");
    const cJSON *volume=cJSON_GetObjectItemCaseSensitive(sound,"volume");
    const cJSON *timer=cJSON_GetObjectItemCaseSensitive(sound,"timer");
    const cJSON *scene=cJSON_GetObjectItemCaseSensitive(sound,"scene");
    const cJSON *playing=cJSON_GetObjectItemCaseSensitive(patch,"playing");
    if (!cJSON_IsObject(patch) || !patch->child || !cJSON_IsNumber(volume) ||
        !isfinite(volume->valuedouble) || volume->valuedouble<0 || volume->valuedouble>100 ||
        floor(volume->valuedouble)!=volume->valuedouble ||
        !cJSON_IsString(scene) || (playing && !cJSON_IsBool(playing))) return "INVALID_SOUND_COMMAND";
    size_t index=0;
    while (index<sizeof(s_scenes)/sizeof(s_scenes[0]) && strcmp(scene->valuestring,s_scenes[index])) ++index;
    if (index==sizeof(s_scenes)/sizeof(s_scenes[0])) return "INVALID_SOUND_COMMAND";
    uint8_t minutes=0;
    if (cJSON_IsNumber(timer) && (timer->valuedouble==1 || timer->valuedouble==15 || timer->valuedouble==30 || timer->valuedouble==60))
        minutes=(uint8_t)timer->valueint;
    else if (!cJSON_IsString(timer) || strcmp(timer->valuestring,"all-night")) return "INVALID_SOUND_COMMAND";
    bool stop=cJSON_IsFalse(playing), scene_patch=cJSON_HasObjectItem(patch,"scene");
    bool was_playing=audio_get_state()==AUDIO_STATE_PLAYING;
    bool start=cJSON_IsTrue(playing) || (!stop && scene_patch && was_playing);
    bool volume_patch=cJSON_HasObjectItem(patch,"volume");
    bool timer_patch=cJSON_HasObjectItem(patch,"timer");
    if (s_sound_pending.id[0]) return "SOUND_BUSY";
    if ((start || (volume_patch && volume->valueint>0)) && haptic_stop_latched()) return "DEVICE_STOPPED";
    int track=(start || scene_patch) ? find_scene_track(index) : 0;
    if ((start || scene_patch) && !track) return "SCENE_NOT_AVAILABLE";
    if ((start || volume_patch) && audio_set_volume((uint8_t)volume->valueint)!=ESP_OK) return "SOUND_DRIVER_FAILED";
    if (stop && (sfx_stop()!=ESP_OK || audio_stop()!=ESP_OK)) return "SOUND_DRIVER_FAILED";
    if (start) {
        if (sfx_play_timed(track,minutes)!=ESP_OK) return "SOUND_DRIVER_FAILED";
        if (haptic_stop_latched()) {
            audio_set_volume(0);
            sfx_stop();
            return "DEVICE_STOPPED";
        }
        strcpy(s_sound_pending.id,id);
        s_sound_pending.scene=s_scenes[index]; s_sound_pending.track=track;
        s_sound_pending.volume=(uint8_t)volume->valueint; s_sound_pending.timer=minutes;
        s_sound_pending.deadline_us=esp_timer_get_time()+2000000;
        return NULL;
    }
    if (timer_patch && was_playing && !stop && sfx_set_timer(minutes)!=ESP_OK) return "SOUND_DRIVER_FAILED";
    if (stop && (sfx_current()!=0 || audio_get_state()!=AUDIO_STATE_STOPPED)) return "READBACK_MISMATCH";
    if (volume_patch && audio_get_volume()!=volume->valueint) return "READBACK_MISMATCH";
    if (audio_get_state()==AUDIO_STATE_PLAYING) sfx_timer_state(&minutes);
    *readback=sound_readback(scene_patch ? s_scenes[index] : NULL,minutes);
    return *readback ? "" : "READBACK_UNAVAILABLE";
}

static void publish_ack(const char *id,const char *status,const char *error,
                        const char *kind,cJSON *output,bool stopped,bool global_stop) {
    cJSON *ack=cJSON_CreateObject();
    cJSON_AddStringToObject(ack,"command_id",id);
    cJSON_AddStringToObject(ack,"status",status);
    cJSON_AddStringToObject(ack,"error_code",error);
    cJSON *readback=cJSON_AddObjectToObject(ack,"readback");
    cJSON_AddBoolToObject(readback,"stop_latched",haptic_stop_latched());
    cJSON_AddBoolToObject(readback,"physical_feedback",false);
    if (output) cJSON_AddItemToObject(readback,kind,output);
    if (stopped) cJSON_AddNumberToObject(readback,"vibration_level",0);
    if (global_stop) cJSON_AddBoolToObject(readback,"outputs_stopped",true);
    char *text=cJSON_PrintUnformatted(ack);
    if (text && strlen(text)<sizeof(s_last_ack)) {
        strcpy(s_last_id,id); strcpy(s_last_ack,text);
        char topic[192]; snprintf(topic,sizeof(topic),"snoozmate/v1/devices/%s/acks/up",mqtt_mgr_device_id());
        if (mqtt_mgr_publish(topic,text,(int)strlen(text))!=ESP_OK) ++s_dropped;
    }
    cJSON_free(text); cJSON_Delete(ack);
    telemetry(NULL);
}

static void poll_sound_result(void) {
    if (!s_sound_pending.id[0]) return;
    uint8_t minutes=0;
    sfx_timer_state(&minutes);
    bool stopped=haptic_stop_latched();
    bool matches=!stopped && sfx_current()==s_sound_pending.track && audio_get_state()==AUDIO_STATE_PLAYING &&
        audio_get_volume()==s_sound_pending.volume && minutes==s_sound_pending.timer;
    if (!matches && !stopped && esp_timer_get_time()<s_sound_pending.deadline_us) return;
    cJSON *readback=matches ? sound_readback(s_sound_pending.scene,minutes) : NULL;
    if (!readback) sfx_stop();
    publish_ack(s_sound_pending.id,readback ? "applied" : "failed",
        readback ? "" : (stopped ? "DEVICE_STOPPED" : "SOUND_READBACK_TIMEOUT"),"sound",readback,false,false);
    s_sound_pending.id[0]=0;
}

/* Remote outputs are not replayed when a different command intervenes. */
static bool remember_manual_command(const char *id, int64_t until_us) {
    int64_t now=esp_timer_get_time();
    size_t free_slot=sizeof(s_manual_commands)/sizeof(s_manual_commands[0]);
    for (size_t i=0;i<sizeof(s_manual_commands)/sizeof(s_manual_commands[0]);++i) {
        if (s_manual_commands[i].until_us<=now) free_slot=i;
        else if (!strcmp(s_manual_commands[i].id,id)) return false;
    }
    if (free_slot==sizeof(s_manual_commands)/sizeof(s_manual_commands[0])) return false;
    strcpy(s_manual_commands[free_slot].id,id);
    s_manual_commands[free_slot].until_us=until_us;
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
    if (!strcmp(id->valuestring,s_sound_pending.id)) goto done;
    if (!strcmp(id->valuestring,s_last_id)) {
        char topic[192]; snprintf(topic,sizeof(topic),"snoozmate/v1/devices/%s/acks/up",mqtt_mgr_device_id());
        mqtt_mgr_publish(topic,s_last_ack,(int)strlen(s_last_ack));
        goto done;
    }
    const char *status="rejected", *error="NOT_IMPLEMENTED";
    cJSON *output_readback=NULL;
    const char *output_kind=NULL;
    const cJSON *expires=cJSON_GetObjectItemCaseSensitive(p,"expires_at");
    bool stop=!strcmp(type->valuestring,"stop_intervention") || !strcmp(type->valuestring,"stop_all");
    bool manual=!strcmp(type->valuestring,"set_light") || !strcmp(type->valuestring,"set_sound") ||
        !strcmp(type->valuestring,"vibration_test");
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
    } else if (manual && expires->valuedouble-(double)(utc_ms()/1000)>10) {
        error="INVALID_COMMAND_TTL";
    } else if (manual && !remember_manual_command(id->valuestring,esp_timer_get_time()+10000000)) {
        goto done;
    } else if (!strcmp(type->valuestring,"cloud_intervention")) {
        error="AUTOMATIC_DISABLED";
    } else if (!strcmp(type->valuestring,"set_light")) {
        output_kind="light";
        error=apply_manual_light(cJSON_GetObjectItemCaseSensitive(p,"payload"),&output_readback);
        if (!error[0]) status="applied";
    } else if (!strcmp(type->valuestring,"set_sound")) {
        output_kind="sound";
        const cJSON *payload=cJSON_GetObjectItemCaseSensitive(p,"payload");
        const cJSON *patch=cJSON_GetObjectItemCaseSensitive(payload,"patch");
        if (s_sound_pending.id[0] && cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(patch,"playing"))) {
            sfx_stop();
            publish_ack(s_sound_pending.id,"rejected","SOUND_SUPERSEDED",NULL,NULL,false,false);
            s_sound_pending.id[0]=0;
        }
        error=apply_manual_sound(id->valuestring,payload,&output_readback);
        if (!error) goto done; /* Worker waits for playback without delaying stop commands. */
        if (!error[0]) status="applied";
    } else if (!strcmp(type->valuestring,"vibration_test")) {
        double remaining=expires->valuedouble-(double)(utc_ms()/1000);
        const cJSON *payload=cJSON_GetObjectItemCaseSensitive(p,"payload");
        const cJSON *session=cJSON_GetObjectItemCaseSensitive(payload,"session_id");
        if (!cJSON_IsString(session) || strcmp(session->valuestring,s_session)) {
            error="DEVICE_SESSION_CHANGED";
        } else if (remaining>0 && remaining<=10 && !haptic_stop_latched()) {
            ag_request_t request={.source=AG_MANUAL_TEST,.command_id=id->valuestring,.percent=50,
                .duration_ms=2000,.expires_ms=(uint64_t)esp_timer_get_time()/1000+(uint64_t)(remaining*1000),
                .authorized=true,.clock_valid=true};
            if (haptic_execute(&request)==ESP_OK && haptic_is_active()) {
                output_readback=cJSON_CreateObject();
                cJSON_AddBoolToObject(output_readback,"started",true);
                cJSON_AddNumberToObject(output_readback,"duration_ms",2000);
                output_kind="vibration_test";
                status="applied"; error="";
            } else error="VIBRATION_TEST_REJECTED";
        } else error=haptic_stop_latched() ? "DEVICE_STOPPED" : "COMMAND_EXPIRED";
    }
    bool stopped=stop && !strcmp(status,"applied");
    publish_ack(id->valuestring,status,error,output_kind,output_readback,stopped,
        stopped && !strcmp(type->valuestring,"stop_all"));
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
        poll_sound_result();
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
