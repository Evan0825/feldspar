#pragma once

#include <stdint.h>

/* Pure conversion helpers, shared by acquisition and host regression tests. */
static inline int16_t mic_sample_to_pcm16(int32_t sample)
{
    /* Preserve the existing gain, but saturate instead of wrapping loud input. */
    int32_t scaled = sample / 16384;
    if (scaled > INT16_MAX) return INT16_MAX;
    if (scaled < INT16_MIN) return INT16_MIN;
    return (int16_t)scaled;
}

static inline uint8_t mic_rms_percent(uint32_t rms)
{
    if (rms >= 32768) return 100;
    return (uint8_t)((rms * 100U + 16384U) / 32768U);
}
