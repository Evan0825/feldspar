/* Real SFX queue/playback logic, temporary files, memory-only audio driver. */
#include <assert.h>
#include <setjmp.h>
#include <stdio.h>
#include <string.h>
#include "../firmware/components/sfx/sfx.c"

static unsigned char queued[4][64];
static unsigned q_count, q_size, started, fed;
static bool stop_during_dequeue;
static bool stop_during_drain, stalled_drain;
static unsigned pending_polls, discarded_tails, done_events, drain_errors;
static jmp_buf drained;
static int64_t now_us;
static unsigned stop_after_feeds;
int64_t esp_timer_get_time(void) { return now_us; }

QueueHandle_t xQueueCreate(unsigned count,unsigned size) {
    assert(count==4 && size<=64); q_size=size; return (void *)1;
}
int xQueueSend(QueueHandle_t q,const void *item,uint32_t timeout) {
    (void)q; (void)timeout;
    if (q_count==4) return 0;
    memcpy(queued[q_count++],item,q_size); return pdTRUE;
}
int xQueueReset(QueueHandle_t q) { (void)q; q_count=0; return pdTRUE; }
int xQueueReceive(QueueHandle_t q,void *item,uint32_t timeout) {
    (void)q; (void)timeout;
    if (!q_count) longjmp(drained,1);
    memcpy(item,queued[0],q_size);
    --q_count; memmove(queued,queued+1,q_count*sizeof(queued[0]));
    if (stop_during_dequeue) { stop_during_dequeue=false; sfx_stop(); }
    return pdTRUE;
}
int xTaskCreate(void (*fn)(void *),const char *name,unsigned stack,void *context,unsigned priority,void *handle) {
    (void)fn; (void)name; (void)stack; (void)context; (void)priority; (void)handle; return pdPASS;
}
void vTaskDelay(unsigned ticks) {
    (void)ticks;
    if (stop_during_drain && pending_polls) {
        stop_during_drain=false;
        sfx_stop();
    } else if (pending_polls && !stalled_drain) {
        --pending_polls;
    }
}
bool storage_fatfs_mounted(void) { return true; }
esp_err_t storage_mount_fatfs(void) { return ESP_OK; }
esp_err_t storage_fatfs_info(uint64_t *total,uint64_t *free_bytes) { *total=*free_bytes=1048576; return ESP_OK; }
uint32_t esp_rom_crc32_le(uint32_t crc,const uint8_t *data,size_t length) {
    (void)data; (void)length; return crc; /* upload path not exercised */
}
esp_err_t audio_start(void) { ++started; return ESP_OK; }
esp_err_t audio_stop(void) {
    if (pending_polls) ++discarded_tails;
    pending_polls=0;
    return ESP_OK;
}
esp_err_t audio_pause(void) { return ESP_OK; }
esp_err_t audio_resume(void) { return ESP_OK; }
esp_err_t audio_flush(void) { return ESP_OK; }
esp_err_t audio_feed(const uint8_t *data,size_t length) {
    (void)data;
    fed+=(unsigned)length;
    if (stop_after_feeds && --stop_after_feeds == 0) now_us += 15LL * 60 * 1000000;
    pending_polls=3;
    return ESP_OK;
}
bool audio_has_pending(void) { return pending_polls != 0; }

static void on_sfx_event(const char *message) {
    if (!strncmp(message,"SFXDONE,",8)) ++done_events;
    if (!strcmp(message,"SFXERR,drain")) ++drain_errors;
}

static void pump(void) { if (!setjmp(drained)) play_task(NULL); }
int main(void) {
    assert(sfx_init()==ESP_OK && sfx_count()>0);
    sfx_set_event_cb(on_sfx_event);
    assert(sfx_play(0)==ESP_OK && q_count==1);
    assert(sfx_stop()==ESP_OK && q_count==0);
    assert(sfx_play(0)==ESP_OK);
    stop_during_dequeue=true;
    pump();
    assert(started==0); /* stop after dequeue, before player begins */
    assert(sfx_play(0)==ESP_OK);
    pump();
    assert(started==1 && fed>0);
    assert(done_events==1 && discarded_tails==0); /* EOF waits for queued PCM */
    s_current=1;
    assert(sfx_play(0)==ESP_OK && q_count==1); /* switching preserves new request */
    pump();
    assert(started==2);
    stop_during_drain=true;
    assert(sfx_play(0)==ESP_OK);
    pump();
    assert(started==3 && done_events==2 && discarded_tails==1 && !drain_errors && !sfx_is_playing());
    stalled_drain=true;
    assert(sfx_play(0)==ESP_OK);
    pump();
    assert(started==4 && done_events==2 && discarded_tails==2 && drain_errors==1 && !sfx_is_playing());
    stalled_drain=false;
    unsigned before=started;
    assert(sfx_play_timed(1, 12)==ESP_ERR_INVALID_ARG);
    assert(sfx_play_timed(1, 15)==ESP_OK);
    stop_after_feeds=10; /* forces a loop through the short file before time runs out */
    pump();
    uint8_t minutes=99;
    assert(sfx_timer_state(&minutes)==0 && minutes==0);
    assert(started==before+1 && !sfx_is_playing() && discarded_tails==3);
    puts("SFX drains the natural tail and preserves stop and switching (host files only).");
}
