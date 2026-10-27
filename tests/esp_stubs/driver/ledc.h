#pragma once
#include <stdint.h>
#include "esp_err.h"
enum { GPIO_NUM_42=42, LEDC_CHANNEL_4=4, LEDC_TIMER_1=1, LEDC_TIMER_11_BIT=11,
       LEDC_LOW_SPEED_MODE=0, LEDC_AUTO_CLK=0, LEDC_INTR_DISABLE=0 };
typedef struct { int speed_mode, timer_num, freq_hz, duty_resolution, clk_cfg; } ledc_timer_config_t;
typedef struct { int gpio_num, speed_mode, channel, timer_sel, intr_type, hpoint, duty; } ledc_channel_config_t;
esp_err_t ledc_timer_config(const ledc_timer_config_t *);
esp_err_t ledc_channel_config(const ledc_channel_config_t *);
esp_err_t ledc_set_duty(int, int, uint32_t);
esp_err_t ledc_update_duty(int, int);
