#pragma once

#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* 初始化单线数字灯带（WS2812B/SK6812，RMT TX，S=GPIO8，10 灯珠） */
esp_err_t lighting_init(void);

/* 设置灯带亮度：0-100，RGB 同值（等效白色） */
esp_err_t lighting_set_level(uint8_t level);

/* 设置灯带颜色：r/g/b 各 0-100，全部灯珠同色；颜色写入 NVS，重启自动恢复 */
esp_err_t lighting_set_rgb(uint8_t r, uint8_t g, uint8_t b);

/* 物理按键调用：切换灯带整体亮灭（恢复上次颜色 / 熄灭），返回切换后状态 true=亮 */
bool lighting_toggle(void);
/* Preserve remembered RGB when stopping outputs. */
esp_err_t lighting_set_enabled(bool enabled);
void lighting_get_state(uint8_t *r, uint8_t *g, uint8_t *b, bool *enabled);

/* 单独设置某一通道：channel 0=R 1=G 2=B，pct 0-100 */
esp_err_t lighting_set_channel(uint8_t channel, uint8_t pct);

#ifdef __cplusplus
}
#endif
