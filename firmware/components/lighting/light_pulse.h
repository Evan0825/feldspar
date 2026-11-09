#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef struct {
    uint64_t started_ms;
    uint16_t from;
    uint16_t peak;
} light_pulse_t;

/* Manual bench profile, levels in hundredths of a percent. */
static inline uint16_t light_pulse_level(const light_pulse_t *pulse, uint64_t now_ms, bool *done)
{
    uint64_t elapsed = now_ms - pulse->started_ms;
    *done = elapsed >= 5000;
    if (*done) return 0;
    if (elapsed < 2000) {
        int32_t delta = (int32_t)pulse->peak - pulse->from;
        return (uint16_t)(pulse->from + delta * (int32_t)elapsed / 2000);
    }
    if (elapsed < 3000) return pulse->peak;
    return (uint16_t)(pulse->peak * (5000 - elapsed) / 2000);
}
