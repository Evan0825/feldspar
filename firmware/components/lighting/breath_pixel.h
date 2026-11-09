#pragma once

#include <stdint.h>

static inline uint8_t lighting_breath_pixel(uint8_t channel, uint16_t level,
                                            uint32_t pixel, uint32_t count)
{
    /* Round once for the whole strip. Neighboring pixels differ by at most
     * one PWM count, so weak color channels survive at the dim end. */
    uint32_t total = ((uint32_t)channel * level * count + 5000) / 10000;
    return (uint8_t)(((pixel + 1) * total / count) - (pixel * total / count));
}
