#include "acoustic_features.h"
#include "af_fft512.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

void af_reset(af_frontend_t *s) { s->count=0; }
void af_init(af_frontend_t *s) {
    memset(s, 0, sizeof(*s));
    for (int i=0;i<512;++i) s->hann[i]=.5f-.5f*cosf(2*3.14159265358979323846f*i/511);
    af_fft512_init();
}
static int compare_float(const void *a, const void *b) {
    float x=*(const float *)a, y=*(const float *)b;
    return (x>y)-(x<y);
}

af_features_t af_extract(af_frontend_t *s, const int16_t *pcm, size_t n,
                         bool capture_valid, bool self_noise) {
    af_features_t out={0};
    if (!pcm || n!=AF_SAMPLES || !capture_valid) out.quality_flags|=AF_GAP;
    if (self_noise) out.quality_flags|=AF_SELF_NOISE;
    if (!pcm || n!=AF_SAMPLES) { af_reset(s); return out; }
    double mean=0, energy=0;
    unsigned clipped=0;
    for (size_t i=0;i<n;++i) {
        mean+=pcm[i]/32768.;
        if (pcm[i]>=32760 || pcm[i]<=-32760) ++clipped;
    }
    mean/=n;
    for (size_t i=0;i<n;++i) { double x=pcm[i]/32768.-mean; energy+=x*x; }
    out.rms=(float)sqrt(energy/n);
    out.clipped_ratio=(float)clipped/n;
    if (clipped>=n/100) out.quality_flags|=AF_CLIPPED;
    if (out.rms<1e-4f) out.quality_flags|=AF_SILENT;
    if (out.quality_flags) { af_reset(s); return out; }

    double total=0, band=0;
    for (size_t start=0;start+512<=n;start+=256) {
        for (int i=0;i<512;++i) {
            s->real[i]=(float)(pcm[start+i]/32768.-mean)*s->hann[i];
            s->imag[i]=0;
        }
        af_fft512_forward(s->real,s->imag);
        for (int k=1;k<=256;++k) {
            double power=(double)s->real[k]*s->real[k]+(double)s->imag[k]*s->imag[k];
            total+=power;
            float hz=k*16000.f/512;
            if (hz>=100 && hz<=850) band+=power;
        }
    }
    out.band_ratio=(float)(band/fmax(total,1e-12));
    if (s->count==AF_CONTEXT_BLOCKS) {
        memmove(s->envelope,s->envelope+50,250*sizeof(float));
        s->count=250;
    }
    for (size_t block=0;block<50;++block) {
        double e=0;
        for (size_t i=0;i<320;++i) { double x=pcm[block*320+i]/32768.-mean; e+=x*x; }
        s->envelope[s->count++]=(float)sqrt(e/320);
    }
    out.context_blocks=(uint32_t)s->count;
    memcpy(s->scratch,s->envelope,s->count*sizeof(float));
    qsort(s->scratch,s->count,sizeof(float),compare_float);
    double rank=(s->count-1)*.2;
    size_t lo=(size_t)rank, hi=lo+1<s->count ? lo+1 : lo;
    double floor=s->scratch[lo]+(rank-lo)*(s->scratch[hi]-s->scratch[lo]);
    out.volume_ratio=(float)fmin(100.,out.rms/fmax(floor,1e-5));
    if (s->count<AF_CONTEXT_BLOCKS) { out.quality_flags=AF_WARMUP; return out; }

    double env_mean=0, zero_lag=0, best=0;
    for (size_t i=0;i<s->count;++i) env_mean+=s->envelope[i];
    env_mean/=s->count;
    for (size_t i=0;i<s->count;++i) { double x=s->envelope[i]-env_mean; zero_lag+=x*x; }
    for (size_t lag=20;lag<=100;++lag) {
        double correlation=0;
        for (size_t i=0;i+lag<s->count;++i)
            correlation+=(s->envelope[i]-env_mean)*(s->envelope[i+lag]-env_mean);
        if (correlation>best) best=correlation;
    }
    out.periodicity=(float)fmin(1.,best/fmax(zero_lag,1e-12));
    return out;
}
