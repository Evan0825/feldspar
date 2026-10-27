// DSP reference: snoring-ml-training commit 58ae1312; no classifier weights.
#pragma once
/* Radix-2 complex FFT, N = 512, float32. Firmware may replace this with esp-dsp
 * (dsps_fft2r_fc32) as long as the host parity tests still pass. */
void af_fft512_init(void);
void af_fft512_forward(float *re, float *im);
void af_fft512_inverse(float *re, float *im); /* includes the 1/N scale */
