#include <assert.h>
#include <stdio.h>
#include "breath_pixel.h"
#include "light_pulse.h"

static unsigned strip_sum(uint8_t channel, uint16_t level)
{
    unsigned total = 0;
    for (unsigned pixel = 0; pixel < 10; pixel++) {
        total += lighting_breath_pixel(channel, level, pixel, 10);
    }
    return total;
}

int main(void)
{
    assert(strip_sum(255, 60) == 15);
    assert(strip_sum(132, 60) == 8);
    assert(strip_sum(34, 60) == 2);
    assert(strip_sum(0, 10000) == 0);
    assert(strip_sum(255, 10000) == 2550);
    light_pulse_t pulse = { .started_ms = 100, .from = 2000, .peak = 6000 };
    bool done = false;
    assert(light_pulse_level(&pulse, 100, &done) == 2000 && !done);
    assert(light_pulse_level(&pulse, 1100, &done) == 4000 && !done);
    assert(light_pulse_level(&pulse, 2100, &done) == 6000 && !done);
    assert(light_pulse_level(&pulse, 3100, &done) == 6000 && !done);
    assert(light_pulse_level(&pulse, 4100, &done) == 3000 && !done);
    assert(light_pulse_level(&pulse, 5100, &done) == 0 && done);
    assert(light_pulse_level(&pulse, 7000, &done) == 0 && done);
    pulse = (light_pulse_t){ .started_ms = 7000, .from = 6000, .peak = 2000 };
    assert(light_pulse_level(&pulse, 7000, &done) == 6000 && !done);
    assert(light_pulse_level(&pulse, 8000, &done) == 4000 && !done);
    assert(light_pulse_level(&pulse, 9000, &done) == 2000 && !done);
    puts("Amber pulse preserves dim channels, retargets from current level and completes once.");
}
