#include "sfx.h"

#include <string.h>
#include <stdio.h>
#include <math.h>
#include <dirent.h>
#include <sys/stat.h>
#include <errno.h>
#include "esp_log.h"
#include "esp_rom_crc.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "audio.h"
#include "storage.h"

static const char *TAG = "sfx";

/* ---- 文件布局：/ext/sfx/<name>.sfx ----
 * 文件头 16B："HMFX" + ver(1) + fmt(1) + rate u16 LE + 预留(8)
 * 载荷：fmt=0 PCM16LE / fmt=1 IMA-ADPCM（WAV 块格式，blockAlign=256） */
#ifndef SFX_DIR
#define SFX_DIR          "/ext/sfx"
#endif
#define SFX_EXT          ".sfx"
#define SFX_HEADER_SIZE  16
#define ADPCM_BLOCK_SIZE 256
#define ADPCM_SAMPLES_PER_BLOCK  ((ADPCM_BLOCK_SIZE - 4) * 2 + 1)   /* 505 */

static const char HEADER_MAGIC[4] = {'H', 'M', 'F', 'X'};

/* ---- IMA ADPCM 步长表 / 索引表（标准 WAV IMA）---- */
static const int16_t ima_step[89] = {
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31,
    34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
    157, 173, 190, 209, 229, 254, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658,
    724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499,
    2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630,
    9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623,
    27086, 29794, 32767,
};
static const int8_t ima_index_table[16] = {
    -1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8,
};

/* ---- 内部状态 ---- */
typedef struct {
    char     name[SFX_NAME_MAX + 1];
    uint32_t size;      /* 有效载荷字节数（不含 16B 头） */
    uint8_t  fmt;
} sfx_item_t;

static sfx_item_t s_list[16];
static int  s_count = 0;
static bool s_inited = false;

static QueueHandle_t s_play_queue;          /* 播放请求（index） */
typedef struct { int index; uint32_t epoch; } play_job_t;
static volatile uint32_t s_cancel_epoch;
static volatile bool s_pause_flag = false;
static volatile int  s_current = 0;         /* 正在播放的 index（0=无） */
static volatile bool s_auto = false;
static int  s_auto_next = 1;                /* 轮播游标 */

static sfx_progress_cb_t s_progress_cb = NULL;
static sfx_event_cb_t    s_event_cb = NULL;
static void emit_event(const char *msg);

/* ---- 接收态 ---- */
static FILE    *s_rx_file = NULL;
static char     s_rx_name[SFX_NAME_MAX + 1];
static uint32_t s_rx_total = 0, s_rx_written = 0, s_rx_crc = 0;
static uint8_t  s_rx_fmt = 0;
static bool     s_rx_active = false;
static uint32_t s_rx_seq = 0;
static uint8_t  s_last_pct = 0xFF;

/* ------------------------------------------------------------------ */
/* 列表管理                                                            */
/* ------------------------------------------------------------------ */

/* 读 16B 头，校验 magic/ver */
static bool read_header(FILE *f, uint8_t *fmt, uint32_t *payload)
{
    uint8_t h[SFX_HEADER_SIZE];
    if (fread(h, 1, sizeof(h), f) != sizeof(h)) return false;
    if (memcmp(h, HEADER_MAGIC, 4) != 0) return false;
    *fmt = h[5];
    *payload = (uint32_t)h[6] | ((uint32_t)h[7] << 8) |
               ((uint32_t)h[8] << 16) | ((uint32_t)h[9] << 24);
    return true;
}

static void refresh_list(void)
{
    s_count = 0;
    DIR *dir = opendir(SFX_DIR);
    if (dir == NULL) return;

    struct dirent *ent;
    while ((ent = readdir(dir)) != NULL && s_count < (int)(sizeof(s_list) / sizeof(s_list[0]))) {
        const char *dot = strrchr(ent->d_name, '.');
        if (dot == NULL || strcmp(dot, SFX_EXT) != 0) continue;

        char path[384];
        snprintf(path, sizeof(path), SFX_DIR "/%.240s", ent->d_name);
        struct stat st;
        if (stat(path, &st) != 0 || st.st_size <= SFX_HEADER_SIZE) continue;

        FILE *f = fopen(path, "rb");
        if (f == NULL) continue;
        uint8_t fmt; uint32_t payload;
        bool ok = read_header(f, &fmt, &payload);
        fclose(f);
        if (!ok) continue;

        sfx_item_t *it = &s_list[s_count];
        size_t n = (size_t)(dot - ent->d_name);
        if (n > SFX_NAME_MAX) n = SFX_NAME_MAX;
        memcpy(it->name, ent->d_name, n);
        it->name[n] = '\0';
        it->size = payload;
        it->fmt = fmt;
        s_count++;
    }
    closedir(dir);
}

int sfx_count(void) { return s_count; }

bool sfx_info(int index, char *name, size_t name_len, uint32_t *size, uint8_t *fmt)
{
    if (index < 1 || index > s_count) return false;
    const sfx_item_t *it = &s_list[index - 1];
    if (name && name_len > 0) {
        size_t n = strlen(it->name);
        if (n >= name_len) n = name_len - 1;
        memcpy(name, it->name, n);
        name[n] = '\0';
    }
    if (size) *size = it->size;
    if (fmt) *fmt = it->fmt;
    return true;
}

/* ------------------------------------------------------------------ */
/* IMA ADPCM 解码                                                      */
/* ------------------------------------------------------------------ */

static int16_t adpcm_nibble(uint8_t n, int *pred, int *idx)
{
    int step = ima_step[*idx];
    int diff = step >> 3;
    if (n & 4) diff += step;
    if (n & 2) diff += step >> 1;
    if (n & 1) diff += step >> 2;
    if (n & 8) diff = -diff;

    *pred += diff;
    if (*pred > 32767) *pred = 32767;
    if (*pred < -32768) *pred = -32768;
    *idx += ima_index_table[n];
    if (*idx < 0) *idx = 0;
    if (*idx > 88) *idx = 88;
    return (int16_t)*pred;
}

/* 解码一个 256B ADPCM 块 → 505 个 PCM 采样（1010B） */
static size_t adpcm_decode_block(const uint8_t *blk, int16_t *out)
{
    int pred = (int16_t)(blk[0] | (blk[1] << 8));
    int idx = blk[2];
    if (idx > 88) idx = 88;

    size_t count = 0;
    out[count++] = (int16_t)pred;
    for (int i = 4; i < ADPCM_BLOCK_SIZE; i++) {
        out[count++] = adpcm_nibble(blk[i] & 0x0F, &pred, &idx);
        out[count++] = adpcm_nibble(blk[i] >> 4, &pred, &idx);
    }
    return count;
}

/* ------------------------------------------------------------------ */
/* 播放任务                                                            */
/* ------------------------------------------------------------------ */

/* 把 PCM 喂给音频组件，缓冲满时等待重试 */
static void feed_pcm(const int16_t *pcm, size_t samples, uint32_t epoch)
{
    const uint8_t *p = (const uint8_t *)pcm;
    size_t remain = samples * 2;
    while (remain > 0 && epoch == s_cancel_epoch) {
        if (s_pause_flag) { vTaskDelay(pdMS_TO_TICKS(50)); continue; }
        esp_err_t err = audio_feed(p, remain);
        if (err == ESP_ERR_NO_MEM) {
            vTaskDelay(pdMS_TO_TICKS(20));   /* 环形缓冲满，稍候重试 */
            continue;
        }
        size_t took = (err == ESP_OK) ? remain : 0;
        if (took == 0) break;                 /* 其它错误放弃本段 */
        p += took;
        remain -= took;
    }
}

/* 读取并解码整个文件送入音频组件；返回 ESP_OK 表示播完 */
static esp_err_t play_file(int index, uint32_t epoch)
{
    if (epoch != s_cancel_epoch) return ESP_ERR_INVALID_STATE;
    char name[SFX_NAME_MAX + 1];
    uint32_t size; uint8_t fmt;
    if (!sfx_info(index, name, sizeof(name), &size, &fmt)) return ESP_ERR_NOT_FOUND;

    char path[384];
    snprintf(path, sizeof(path), SFX_DIR "/%.24s" SFX_EXT, name);
    FILE *f = fopen(path, "rb");
    if (f == NULL) {
        ESP_LOGE(TAG, "open %s failed", path);
        return ESP_ERR_NOT_FOUND;
    }

    uint8_t hfmt; uint32_t hsize;
    bool ok = read_header(f, &hfmt, &hsize);
    if (!ok || hsize != size) {
        fclose(f);
        ESP_LOGE(TAG, "header mismatch");
        return ESP_ERR_INVALID_STATE;
    }

    esp_err_t ret = ESP_OK;
    if (epoch != s_cancel_epoch) { fclose(f); return ESP_ERR_INVALID_STATE; }
    s_current = index;
    s_pause_flag = false;
    audio_flush();     /* 丢弃被打断歌曲可能残留的缓冲，确保新曲从静音起点开始 */
    ret = audio_start();
    if (ret != ESP_OK || epoch != s_cancel_epoch) {
        s_current = 0;
        audio_stop();
        fclose(f);
        return ret != ESP_OK ? ret : ESP_ERR_INVALID_STATE;
    }
    char ev[24];
    snprintf(ev, sizeof(ev), "SFXSTART,%d", index);
    emit_event(ev);

    if (fmt == SFX_FMT_IMA_ADPCM) {
        uint8_t blk[ADPCM_BLOCK_SIZE];
        int16_t pcm[ADPCM_SAMPLES_PER_BLOCK];
        uint32_t done = 0;
        while (done < size && s_current == index && epoch == s_cancel_epoch) {
            if (s_pause_flag) { vTaskDelay(pdMS_TO_TICKS(50)); continue; }
            size_t want = (size - done < sizeof(blk)) ? (size - done) : sizeof(blk);
            size_t got = fread(blk, 1, want, f);
            if (got == 0) break;
            if (got < sizeof(blk)) memset(blk + got, 0, sizeof(blk) - got);
            size_t n = adpcm_decode_block(blk, pcm);
            feed_pcm(pcm, n, epoch);
            done += got;
        }
    } else {
        uint8_t buf[1024];
        uint32_t done = 0;
        while (done < size && s_current == index && epoch == s_cancel_epoch) {
            if (s_pause_flag) { vTaskDelay(pdMS_TO_TICKS(50)); continue; }
            size_t want = (size - done < sizeof(buf)) ? (size - done) : sizeof(buf);
            want &= ~1UL;                     /* 16bit 对齐 */
            size_t got = fread(buf, 1, want, f);
            if (got == 0) break;
            feed_pcm((const int16_t *)buf, got / 2, epoch);
            done += got;
        }
    }

    fclose(f);
    if (s_current == index) {
        snprintf(ev, sizeof(ev), "SFXDONE,%d", index);
        emit_event(ev);
        s_current = 0;
        audio_stop();
    }
    return ret;
}

static esp_err_t stop_current(void)
{
    s_current = 0;
    s_pause_flag = false;
    return audio_stop();
}

static void play_task(void *arg)
{
    (void)arg;
    for (;;) {
        play_job_t job = {0};
        if (xQueueReceive(s_play_queue, &job, portMAX_DELAY) == pdTRUE) {
            if (job.epoch != s_cancel_epoch) continue;
            int index = job.index;
            if (index == 0) {
                /* 预设规则：轮播下一首 */
                if (s_count == 0) { emit_event("SFXERR,empty"); continue; }
                if (s_auto_next > s_count) s_auto_next = 1;
                index = s_auto_next++;
            }
            if (s_current != 0) stop_current();
            play_file(index, job.epoch);
        }
    }
}

esp_err_t sfx_play(int index)
{
    if (!s_inited) return ESP_ERR_INVALID_STATE;
    if (index > s_count) return ESP_ERR_NOT_FOUND;
    play_job_t job = {.index=index, .epoch=s_cancel_epoch};
    if (xQueueSend(s_play_queue, &job, 0) != pdTRUE) return ESP_ERR_NO_MEM;
    /* 无缝切换：新曲目入队成功后立即打断当前播放（含暂停态）。
     * 播放任务中的 play_file 循环检测到 s_current 变化后在数十毫秒内退出，
     * 随即从队列取出新曲目、从文件头开始播放。先入队后停止：
     * 若队列满则保持现状不打断，避免"停了旧歌却播不了新歌"。 */
    if (s_current != 0) stop_current();
    return ESP_OK;
}

esp_err_t sfx_pause(void)
{
    s_pause_flag = true;
    return audio_pause();
}

esp_err_t sfx_resume(void)
{
    s_pause_flag = false;
    return audio_resume();
}

esp_err_t sfx_stop(void)
{
    ++s_cancel_epoch;
    if (s_play_queue) xQueueReset(s_play_queue);
    return stop_current();
}

esp_err_t sfx_delete(int index)
{
    if (index < 1 || index > s_count) return ESP_ERR_NOT_FOUND;
    char path[384];
    snprintf(path, sizeof(path), SFX_DIR "/%.24s" SFX_EXT, s_list[index - 1].name);
    remove(path);
    refresh_list();
    ESP_LOGI(TAG, "deleted #%d (%s), count=%d", index, path, s_count);
    return ESP_OK;
}

bool sfx_is_playing(void) { return s_current != 0; }
int  sfx_current(void)    { return s_current; }
void sfx_set_auto(bool enable) { s_auto = enable; }
bool sfx_auto_enabled(void)    { return s_auto; }

/* ------------------------------------------------------------------ */
/* 接收通道                                                            */
/* ------------------------------------------------------------------ */

bool sfx_rx_active(void) { return s_rx_active; }
uint32_t sfx_rx_seq(void) { return s_rx_seq; }

void sfx_set_progress_cb(sfx_progress_cb_t cb) { s_progress_cb = cb; }
void sfx_set_event_cb(sfx_event_cb_t cb)       { s_event_cb = cb; }

static void emit_event(const char *msg)
{
    if (s_event_cb) s_event_cb(msg);
}

static void emit_progress(void)
{
    if (s_progress_cb && s_rx_total > 0) {
        uint8_t pct = (uint8_t)((uint64_t)s_rx_written * 100 / s_rx_total);
        if (pct != s_last_pct) {          /* 每 1% 变化推送一次 */
            s_last_pct = pct;
            s_progress_cb(s_rx_written, s_rx_total);
        }
    }
}

esp_err_t sfx_rx_begin(const char *name, uint32_t size, uint8_t fmt)
{
    if (s_rx_active) { sfx_rx_abort("busy"); return ESP_ERR_INVALID_STATE; }
    if (name == NULL || name[0] == '\0' || size == 0) return ESP_ERR_INVALID_ARG;
    if (fmt != SFX_FMT_PCM16 && fmt != SFX_FMT_IMA_ADPCM) return ESP_ERR_INVALID_ARG;

    /* 剩余空间检查：预留 8KB */
    uint64_t total = 0, free_b = 0;
    if (storage_fatfs_info(&total, &free_b) != ESP_OK) return ESP_ERR_INVALID_STATE;
    if (free_b < (uint64_t)size + 8192) return ESP_ERR_NO_MEM;

    remove(SFX_DIR "/~tmp" SFX_EXT);      /* 清掉上次失败残留 */
    FILE *f = fopen(SFX_DIR "/~tmp" SFX_EXT, "wb");
    if (f == NULL) return ESP_FAIL;

    uint8_t h[SFX_HEADER_SIZE] = {0};
    memcpy(h, HEADER_MAGIC, 4);
    h[4] = 1;                              /* ver */
    h[5] = fmt;
    h[6] = (uint8_t)(size);
    h[7] = (uint8_t)(size >> 8);
    h[8] = (uint8_t)(size >> 16);
    h[9] = (uint8_t)(size >> 24);
    if (fwrite(h, 1, sizeof(h), f) != sizeof(h)) {
        fclose(f);
        return ESP_FAIL;
    }

    snprintf(s_rx_name, sizeof(s_rx_name), "%s", name);
    s_rx_file = f;
    s_rx_total = size;
    s_rx_written = 0;
    s_rx_crc = 0;
    s_rx_fmt = fmt;
    s_rx_seq = 0;
    s_rx_active = true;
    s_last_pct = 0xFF;
    ESP_LOGI(TAG, "rx begin: '%s' %lu bytes fmt=%u", s_rx_name,
             (unsigned long)size, fmt);
    return ESP_OK;
}

esp_err_t sfx_rx_data(const uint8_t *data, uint16_t len)
{
    if (!s_rx_active || s_rx_file == NULL) return ESP_ERR_INVALID_STATE;
    if (s_rx_written + len > s_rx_total) return ESP_ERR_INVALID_SIZE;

    s_rx_crc = esp_rom_crc32_le(s_rx_crc, data, len);
    if (fwrite(data, 1, len, s_rx_file) != len) return ESP_FAIL;
    s_rx_written += len;
    s_rx_seq++;                       /* 收到一帧有效载荷，期望序号 +1 */
    emit_progress();

    if (s_rx_written >= s_rx_total) {
        fclose(s_rx_file);
        s_rx_file = NULL;
    }
    return ESP_OK;
}

esp_err_t sfx_rx_end(uint32_t crc32, char *ok_msg, size_t ok_len,
                     char *err_msg, size_t err_len)
{
    if (!s_rx_active) {
        snprintf(err_msg, err_len, "inactive");
        return ESP_ERR_INVALID_STATE;
    }
    if (s_rx_written != s_rx_total) {
        snprintf(err_msg, err_len, "short,%lu/%lu",
                 (unsigned long)s_rx_written, (unsigned long)s_rx_total);
        sfx_rx_abort("short");
        return ESP_ERR_INVALID_SIZE;
    }
    if (s_rx_crc != crc32) {
        snprintf(err_msg, err_len, "crc,%08lx!=%08lx",
                 (unsigned long)s_rx_crc, (unsigned long)crc32);
        sfx_rx_abort("crc");
        return ESP_ERR_INVALID_CRC;
    }

    /* 同名覆盖：先删旧文件，再重命名临时文件 */
    char path[384];
    snprintf(path, sizeof(path), SFX_DIR "/%.24s" SFX_EXT, s_rx_name);
    remove(path);
    if (rename(SFX_DIR "/~tmp" SFX_EXT, path) != 0) {
        snprintf(err_msg, err_len, "rename");
        sfx_rx_abort("rename");
        return ESP_FAIL;
    }

    s_rx_active = false;
    refresh_list();
    /* 找到新文件所在 index */
    int idx = 0;
    for (int i = 0; i < s_count; i++) {
        if (strcmp(s_list[i].name, s_rx_name) == 0) { idx = i + 1; break; }
    }
    snprintf(ok_msg, ok_len, "FILEOK,%d,%s", idx, s_rx_name);
    ESP_LOGI(TAG, "rx ok: #%d '%s' %lu bytes crc ok, count=%d",
             idx, s_rx_name, (unsigned long)s_rx_total, s_count);
    return ESP_OK;
}

void sfx_rx_abort(const char *reason)
{
    if (s_rx_file) { fclose(s_rx_file); s_rx_file = NULL; }
    s_rx_active = false;
    remove(SFX_DIR "/~tmp" SFX_EXT);
    ESP_LOGW(TAG, "rx abort: %s", reason);
}

/* ------------------------------------------------------------------ */
/* 内置测试音                                                          */
/* ------------------------------------------------------------------ */

/* 生成 test.sfx（fmt=0 PCM16LE 16kHz 单声道）：三段升调蜂鸣
 * 660/990/1320Hz 各 0.3s，间隔 0.12s，带 8ms 淡入淡出，约 1.14s 总长。
 * 用于快速验证 FATFS 读取 → 播放任务 → I2S → 功放整条链路。 */
static esp_err_t ensure_test_file(void)
{
    const char *path = SFX_DIR "/test" SFX_EXT;
    struct stat st;
    if (stat(path, &st) == 0 && st.st_size > SFX_HEADER_SIZE) return ESP_OK;

    const uint32_t RATE = 16000;
    const uint32_t BEEP = RATE * 3 / 10;      /* 每段 0.3s = 4800 样本 */
    const uint32_t GAP  = RATE * 12 / 100;    /* 间隔 0.12s = 1920 样本 */
    const uint32_t FADE = RATE * 8 / 1000;    /* 8ms 淡入淡出 */
    const uint32_t TOTAL_SAMPLES = BEEP * 3 + GAP * 2;
    const uint32_t PAYLOAD = TOTAL_SAMPLES * 2;
    static const float FREQ[3] = {660.0f, 990.0f, 1320.0f};

    FILE *f = fopen(path, "wb");
    if (f == NULL) {
        ESP_LOGE(TAG, "create test.sfx failed");
        return ESP_FAIL;
    }

    uint8_t h[SFX_HEADER_SIZE] = {0};
    memcpy(h, HEADER_MAGIC, 4);
    h[4] = 1;                                /* ver */
    h[5] = SFX_FMT_PCM16;
    h[6] = (uint8_t)(PAYLOAD);
    h[7] = (uint8_t)(PAYLOAD >> 8);
    h[8] = (uint8_t)(PAYLOAD >> 16);
    h[9] = (uint8_t)(PAYLOAD >> 24);

    esp_err_t ret = ESP_OK;
    if (fwrite(h, 1, sizeof(h), f) != sizeof(h)) ret = ESP_FAIL;

    /* 按样本序号定位所在段并合成（无需整段缓冲） */
    int16_t buf[256];
    uint32_t pos = 0;
    while (ret == ESP_OK && pos < TOTAL_SAMPLES) {
        size_t n = (TOTAL_SAMPLES - pos < 256) ? (size_t)(TOTAL_SAMPLES - pos) : 256;
        for (size_t i = 0; i < n; i++) {
            uint32_t s = pos + i;
            int seg = -1;
            uint32_t off = 0;
            if (s < BEEP) {
                seg = 0; off = s;
            } else if (s < BEEP + GAP) {
                buf[i] = 0; continue;
            } else if (s < BEEP * 2 + GAP) {
                seg = 1; off = s - BEEP - GAP;
            } else if (s < BEEP * 2 + GAP * 2) {
                buf[i] = 0; continue;
            } else {
                seg = 2; off = s - BEEP * 2 - GAP * 2;
            }
            float v = sinf(2.0f * (float)M_PI * FREQ[seg] * off / RATE) * 11000.0f;
            if (off < FADE) v *= (float)off / FADE;
            else if (off > BEEP - FADE) v *= (float)(BEEP - off) / FADE;
            buf[i] = (int16_t)v;
        }
        if (fwrite(buf, sizeof(int16_t), n, f) != n) ret = ESP_FAIL;
        pos += n;
    }

    if (fclose(f) != 0) ret = ESP_FAIL;
    if (ret == ESP_OK) {
        ESP_LOGI(TAG, "test.sfx created (%lu bytes, 3 beeps)",
                 (unsigned long)(PAYLOAD + SFX_HEADER_SIZE));
    } else {
        remove(path);
        ESP_LOGE(TAG, "write test.sfx failed");
    }
    return ret;
}

int sfx_play_test(void)
{
    if (!s_inited) return 0;
    if (ensure_test_file() != ESP_OK) return 0;
    refresh_list();
    for (int i = 1; i <= s_count; i++) {
        char name[SFX_NAME_MAX + 1];
        sfx_info(i, name, sizeof(name), NULL, NULL);
        if (strcmp(name, "test") == 0) {
            return (sfx_play(i) == ESP_OK) ? i : 0;
        }
    }
    ESP_LOGE(TAG, "test.sfx not found after create");
    return 0;
}

/* ------------------------------------------------------------------ */

esp_err_t sfx_init(void)
{
    if (s_inited) return ESP_OK;
    if (!storage_fatfs_mounted()) {
        esp_err_t err = storage_mount_fatfs();
        if (err != ESP_OK) return err;
    }

    mkdir(SFX_DIR, 0775);                  /* 已存在则忽略 */
    ensure_test_file();                    /* 首次启动生成内置测试音 */
    refresh_list();

    s_play_queue = xQueueCreate(4, sizeof(play_job_t));
    if (s_play_queue == NULL) return ESP_ERR_NO_MEM;
    if (xTaskCreate(play_task, "sfx_play", 6144, NULL, 6, NULL) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }

    s_inited = true;
    uint64_t total = 0, free_b = 0;
    storage_fatfs_info(&total, &free_b);
    ESP_LOGI(TAG, "sfx init ok: %d files, free %llu KB", s_count,
             (unsigned long long)(free_b >> 10));
    return ESP_OK;
}
