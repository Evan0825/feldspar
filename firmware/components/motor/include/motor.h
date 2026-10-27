#pragma once

#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* 初始化电机 PWM（调速）与方向 GPIO */
esp_err_t motor_init(void);

/* 设置速度：-100..100，负数为反转。0 为停止。 */
esp_err_t motor_set_speed(int16_t speed);

/* 立即停机（占空比归零） */
esp_err_t motor_stop(void);

#ifdef __cplusplus
}
#endif
