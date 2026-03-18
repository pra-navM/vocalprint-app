// ============================================================
// DSP FUNCTIONS — Envelope-based Spatiotemporal Index
// Citations: Howell et al. (2009), Benham et al. (2023),
//            Vuolo & Wisler (2024), Wisler et al. (2022),
//            Smith et al. (1995), Smith & Goffman (1998)
// ============================================================

export const ENVELOPE_POINTS = 1000;
export const STI_POINT_INDICES = Array.from({ length: 50 }, (_, i) => 10 + i * 20); // 10,30,50,...,990

/**
 * Lanczos approximation of the Gamma function.
 * Used for bias correction formula (Wisler et al. 2022).
 */
export function gammaFn(z) {
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gammaFn(1 - z));
  z -= 1;
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

/**
 * Step 1a — Half-wave rectification (Howell et al. 2009; Benham et al. 2023):
 * "setting negative values to zero". This preserves only the positive
 * excursions of the acoustic waveform, unlike full-wave (abs) rectification.
 */
export function halfWaveRectify(samples) {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = samples[i] > 0 ? samples[i] : 0;
  }
  return out;
}

/**
 * Step 1b — 15 Hz low-pass IIR filter (Howell et al. 2009; Benham et al. 2023).
 * 1st-order RC low-pass: y[n] = alpha*x[n] + (1-alpha)*y[n-1]
 * where alpha = 1 / (1 + fs / (2*pi*15))
 * This approximates the Butterworth low-pass used in the literature.
 */
export function lowPass15Hz(samples, sampleRate) {
  const cutoff = 15;
  const alpha = 1.0 / (1.0 + sampleRate / (2.0 * Math.PI * cutoff));
  const out = new Float32Array(samples.length);
  out[0] = alpha * samples[0];
  for (let i = 1; i < samples.length; i++) {
    out[i] = alpha * samples[i] + (1 - alpha) * out[i - 1];
  }
  return out;
}

/**
 * Downmix stereo to mono by averaging channels.
 */
export function toMono(audioBuffer) {
  if (audioBuffer.numberOfChannels === 1) return audioBuffer.getChannelData(0);
  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = audioBuffer.getChannelData(1);
  const mono = new Float32Array(ch0.length);
  for (let i = 0; i < ch0.length; i++) mono[i] = (ch0[i] + ch1[i]) / 2;
  return mono;
}

/**
 * Full envelope extraction pipeline (Steps 1a + 1b).
 * Returns the amplitude envelope E(t) for display and later parsing.
 */
export function extractEnvelope(monoSamples, sampleRate) {
  const rectified = halfWaveRectify(monoSamples);
  return lowPass15Hz(rectified, sampleRate);
}

/**
 * Step 3 — Amplitude normalization via z-scoring (Smith et al. 1995).
 * Removes differences in overall loudness between repetitions.
 * For each parsed segment: subtract mean, divide by SD.
 */
export function zScoreNormalize(segment) {
  const n = segment.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += segment[i];
  const mean = sum / n;
  let ssq = 0;
  for (let i = 0; i < n; i++) ssq += (segment[i] - mean) ** 2;
  const sd = Math.sqrt(ssq / n);
  const out = new Float32Array(n);
  if (sd === 0) return out; // silence — return zeros
  for (let i = 0; i < n; i++) out[i] = (segment[i] - mean) / sd;
  return out;
}

/**
 * Step 4 — Time normalization via linear interpolation resampling to 1,000 points
 * (Smith et al. 1995). Removes differences in speaking rate and duration.
 * For target index i in [0, 999]: p = i * (L-1)/999,
 * then interpolate between floor(p) and ceil(p).
 */
export function resampleLinear(segment, targetLen = ENVELOPE_POINTS) {
  const L = segment.length;
  if (L === 0) return new Float32Array(targetLen);
  if (L === 1) { const o = new Float32Array(targetLen); o.fill(segment[0]); return o; }
  const out = new Float32Array(targetLen);
  for (let i = 0; i < targetLen; i++) {
    const p = i * (L - 1) / (targetLen - 1);
    const lo = Math.floor(p);
    const hi = Math.min(lo + 1, L - 1);
    const frac = p - lo;
    out[i] = segment[lo] * (1 - frac) + segment[hi] * frac;
  }
  return out;
}

/**
 * Process a single recording: extract segment, z-score, resample to 1000 pts.
 */
export function computeNormalizedEnvelope(envelope, sampleRate, onset, offset) {
  const startIdx = Math.round(onset * sampleRate);
  const endIdx = Math.round(offset * sampleRate);
  if (endIdx <= startIdx) return null;
  const segment = envelope.slice(startIdx, endIdx);
  const zScored = zScoreNormalize(segment);
  return resampleLinear(zScored);
}

/**
 * Step 5 — STI calculation (Smith et al. 1995; Howell et al. 2009).
 * At each of 50 equally-spaced points (indices 10, 30, 50, ..., 990
 * out of 1,000), compute the sample SD across N repetitions
 * using Bessel's correction: sigma = sqrt( (1/(N-1)) * sum(xi - xbar)^2 ).
 * Sum the 50 SDs -> STI.
 */
export function calculateSTI(normalizedEnvelopes) {
  const N = normalizedEnvelopes.length;
  if (N < 2) return { sti: null, sdProfile: [], perPointSDs: [] };
  const perPointSDs = [];
  for (const idx of STI_POINT_INDICES) {
    const values = normalizedEnvelopes.map(env => env[idx]);
    const mean = values.reduce((a, b) => a + b, 0) / N;
    const ssq = values.reduce((a, v) => a + (v - mean) ** 2, 0);
    const sd = Math.sqrt(ssq / (N - 1)); // Bessel's correction
    perPointSDs.push({ index: idx, normalizedTime: idx / 10, sd });
  }
  const sti = perPointSDs.reduce((sum, p) => sum + p.sd, 0);
  return { sti, sdProfile: perPointSDs, perPointSDs };
}

/**
 * Bias-corrected STI (Wisler et al. 2022).
 * STI_c = STI * sqrt((N-1)/2) * Gamma((N-1)/2) / Gamma(N/2)
 * Corrects systematic underestimation when fewer repetitions are used.
 */
export function biasCorrectSTI(sti, N) {
  if (N < 2) return sti;
  return sti * Math.sqrt((N - 1) / 2) * gammaFn((N - 1) / 2) / gammaFn(N / 2);
}
