#include "lighting.h"
#include "breath_pixel.h"
#include "light_pulse.h"

#include <stddef.h>
#include <stdbool.h>
#include <stdlib.h>
#include "esp_log.h"
#include "esp_check.h"
#include "esp_timer.h"
#include "driver/rmt_tx.h"
#include "driver/rmt_encoder.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "haptic.h"
#include "nvs_flash.h"
#include "nvs.h"

static const char *TAG = "lighting";

/* =====================================================================
 * 单线（S 串行数据）数字灯带驱动：WS2812B / SK6812
 * 引脚：S（数据）接 GPIO 0，V(+/5V)，G(地)。
 * 数据时序用 ESP32-S3 的 RMT TX 通道以逐位方式产生，
 * 每灯珠 3 字节，默认颜色顺序 GRB（WS2812B 标准）。
 * ===================================================================== */

#define LIGHT_STRIP_GPIO        GPIO_NUM_8   /* S 数据线接 GPIO 8（普通 IO，避开 strapping 脚 GPIO0） */
#define LIGHT_STRIP_NUM_LEDS    10           /* 灯带灯珠数量（实物 1~10 号） */
#define LIGHT_STRIP_RMT_RES     40000000U    /* RMT 时钟分辨率 40MHz，1 tick = 25ns */

#define LIGHT_RMT_MEM_SYMBOLS   64
#define LIGHT_RMT_QUEUE_DEPTH   4

/* WS2812B 名义时序（microsecond），40MHz 下均为整数 tick，周期 1.25us=50 tick */
#define LIGHT_T0H_US   0.4f     /* 0 位高电平 */
#define LIGHT_T0L_US   0.85f    /* 0 位低电平 */
#define LIGHT_T1H_US   0.8f     /* 1 位高电平 */
#define LIGHT_T1L_US   0.45f    /* 1 位低电平 */
#define LIGHT_RESET_US 50.0f    /* 帧间复位(锁存)低电平 */

/* 颜色字节顺序：WS2812B = GRB；若灯带是 SK6812 的 RGB 版本改 0 即可 */
#define LIGHT_COLOR_GRB  1

/* ---- 静态 RMT 句柄与编码器 ---- */
static rmt_channel_handle_t s_tx_chan = NULL;
static rmt_encoder_handle_t s_encoder = NULL;
static rmt_transmit_config_t s_tx_config = { .loop_count = 0 };
static bool s_inited = false;
static SemaphoreHandle_t s_lock;

/* 当前 RGB（0-100）与开关状态；颜色/状态持久化到 NVS，上电自动恢复 */
#define LIGHT_NVS_NS   "light"   /* NVS 命名空间（≤15 字符） */

/* 默认暖色调（夜灯色 R:G:B = 100:60:30）：无记忆/首次开机或开灯时颜色为空，立即点亮此色 */
#define LIGHT_DEFAULT_R   100
#define LIGHT_DEFAULT_G   60
#define LIGHT_DEFAULT_B   30

static uint8_t s_r = 0, s_g = 0, s_b = 0;
static bool s_on = false;
static bool s_breathing;
static light_pulse_t s_pulse;
static uint64_t s_pulse_next_ms;
static uint16_t s_rendered_level;

#define PULSE_FRAME_MS 20
#define PULSE_AMBER_R 255
#define PULSE_AMBER_G 132
#define PULSE_AMBER_B 34

/* 灯珠像素缓冲：每灯珠 3 字节 */
static uint8_t s_pixels[LIGHT_STRIP_NUM_LEDS * 3];

/* 套用默认暖色调并置为点亮态 */
static void light_apply_default_warm(void)
{
    s_r = LIGHT_DEFAULT_R;
    s_g = LIGHT_DEFAULT_G;
    s_b = LIGHT_DEFAULT_B;
    s_on = true;
}

/* ---- NVS 颜色记忆：读取上次保存的颜色与亮灭状态；返回是否存在记忆记录 ---- */
static bool light_nvs_load(void)
{
    nvs_handle_t h;
    if (nvs_open(LIGHT_NVS_NS, NVS_READONLY, &h) != ESP_OK) return false;
    bool found = false;
    uint8_t v;
    if (nvs_get_u8(h, "r", &v) == ESP_OK) { s_r = v; found = true; }
    if (nvs_get_u8(h, "g", &v) == ESP_OK) s_g = v;
    if (nvs_get_u8(h, "b", &v) == ESP_OK) s_b = v;
    uint8_t on = 0;
    if (nvs_get_u8(h, "on", &on) == ESP_OK) s_on = (on != 0);
    nvs_close(h);
    ESP_LOGI(TAG, "nvs load: found=%d rgb=%u,%u,%u on=%u", (int)found,
             (unsigned)s_r, (unsigned)s_g, (unsigned)s_b, (unsigned)(s_on ? 1 : 0));
    return found;
}

/* ---- NVS 颜色记忆：保存当前颜色与亮灭状态 ---- */
static void light_nvs_save(void)
{
    nvs_handle_t h;
    if (nvs_open(LIGHT_NVS_NS, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_set_u8(h, "r", s_r);
    nvs_set_u8(h, "g", s_g);
    nvs_set_u8(h, "b", s_b);
    nvs_set_u8(h, "on", s_on ? 1 : 0);
    nvs_commit(h);
    nvs_close(h);
}

#if LIGHT_COLOR_GRB
#define PIXEL_SET(px, r8, g8, b8) do { (px)[0] = (g8); (px)[1] = (r8); (px)[2] = (b8); } while (0)
#else
#define PIXEL_SET(px, r8, g8, b8) do { (px)[0] = (r8); (px)[1] = (g8); (px)[2] = (b8); } while (0)
#endif

/* =====================================================================
 * 自定义 RMT 编码器：先用 bytes 编码器逐位输出像素数据，
 * 数据结束后再补一个复位(锁存)低电平脉冲。与 ESP-IDF led_strip 示例一致。
 * ===================================================================== */
typedef struct {
    rmt_encoder_t base;
    rmt_encoder_t *bytes_encoder;
    rmt_encoder_t *copy_encoder;
    int state;
    rmt_symbol_word_t reset_code;
} rmt_light_encoder_t;

#define LIGHT_CONTAINEROF(ptr, type, member) ((type *)((char *)(ptr) - offsetof(type, member)))

static size_t rmt_encode_light(rmt_encoder_t *encoder, rmt_channel_handle_t channel,
                               const void *primary_data, size_t data_size,
                               rmt_encode_state_t *ret_state)
{
    rmt_light_encoder_t *le = LIGHT_CONTAINEROF(encoder, rmt_light_encoder_t, base);
    rmt_encode_state_t session = RMT_ENCODING_RESET;
    rmt_encode_state_t state = RMT_ENCODING_RESET;
    size_t sym = 0;

    switch (le->state) {
    case 0: /* 像素数据 */
        sym += le->bytes_encoder->encode(le->bytes_encoder, channel, primary_data, data_size, &session);
        if (session & RMT_ENCODING_COMPLETE) {
            le->state = 1;
        }
        if (session & RMT_ENCODING_MEM_FULL) {
            state |= RMT_ENCODING_MEM_FULL;
            goto out;
        }
        /* fall-through */
    case 1: /* 复位(锁存) */
        sym += le->copy_encoder->encode(le->copy_encoder, channel, &le->reset_code,
                                        sizeof(le->reset_code), &session);
        if (session & RMT_ENCODING_COMPLETE) {
            le->state = RMT_ENCODING_RESET;
            state |= RMT_ENCODING_COMPLETE;
        }
        if (session & RMT_ENCODING_MEM_FULL) {
            state |= RMT_ENCODING_MEM_FULL;
            goto out;
        }
        break;
    }
out:
    *ret_state = state;
    return sym;
}

static esp_err_t rmt_light_encoder_reset(rmt_encoder_t *encoder)
{
    rmt_light_encoder_t *le = LIGHT_CONTAINEROF(encoder, rmt_light_encoder_t, base);
    rmt_encoder_reset(le->bytes_encoder);
    rmt_encoder_reset(le->copy_encoder);
    le->state = RMT_ENCODING_RESET;
    return ESP_OK;
}

static esp_err_t rmt_light_encoder_del(rmt_encoder_t *encoder)
{
    rmt_light_encoder_t *le = LIGHT_CONTAINEROF(encoder, rmt_light_encoder_t, base);
    rmt_del_encoder(le->bytes_encoder);
    rmt_del_encoder(le->copy_encoder);
    free(le);
    return ESP_OK;
}

static esp_err_t light_new_encoder(uint32_t resolution, rmt_encoder_handle_t *ret_encoder)
{
    esp_err_t ret = ESP_OK;
    rmt_light_encoder_t *le = NULL;
    ESP_GOTO_ON_FALSE(resolution && ret_encoder, ESP_ERR_INVALID_ARG, err, TAG, "invalid arg");

    le = calloc(1, sizeof(rmt_light_encoder_t));
    ESP_GOTO_ON_FALSE(le, ESP_ERR_NO_MEM, err, TAG, "no mem");

    le->base.encode = rmt_encode_light;
    le->base.reset = rmt_light_encoder_reset;
    le->base.del = rmt_light_encoder_del;

    rmt_bytes_encoder_config_t bytes_cfg = {
        .bit0 = {
            .level0 = 1,
            .duration0 = (uint16_t)(LIGHT_T0H_US * resolution / 1000000U),
            .level1 = 0,
            .duration1 = (uint16_t)(LIGHT_T0L_US * resolution / 1000000U),
        },
        .bit1 = {
            .level0 = 1,
            .duration0 = (uint16_t)(LIGHT_T1H_US * resolution / 1000000U),
            .level1 = 0,
            .duration1 = (uint16_t)(LIGHT_T1L_US * resolution / 1000000U),
        },
        .flags.msb_first = 1,
    };
    ESP_GOTO_ON_ERROR(rmt_new_bytes_encoder(&bytes_cfg, &le->bytes_encoder), err, TAG, "bytes encoder err");

    rmt_copy_encoder_config_t copy_cfg = {};
    ESP_GOTO_ON_ERROR(rmt_new_copy_encoder(&copy_cfg, &le->copy_encoder), err, TAG, "copy encoder err");

    uint32_t reset_ticks = (uint32_t)(LIGHT_RESET_US * resolution / 1000000U);
    le->reset_code = (rmt_symbol_word_t){
        .level0 = 0,
        .duration0 = (uint16_t)reset_ticks,
        .level1 = 0,
        .duration1 = (uint16_t)reset_ticks,
    };

    *ret_encoder = &le->base;
    return ESP_OK;
err:
    if (le) {
        if (le->bytes_encoder) rmt_del_encoder(le->bytes_encoder);
        if (le->copy_encoder) rmt_del_encoder(le->copy_encoder);
        free(le);
    }
    return ret;
}

/* 将当前状态（开关 + RGB 0-100）编码为像素并一次性下发到灯带；关闭时全黑 */
static uint8_t peak_rgb(uint8_t r, uint8_t g, uint8_t b)
{
    uint8_t peak = r > g ? r : g;
    return peak > b ? peak : b;
}

static esp_err_t lighting_refresh(uint16_t pulse_level)
{
    if (!s_inited) return ESP_ERR_INVALID_STATE;

    uint8_t r8 = s_on ? (uint8_t)(s_r * 255 / 100) : 0;
    uint8_t g8 = s_on ? (uint8_t)(s_g * 255 / 100) : 0;
    uint8_t b8 = s_on ? (uint8_t)(s_b * 255 / 100) : 0;

    for (uint32_t i = 0; i < LIGHT_STRIP_NUM_LEDS; i++) {
        if (s_on && s_breathing) {
            PIXEL_SET(&s_pixels[i * 3],
                lighting_breath_pixel(PULSE_AMBER_R, pulse_level, i, LIGHT_STRIP_NUM_LEDS),
                lighting_breath_pixel(PULSE_AMBER_G, pulse_level, i, LIGHT_STRIP_NUM_LEDS),
                lighting_breath_pixel(PULSE_AMBER_B, pulse_level, i, LIGHT_STRIP_NUM_LEDS));
        } else {
            PIXEL_SET(&s_pixels[i * 3], r8, g8, b8);
        }
    }

    esp_err_t err = rmt_transmit(s_tx_chan, s_encoder, s_pixels, sizeof(s_pixels), &s_tx_config);
    if (err != ESP_OK) return err;
    err = rmt_tx_wait_all_done(s_tx_chan, 100);
    if (err == ESP_OK) {
        s_rendered_level = !s_on ? 0 : (s_breathing ? pulse_level : peak_rgb(s_r, s_g, s_b) * 100);
    }
    return err;
}

esp_err_t lighting_init(void)
{
    if (s_inited) return ESP_OK;

    rmt_tx_channel_config_t chan_cfg = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .gpio_num = LIGHT_STRIP_GPIO,
        .mem_block_symbols = LIGHT_RMT_MEM_SYMBOLS,
        .resolution_hz = LIGHT_STRIP_RMT_RES,
        .trans_queue_depth = LIGHT_RMT_QUEUE_DEPTH,
    };
    esp_err_t err = rmt_new_tx_channel(&chan_cfg, &s_tx_chan);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "rmt channel err: %s", esp_err_to_name(err));
        return err;
    }

    err = light_new_encoder(LIGHT_STRIP_RMT_RES, &s_encoder);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "encoder err: %s", esp_err_to_name(err));
        return err;
    }

    err = rmt_enable(s_tx_chan);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "rmt enable err: %s", esp_err_to_name(err));
        return err;
    }

    s_lock = xSemaphoreCreateMutex();
    if (!s_lock) return ESP_ERR_NO_MEM;
    s_inited = true;

    /* Remember color, but never emit light before the boot safety check. */
    bool found = light_nvs_load();
    bool need_default = !found || (s_r | s_g | s_b) == 0;
    if (need_default) light_apply_default_warm();
    s_on = false;
    if (need_default) light_nvs_save();
    err = lighting_refresh(0);
    if (err != ESP_OK) return err;

    ESP_LOGI(TAG, "lighting init ok (WS2812B/SK6812, %u LEDs, gpio %d): %s rgb=%u,%u,%u",
             (unsigned)LIGHT_STRIP_NUM_LEDS, (int)LIGHT_STRIP_GPIO,
             s_on ? "ON" : "OFF", (unsigned)s_r, (unsigned)s_g, (unsigned)s_b);
    return ESP_OK;
}

void lighting_get_state(uint8_t *r, uint8_t *g, uint8_t *b, bool *enabled)
{
    lighting_get_output(r, g, b, enabled, NULL);
}

void lighting_get_output(uint8_t *r, uint8_t *g, uint8_t *b, bool *enabled, bool *breathing)
{
    if (s_lock) xSemaphoreTake(s_lock, portMAX_DELAY);
    if (r) *r=s_r;
    if (g) *g=s_g;
    if (b) *b=s_b;
    if (enabled) *enabled=s_on;
    if (breathing) *breathing=s_breathing;
    if (s_lock) xSemaphoreGive(s_lock);
}

void lighting_tick(uint64_t now_ms)
{
    if (!s_lock || xSemaphoreTake(s_lock, 0) != pdTRUE) return;
    if (s_breathing && now_ms >= s_pulse_next_ms) {
        s_pulse_next_ms = now_ms + PULSE_FRAME_MS;
        bool done;
        uint16_t level = light_pulse_level(&s_pulse, now_ms, &done);
        if (done) s_on = s_breathing = false;
        if (lighting_refresh(level) != ESP_OK) {
            s_on = s_breathing = false;
            lighting_refresh(0);
        }
    }
    xSemaphoreGive(s_lock);
}

static esp_err_t lighting_set_color(uint8_t r, uint8_t g, uint8_t b, bool breathing)
{
    if (!s_lock) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if ((r || g || b) && haptic_stop_latched()) {
        xSemaphoreGive(s_lock);
        return ESP_ERR_INVALID_STATE;
    }
    if (r > 100) r = 100;
    if (g > 100) g = 100;
    if (b > 100) b = 100;
    uint8_t peak = peak_rgb(r, g, b);
    if (breathing) {
        r = peak;
        g = (peak * PULSE_AMBER_G + 127) / 255;
        b = (peak * PULSE_AMBER_B + 127) / 255;
    }
    s_r = r; s_g = g; s_b = b;
    s_on = (r | g | b) != 0;   /* 全 0 视为熄灯 */
    s_breathing = breathing && s_on;
    if (s_breathing) {
        uint64_t now_ms = (uint64_t)esp_timer_get_time() / 1000;
        s_pulse = (light_pulse_t){ .started_ms = now_ms, .from = s_rendered_level, .peak = peak * 100 };
        s_pulse_next_ms = now_ms + PULSE_FRAME_MS;
    }
    esp_err_t err = lighting_refresh(s_rendered_level);
    if (s_breathing && err != ESP_OK) {
        s_on = s_breathing = false;
        lighting_refresh(0);
    }
    light_nvs_save();          /* 记忆颜色，重启自动恢复 */
    xSemaphoreGive(s_lock);
    return err;
}

esp_err_t lighting_set_level(uint8_t level)
{
    return lighting_set_color(level, level, level, false);
}

esp_err_t lighting_set_rgb(uint8_t r, uint8_t g, uint8_t b)
{
    return lighting_set_color(r, g, b, false);
}

esp_err_t lighting_set_breathing(uint8_t r, uint8_t g, uint8_t b)
{
    return lighting_set_color(r, g, b, true);
}

/* 物理按键调用：切换灯带整体亮灭，返回切换后的状态（true=亮）。
 * 开灯时若记忆颜色为空（如从未选色），自动套用默认暖色调，保证首次按键即亮。 */
static esp_err_t lighting_set_enabled_locked(bool enabled)
{
    s_on = enabled;
    s_breathing = false;
    if (s_on && (s_r | s_g | s_b) == 0) light_apply_default_warm();
    esp_err_t err = lighting_refresh(0);
    light_nvs_save();
    return err;
}

esp_err_t lighting_set_enabled(bool enabled)
{
    if (!s_lock) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    esp_err_t err = lighting_set_enabled_locked(enabled);
    xSemaphoreGive(s_lock);
    return err;
}

bool lighting_toggle(void)
{
    if (!s_lock) return false;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    bool enabled = !s_on;
    lighting_set_enabled_locked(enabled);
    xSemaphoreGive(s_lock);
    return enabled;
}

esp_err_t lighting_set_channel(uint8_t channel, uint8_t pct)
{
    if (pct > 100) pct = 100;
    if (channel > 2) return ESP_ERR_INVALID_ARG;
    if (!s_lock) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (channel == 0)      s_r = pct;
    else if (channel == 1) s_g = pct;
    else if (channel == 2) s_b = pct;
    s_on = (s_r | s_g | s_b) != 0;
    s_breathing = false;
    esp_err_t err = lighting_refresh(0);
    light_nvs_save();
    xSemaphoreGive(s_lock);
    return err;
}
