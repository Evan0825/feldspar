#pragma once
#include "esp_err.h"

/* Global stop never restarts remembered sounds or outputs. */
esp_err_t device_control_stop_all(void);

/* Short press may turn off; a latched global stop cannot be reopened. */
esp_err_t device_control_toggle_light(void);
