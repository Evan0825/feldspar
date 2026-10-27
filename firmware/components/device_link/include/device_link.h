#pragma once
#include "esp_err.h"
#include "acoustic_features.h"

/* Opt-in only; requires device-specific credentials already provisioned in NVS. */
esp_err_t device_link_init(void);
bool device_link_enabled(void);
bool device_link_enqueue_features(const af_features_t *features);
