/* Real SFX queue/playback logic, temporary files, memory-only audio driver. */
#include <assert.h>
#include <setjmp.h>
#include <stdio.h>
#include <string.h>
#include "../firmware/components/sfx/sfx.c"

static unsigned char queued[4][64];
static unsigned q_count, q_size, started, fed;
static bool stop_during_dequeue;
static jmp_buf drained;

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
void vTaskDelay(unsigned ticks) { (void)ticks; }
bool storage_fatfs_mounted(void) { return true; }
esp_err_t storage_mount_fatfs(void) { return ESP_OK; }
esp_err_t storage_fatfs_info(uint64_t *total,uint64_t *free_bytes) { *total=*free_bytes=1048576; return ESP_OK; }
uint32_t esp_rom_crc32_le(uint32_t crc,const uint8_t *data,size_t length) {
    (void)data; (void)length; return crc; /* upload path not exercised */
}
esp_err_t audio_start(void) { ++started; return ESP_OK; }
esp_err_t audio_stop(void) { return ESP_OK; }
esp_err_t audio_pause(void) { return ESP_OK; }
esp_err_t audio_resume(void) { return ESP_OK; }
esp_err_t audio_flush(void) { return ESP_OK; }
esp_err_t audio_feed(const uint8_t *data,size_t length) { (void)data; fed+=(unsigned)length; return ESP_OK; }

static void pump(void) { if (!setjmp(drained)) play_task(NULL); }
int main(void) {
    assert(sfx_init()==ESP_OK && sfx_count()>0);
    assert(sfx_play(0)==ESP_OK && q_count==1);
    assert(sfx_stop()==ESP_OK && q_count==0);
    assert(sfx_play(0)==ESP_OK);
    stop_during_dequeue=true;
    pump();
    assert(started==0); /* stop after dequeue, before player begins */
    assert(sfx_play(0)==ESP_OK);
    pump();
    assert(started==1 && fed>0);
    s_current=1;
    assert(sfx_play(0)==ESP_OK && q_count==1); /* switching preserves new request */
    pump();
    assert(started==2);
    puts("SFX stop cancels queued/dequeued jobs and preserves explicit switching (host files only).");
}
