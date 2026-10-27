#include "mic.h"
#include "mic_samples.h"

#include <math.h>
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "driver/i2s_std.h"
#include "esp_timer.h"
#include "esp_attr.h"
#include "haptic.h"
#include "audio.h"

static const char *TAG = "mic";

/* ---- INMP441 接线（见 WIRING.md §6）---- */
#define MIC_I2S_PORT      I2S_NUM_1
#define MIC_SCK_GPIO      GPIO_NUM_15   /* BCLK/SCK 时钟 */
#define MIC_WS_GPIO       GPIO_NUM_16   /* L/R CLK 帧时钟（WS） */
#define MIC_SD_GPIO       GPIO_NUM_17   /* DOUT 数据输出 → ESP32 DIN */
#define MIC_SAMPLE_RATE   16000         /* Hz，与播放链路一致 */

#define MIC_READ_SAMPLES  256           /* 每次读取的 int32 采样数 */
#define MIC_WINDOW_MS     1000          /* 电平统计窗口 1 秒 */

static i2s_chan_handle_t s_rx = NULL;
static TaskHandle_t s_task = NULL;
static volatile bool s_diag = false;
static volatile uint8_t s_rms_pct = 0;
static volatile uint8_t s_peak_pct = 0;
static void (*s_report_cb)(const char *msg) = NULL;
static bool (*volatile s_feature_cb)(const af_features_t *features);
static af_frontend_t s_frontend;
static int16_t s_pcm[AF_SAMPLES]; /* not on the FreeRTOS task stack */
static volatile uint32_t s_overflows;

void mic_set_feature_cb(bool (*callback)(const af_features_t *features)) { s_feature_cb=callback; }

static bool IRAM_ATTR receive_overflow(i2s_chan_handle_t channel, i2s_event_data_t *event, void *context) {
    (void)channel; (void)event; (void)context;
    ++s_overflows;
    return false;
}

void mic_set_report_cb(void (*cb)(const char *msg))
{
    s_report_cb = cb;
}

void mic_diag(bool on)
{
    s_diag = on;
    ESP_LOGI(TAG, "diagnostic report %s", on ? "ON" : "OFF");
}

void mic_get_level(uint8_t *rms, uint8_t *peak)
{
    if (rms)  *rms  = s_rms_pct;
    if (peak) *peak = s_peak_pct;
}

/* 持续读取 I2S 数据，按 1 秒窗口统计 RMS/峰值（INMP441 为 24bit 数据装在
 * 32bit 槽内、MSB 对齐，除以 2^14 后饱和转换到 int16 幅度） */
static void mic_task(void *arg)
{
    int32_t buf[MIC_READ_SAMPLES];
    uint64_t acc_sq = 0;
    uint32_t peak = 0, n = 0;
    TickType_t window_start = xTaskGetTickCount();
    size_t pcm_count=0;
    uint32_t sequence=0, last_overflows=0;
    bool feature_gap=false, feature_noise=false;
    uint64_t noise_until=0;

    while (1) {
        size_t bytes = 0;
        esp_err_t err = i2s_channel_read(s_rx, buf, sizeof(buf), &bytes, pdMS_TO_TICKS(100));
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "i2s read err: %s", esp_err_to_name(err));
            af_reset(&s_frontend); pcm_count=0; feature_gap=true;
            continue;
        }
        if (last_overflows != s_overflows) {
            last_overflows=s_overflows;
            af_reset(&s_frontend); pcm_count=0; feature_gap=true;
        }
        uint64_t sample_ms=(uint64_t)esp_timer_get_time()/1000;
        if (haptic_is_active() || audio_get_state()==AUDIO_STATE_PLAYING) noise_until=sample_ms+2000;
        if (sample_ms<noise_until) feature_noise=true;
        size_t nsamp = bytes / sizeof(int32_t);
        for (size_t i = 0; i < nsamp; i++) {
            int16_t s = mic_sample_to_pcm16(buf[i]);
            uint32_t a = (s < 0) ? (uint32_t)(-s) : (uint32_t)s;
            acc_sq += (uint64_t)s * (uint64_t)s;
            if (a > peak) peak = a;
            n++;
            if (s_feature_cb) {
                s_pcm[pcm_count++]=s;
                if (pcm_count==AF_SAMPLES) {
                    uint64_t tail_ms=(nsamp-i-1)*1000/16000;
                    uint64_t capture_end_ms=sample_ms>=tail_ms ? sample_ms-tail_ms : 0;
                    af_features_t features=af_extract(&s_frontend,s_pcm,AF_SAMPLES,!feature_gap,feature_noise);
                    features.sequence=++sequence;
                    features.monotonic_end_ms=capture_end_ms;
                    s_feature_cb(&features);
                    pcm_count=0; feature_gap=false; feature_noise=false;
                }
            }
        }

        if (xTaskGetTickCount() - window_start >= pdMS_TO_TICKS(MIC_WINDOW_MS)) {
            uint32_t rms = n ? (uint32_t)sqrtf((float)(acc_sq / n)) : 0;
            uint8_t rms_pct  = mic_rms_percent(rms);
            uint8_t peak_pct = (peak > 32767) ? 100 : (uint8_t)(peak / 328);
            s_rms_pct = rms_pct;
            s_peak_pct = peak_pct;

            if (s_diag) {
                ESP_LOGI(TAG, "level rms=%3u%% peak=%3u%%", (unsigned)rms_pct, (unsigned)peak_pct);
                if (s_report_cb) {
                    char msg[32];
                    snprintf(msg, sizeof(msg), "MIC,%u,%u", (unsigned)rms_pct, (unsigned)peak_pct);
                    s_report_cb(msg);
                }
            }
            acc_sq = 0; peak = 0; n = 0;
            window_start = xTaskGetTickCount();
        }
    }
}

esp_err_t mic_init(void)
{
    if (s_rx) return ESP_OK;
    af_init(&s_frontend);

    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(MIC_I2S_PORT, I2S_ROLE_MASTER);
    esp_err_t err = i2s_new_channel(&chan_cfg, NULL, &s_rx);   /* 仅 RX */
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2s_new_channel err: %s", esp_err_to_name(err));
        return err;
    }
    i2s_event_callbacks_t callbacks={.on_recv_q_ovf=receive_overflow};
    err=i2s_channel_register_event_callback(s_rx,&callbacks,NULL);
    if (err!=ESP_OK) return err;

    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(MIC_SAMPLE_RATE),
        /* INMP441 为 24bit 数据、32bit 槽；MONO 模式只取一个声道槽 */
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT,
                                                       I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = MIC_SCK_GPIO,
            .ws   = MIC_WS_GPIO,
            .dout = I2S_GPIO_UNUSED,
            .din  = MIC_SD_GPIO,
            .invert_flags = {0},
        },
    };
    /* INMP441 的 L/R 脚接 GND → 数据在左声道槽 */
    std_cfg.slot_cfg.slot_mask = I2S_STD_SLOT_LEFT;

    err = i2s_channel_init_std_mode(s_rx, &std_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2s_channel_init_std_mode err: %s", esp_err_to_name(err));
        return err;
    }

    err = i2s_channel_enable(s_rx);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2s_channel_enable err: %s", esp_err_to_name(err));
        return err;
    }

    if (xTaskCreate(mic_task, "mic_rx", 4096, NULL, 6, &s_task) != pdPASS) {
        ESP_LOGE(TAG, "create mic task failed");
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGI(TAG, "mic init ok (INMP441 I2S1: SCK=%d WS=%d SD=%d, %dHz mono)",
             MIC_SCK_GPIO, MIC_WS_GPIO, MIC_SD_GPIO, MIC_SAMPLE_RATE);
    return ESP_OK;
}
