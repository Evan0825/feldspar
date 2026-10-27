#pragma once

#include <stdint.h>
#include <stddef.h>
#include "esp_err.h"
#include "actuation_guard.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ERM 偏心轮震动马达模块（4pin：VCC/GND/NC/SIG）：SIG=GPIO42，LEDC PWM 调强度 */
esp_err_t haptic_erm_init(void);

/* Manual engineering ceiling: 10 s per start; adjustment never renews it. */
esp_err_t haptic_erm_set(uint8_t pct);
esp_err_t haptic_execute(const ag_request_t *request);
esp_err_t haptic_emergency_stop(void);
esp_err_t haptic_resume_manual(void);
bool haptic_stop_latched(void);
/* Commanded drive activity, not a physical vibration measurement; nonblocking. */
bool haptic_is_active(void);
void haptic_status_line(char *out, size_t size);

#ifdef __cplusplus
}
#endif
