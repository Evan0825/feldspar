#pragma once

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* 音效文件名最大长度（不含扩展名） */
#define SFX_NAME_MAX        24

/* 音效格式（与 ble_protocol.h 的 SFX_FMT_* 保持一致）
 * 0 = PCM16LE 16kHz 单声道；1 = IMA-ADPCM（WAV 块格式，blockAlign=256） */
#define SFX_FMT_PCM16       0
#define SFX_FMT_IMA_ADPCM   1

/* 传输进度回调（BLE 回调上下文，勿阻塞）：sent/total 为有效载荷字节数 */
typedef void (*sfx_progress_cb_t)(uint32_t sent, uint32_t total);
/* 音效事件回调：如 "SFXDONE,<index>" / "SFXERR,<原因>"（BLE 回调上下文） */
typedef void (*sfx_event_cb_t)(const char *msg);

/* 初始化：挂载文件系统、创建 /ext/sfx 目录、扫描音效列表、启动播放任务 */
esp_err_t sfx_init(void);

/* 音效列表（index 从 1 开始） */
int      sfx_count(void);
bool     sfx_info(int index, char *name, size_t name_len, uint32_t *size, uint8_t *fmt);

/* 播放控制：index=0 表示按预设规则（轮播）自动选择 */
esp_err_t sfx_play(int index);
esp_err_t sfx_pause(void);
esp_err_t sfx_resume(void);
esp_err_t sfx_stop(void);
esp_err_t sfx_delete(int index);
bool     sfx_is_playing(void);
int      sfx_current(void);

/* 播放内置测试音（三段升调蜂鸣，文件不存在时自动生成 test.sfx）。
 * 返回播放的 index（>0），失败返回 0。 */
int      sfx_play_test(void);

/* 预设规则自动轮播开关（干预触发时按此选择曲目） */
void     sfx_set_auto(bool enable);
bool     sfx_auto_enabled(void);

/* ---- 接收通道（BLE 回调上下文调用）---- */
esp_err_t sfx_rx_begin(const char *name, uint32_t size, uint8_t fmt);
esp_err_t sfx_rx_data(const uint8_t *data, uint16_t len);
esp_err_t sfx_rx_end(uint32_t crc32, char *ok_msg, size_t ok_len,
                     char *err_msg, size_t err_len);
void     sfx_rx_abort(const char *reason);
bool     sfx_rx_active(void);
uint32_t sfx_rx_seq(void);          /* 期望的下一帧序号（供 NAK） */

void     sfx_set_progress_cb(sfx_progress_cb_t cb);
void     sfx_set_event_cb(sfx_event_cb_t cb);

#ifdef __cplusplus
}
#endif
