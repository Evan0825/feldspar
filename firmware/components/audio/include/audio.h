#pragma once

#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    AUDIO_STATE_STOPPED = 0,
    AUDIO_STATE_PLAYING,
    AUDIO_STATE_PAUSED,
} audio_state_t;

/* I2S 播放参数：BLE 传输的 PCM 采用 16bit 单声道 */
#define AUDIO_SAMPLE_RATE   16000
#define AUDIO_BIT_WIDTH     16
#define AUDIO_CHANNELS      1

/* 初始化 I2S 发送通道并创建工作队列（不自动开始播放） */
esp_err_t audio_init(void);

/* 开始/恢复播放，PCM 数据通过 audio_feed 送入环形缓冲 */
esp_err_t audio_start(void);
esp_err_t audio_resume(void);

/* 暂停播放（保持 I2S 通道使能，停喂数据） */
esp_err_t audio_pause(void);

/* 停止播放并清空缓冲、关闭 I2S 通道 */
esp_err_t audio_stop(void);

/* 清空播放缓冲（不改变播放状态）：曲目无缝切换时丢弃上曲残留数据 */
esp_err_t audio_flush(void);

/* 将一段 PCM 数据推入环形缓冲（由 BLE 音频数据特征回调调用）。
 * 仅播放中接受数据；len 为 2 的倍数，否则返回 ESP_ERR_INVALID_ARG。 */
esp_err_t audio_feed(const uint8_t *pcm, size_t len);

/* 设置音量 0-100 */
esp_err_t audio_set_volume(uint8_t volume);

/* 查询当前播放状态 */
audio_state_t audio_get_state(void);
uint8_t audio_get_volume(void);

#ifdef __cplusplus
}
#endif
