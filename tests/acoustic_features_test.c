#include "acoustic_features.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

static af_frontend_t frontend;
static int16_t pcm[AF_SAMPLES];
int main(int argc, char **argv) {
    af_init(&frontend);
    if (argc == 2) {
        FILE *f=fopen(argv[1], "rb"); assert(f);
        while (fread(pcm, sizeof(int16_t), AF_SAMPLES, f) == AF_SAMPLES) {
            af_features_t a=af_extract(&frontend, pcm, AF_SAMPLES, true, false);
            printf("%u,%u,%.9g,%.9g,%.9g,%.9g\n", a.quality_flags, a.context_blocks,
                a.rms, a.band_ratio, a.volume_ratio, a.periodicity);
        }
        fclose(f); return 0;
    }
    af_features_t a=af_extract(&frontend, pcm, AF_SAMPLES, true, false);
    assert(a.quality_flags & AF_SILENT);
    for (int second=0; second<6; ++second) {
        for (int i=0;i<AF_SAMPLES;++i) {
            double t=second+(double)i/AF_SAMPLES;
            pcm[i]=(int16_t)(6000*(0.55+0.45*sin(2*3.141592653589793*.8*t))*sin(2*3.141592653589793*250*t));
        }
        a=af_extract(&frontend, pcm, AF_SAMPLES, true, false);
    }
    assert(a.quality_flags == 0 && a.band_ratio > .99f && a.periodicity > .5f);
    a=af_extract(&frontend, pcm, AF_SAMPLES, true, true);
    assert(a.quality_flags & AF_SELF_NOISE);
    assert(frontend.count == 0);
    a=af_extract(&frontend, pcm, AF_SAMPLES, false, false);
    assert(a.quality_flags & AF_GAP);
    memset(pcm, 0x7f, sizeof(pcm)); /* not full scale; explicit saturation next */
    for (int i=0;i<AF_SAMPLES;++i) pcm[i]=i%2 ? INT16_MAX : INT16_MIN;
    a=af_extract(&frontend, pcm, AF_SAMPLES, true, false);
    assert(a.quality_flags & AF_CLIPPED);
    assert(frontend.count == 0);
    puts("Versioned acoustic feature quality and context checks passed (host only).");
}
