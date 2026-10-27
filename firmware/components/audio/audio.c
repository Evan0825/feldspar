#include "audio.h"

#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/ringbuf.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "driver/i2s_std.h"

static const char *TAG = "audio";

/* ---- 可调整的 GPIO / 逻辑配置 ---- */
/* BCLK 原为 GPIO 9，2026-09-05 让位给 W25Q64 存储，改到 GPIO 21 */
#define I2S_BCLK_GPIO       21
#define I2S_WS_GPIO         14
#define I2S_DOUT_GPIO       13

/* 环形缓冲大小（字节）。BLE 数据先进入该缓冲，再由播放任务按采样率取出。 */
#define AUDIO_RING_SIZE     (32 * 1024)
/* 每次从环中取出并写入 I2S 的最大字节数（2 的倍数）*/
#define PLAY_CHUNK_SIZE     (4 * 1024)

static i2s_chan_handle_t tx_chan = NULL;
static RingbufHandle_t ring = NULL;
static TaskHandle_t s_play_task = NULL;
static audio_state_t s_state = AUDIO_STATE_STOPPED;
static bool s_i2s_enabled = false;
static uint8_t s_volume = 100;

/* 预放大（pre-gain）：针对源文件响度偏低 / 功放默认增益偏小，对输出整体提升。
 * 100 = 1.0x，150 = 1.5x，200 = 2.0x。与音量 0-100 分层独立，最终相乘后削顶。 */
#define AUDIO_PREGAIN_PERCENT   150

/* 输出缩放：预放大 + 用户音量，逐采样计算并削顶，避免过冲削波 */
static int16_t scale_sample(int16_t s)
{
    int32_t v = (int32_t)s * (int32_t)s_volume * AUDIO_PREGAIN_PERCENT / (100 * 100);
    if (v > 32767) v = 32767;
    if (v < -32768) v = -32768;
    return (int16_t)v;
}

static void play_task(void *arg)
{
    uint8_t *buf = heap_caps_malloc(PLAY_CHUNK_SIZE, MALLOC_CAP_8BIT);
    if (!buf) {
        ESP_LOGE(TAG, "alloc play buffer failed");
        vTaskDelete(NULL);
        return;
    }

    do {
        if (s_state == AUDIO_STATE_PAUSED || s_state == AUDIO_STATE_STOPPED) {
            vTaskDelay(pdMS_TO_TICKS(50));
            continue;
        }

        /* 从环形缓冲取一段连续数据 */
        size_t len = 0;
        void *item = xRingbufferReceiveUpTo(ring, &len, pdMS_TO_TICKS(50), PLAY_CHUNK_SIZE);
        if (item == NULL) {
            /* 缓冲为空（暂缓存不足），保持 I2S 运行避免爆音 */
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }

        /* 原位音量缩放 + 预放大（16bit 单声道逐采样，削顶） */
        if (s_volume < 100 || AUDIO_PREGAIN_PERCENT != 100) {
            int16_t *p = (int16_t *)item;
            size_t samples = len / 2;
            for (size_t i = 0; i < samples; i++) {
                p[i] = scale_sample(p[i]);
            }
        }

        /* 写入 I2S（阻塞直到写完或超时，timeout 单位为毫秒） */
        size_t bytes_written = 0;
        esp_err_t err = i2s_channel_write(tx_chan, item, len, &bytes_written, 100);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "i2s write err: %d", err);
        }
        vRingbufferReturnItem(ring, item);
    } while (1);
}

esp_err_t audio_init(void)
{
    if (tx_chan != NULL) {
        return ESP_OK; /* 已初始化 */
    }

    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    chan_cfg.auto_clear = true;
    esp_err_t err = i2s_new_channel(&chan_cfg, &tx_chan, NULL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2s_new_channel err: %d", err);
        return err;
    }

    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(AUDIO_SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = (gpio_num_t)I2S_BCLK_GPIO,
            .ws = (gpio_num_t)I2S_WS_GPIO,
            .dout = (gpio_num_t)I2S_DOUT_GPIO,
            .din = I2S_GPIO_UNUSED,
            .invert_flags = {0},
        },
    };

    err = i2s_channel_init_std_mode(tx_chan, &std_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2s_channel_init_std_mode err: %d", err);
        return err;
    }

    ring = xRingbufferCreate(AUDIO_RING_SIZE, RINGBUF_TYPE_BYTEBUF);
    if (!ring) {
        ESP_LOGE(TAG, "create ring buffer failed");
        return ESP_ERR_NO_MEM;
    }

    BaseType_t ok = xTaskCreate(play_task, "audio_play", 4096, NULL, 5, &s_play_task);
    if (ok != pdPASS) {
        ESP_LOGE(TAG, "create play task failed");
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGI(TAG, "audio init ok, rate=%d, mono16", AUDIO_SAMPLE_RATE);
    return ESP_OK;
}

esp_err_t audio_start(void)
{
    if (!tx_chan) return ESP_ERR_INVALID_STATE;
    if (s_i2s_enabled == false) {
        esp_err_t err = i2s_channel_enable(tx_chan);
        if (err != ESP_OK) return err;
        s_i2s_enabled = true;
    }
    s_state = AUDIO_STATE_PLAYING;
    ESP_LOGI(TAG, "audio playing");
    return ESP_OK;
}

esp_err_t audio_resume(void)
{
    return audio_start();
}

esp_err_t audio_pause(void)
{
    if (s_i2s_enabled == false) return ESP_OK;
    s_state = AUDIO_STATE_PAUSED;
    ESP_LOGI(TAG, "audio paused");
    return ESP_OK;
}

esp_err_t audio_stop(void)
{
    s_state = AUDIO_STATE_STOPPED;
    /* 清空环形缓冲，避免残留数据在下次播放时混出 */
    if (ring) {
        for (;;) {
            size_t len = 0;
            void *item = xRingbufferReceiveUpTo(ring, &len, 0, 4096);
            if (item == NULL) break;
            vRingbufferReturnItem(ring, item);
        }
    }
    if (s_i2s_enabled) {
        i2s_channel_disable(tx_chan);
        s_i2s_enabled = false;
    }
    ESP_LOGI(TAG, "audio stopped");
    return ESP_OK;
}

esp_err_t audio_flush(void)
{
    if (ring == NULL) return ESP_ERR_INVALID_STATE;
    for (;;) {
        size_t len = 0;
        void *item = xRingbufferReceiveUpTo(ring, &len, 0, 4096);
        if (item == NULL) break;
        vRingbufferReturnItem(ring, item);
    }
    return ESP_OK;
}

esp_err_t audio_feed(const uint8_t *pcm, size_t len)
{
    if (ring == NULL) return ESP_ERR_INVALID_STATE;
    if (pcm == NULL || len == 0) return ESP_OK;
    if (len % 2 != 0) return ESP_ERR_INVALID_ARG;
    if (s_state != AUDIO_STATE_PLAYING) return ESP_ERR_INVALID_STATE;

    /* 若缓冲已满，丢弃新数据并告警（不阻塞 BLE 回调） */
    if (xRingbufferSend(ring, pcm, len, pdMS_TO_TICKS(0)) != pdTRUE) {
        ESP_LOGW(TAG, "audio ring full, drop %u bytes", (unsigned)len);
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

esp_err_t audio_set_volume(uint8_t volume)
{
    if (volume > 100) volume = 100;
    s_volume = volume;
    return ESP_OK;
}

audio_state_t audio_get_state(void)
{
    return s_state;
}

uint8_t audio_get_volume(void) { return s_volume; }
