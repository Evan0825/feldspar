#include "device_control.h"
#include <stddef.h>
#include "haptic.h"
#include "sfx.h"
#include "audio.h"
#include "lighting.h"

esp_err_t device_control_stop_all(void) {
    /* Mute before flash persistence; a queued player must not become audible. */
    audio_set_volume(0);
    esp_err_t motor = haptic_emergency_stop();
    sfx_set_auto(false);
    esp_err_t sound = sfx_stop();
    esp_err_t stream = audio_stop();
    esp_err_t light = lighting_set_enabled(false);
    if (motor != ESP_OK) return motor;
    if (sound != ESP_OK) return sound;
    if (stream != ESP_OK) return stream;
    return light;
}

esp_err_t device_control_toggle_light(void) {
    bool enabled = false;
    lighting_get_state(NULL, NULL, NULL, &enabled);
    if (!enabled && haptic_stop_latched()) return ESP_ERR_INVALID_STATE;
    return lighting_set_enabled(!enabled);
}
