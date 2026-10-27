#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define AF_VERSION "feldspar-features-v1"
#define AF_SAMPLES 16000
#define AF_CONTEXT_BLOCKS 300
enum { AF_GAP=1, AF_SELF_NOISE=2, AF_CLIPPED=4, AF_SILENT=8, AF_WARMUP=16 };
typedef struct {
    uint32_t sequence, quality_flags, context_blocks;
    uint64_t monotonic_end_ms;
    float rms, band_ratio, volume_ratio, periodicity, clipped_ratio;
} af_features_t;
typedef struct {
    float envelope[AF_CONTEXT_BLOCKS], scratch[AF_CONTEXT_BLOCKS];
    float real[512], imag[512], hann[512];
    size_t count;
} af_frontend_t;

/* One owner/task; no model weights or actuator calls. Invalid windows clear history. */
void af_init(af_frontend_t *state);
void af_reset(af_frontend_t *state);
af_features_t af_extract(af_frontend_t *state, const int16_t *pcm, size_t count,
                         bool capture_valid, bool self_noise);
