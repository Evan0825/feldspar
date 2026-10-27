#pragma once

#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"
#include "acoustic_features.h"

#ifdef __cplusplus
extern "C" {
#endif

/* INMP441 I2S 数字 MEMS 麦克风（I2S1 RX：SCK=GPIO15, WS=GPIO16, SD=GPIO17）
 * 16kHz 单声道；L/R 接 GND 选择左声道。与音频播放（I2S0）外设完全隔离。 */

/* 初始化 I2S1 接收通道并启动电平采集任务（持续读取，不阻塞系统） */
esp_err_t mic_init(void);

/* 诊断模式：on=true 时每秒经上报回调推送一行 "MIC,<rms>,<peak>"（均为 0-100），
 * 同时串口打印电平；false 停止上报（采集任务不停，供后续鼾声检测使用） */
void mic_diag(bool on);

/* 注册诊断上报回调（由 BLE 层注入，避免 mic 组件反向依赖 ble） */
void mic_set_report_cb(void (*cb)(const char *msg));

/* 读取最近 1 秒窗口的电平（0-100），rms=均方根响度，peak=峰值 */
void mic_get_level(uint8_t *rms, uint8_t *peak);
/* Callback must copy to a bounded queue and return without network/flash waits. */
void mic_set_feature_cb(bool (*callback)(const af_features_t *features));

#ifdef __cplusplus
}
#endif
