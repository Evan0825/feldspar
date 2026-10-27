#include <assert.h>
#include <limits.h>
#include <stdio.h>
#include "mic_samples.h"

int main(void)
{
    assert(mic_rms_percent(0) == 0);
    assert(mic_rms_percent(328) == 1);
    assert(mic_rms_percent(16384) == 50);
    assert(mic_rms_percent(32768) == 100);
    assert(mic_rms_percent(UINT32_MAX) == 100);
    for (uint32_t i = 1; i <= 32768; ++i) {
        assert(mic_rms_percent(i) >= mic_rms_percent(i - 1));
        assert(mic_rms_percent(i) <= 100);
    }
    assert(mic_sample_to_pcm16(0) == 0);
    assert(mic_sample_to_pcm16(16384) == 1);
    assert(mic_sample_to_pcm16(-16384) == -1);
    assert(mic_sample_to_pcm16(INT32_MAX) == INT16_MAX);
    assert(mic_sample_to_pcm16(INT32_MIN) == INT16_MIN);
    assert(mic_sample_to_pcm16(536870912) == INT16_MAX);
    assert(mic_sample_to_pcm16(-536887296) == INT16_MIN);
    puts("Microphone conversion boundaries passed (host only).");
}
