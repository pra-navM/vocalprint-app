import { describe, it, expect } from 'vitest';
import {
  gammaFn, halfWaveRectify, lowPass15Hz, zScoreNormalize,
  resampleLinear, calculateSTI, biasCorrectSTI, extractEnvelope,
  computeNormalizedEnvelope, ENVELOPE_POINTS, STI_POINT_INDICES,
  detectOnsetOffset,
} from './dsp.js';

// ============================================================
// gammaFn
// ============================================================
describe('gammaFn', () => {
  it('computes factorial values: Gamma(n) = (n-1)!', () => {
    expect(gammaFn(1)).toBeCloseTo(1, 10);       // 0! = 1
    expect(gammaFn(2)).toBeCloseTo(1, 10);       // 1! = 1
    expect(gammaFn(3)).toBeCloseTo(2, 10);       // 2! = 2
    expect(gammaFn(4)).toBeCloseTo(6, 8);        // 3! = 6
    expect(gammaFn(5)).toBeCloseTo(24, 7);       // 4! = 24
    expect(gammaFn(6)).toBeCloseTo(120, 6);      // 5! = 120
  });

  it('computes Gamma(0.5) = sqrt(pi)', () => {
    expect(gammaFn(0.5)).toBeCloseTo(Math.sqrt(Math.PI), 10);
  });

  it('handles reflection formula for z < 0.5', () => {
    // Gamma(0.25) is known to be ~3.6256
    expect(gammaFn(0.25)).toBeCloseTo(3.625609882, 5);
  });
});

// ============================================================
// halfWaveRectify
// ============================================================
describe('halfWaveRectify', () => {
  it('keeps positive values unchanged', () => {
    const input = new Float32Array([0.5, 1.0, 0.25]);
    const out = halfWaveRectify(input);
    expect(out[0]).toBe(0.5);
    expect(out[1]).toBe(1.0);
    expect(out[2]).toBe(0.25);
  });

  it('sets negative values to zero', () => {
    const input = new Float32Array([-0.5, -1.0, -0.001]);
    const out = halfWaveRectify(input);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
  });

  it('handles mixed signal', () => {
    const input = new Float32Array([1, -1, 0, 0.5, -0.5]);
    const out = halfWaveRectify(input);
    expect(Array.from(out)).toEqual([1, 0, 0, 0.5, 0]);
  });

  it('returns Float32Array of same length', () => {
    const input = new Float32Array(100);
    const out = halfWaveRectify(input);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(100);
  });
});

// ============================================================
// lowPass15Hz
// ============================================================
describe('lowPass15Hz', () => {
  it('passes DC signal through unchanged (steady state)', () => {
    // A constant signal should converge to the DC value
    const dc = 1.0;
    const len = 10000;
    const input = new Float32Array(len).fill(dc);
    const out = lowPass15Hz(input, 44100);
    // Last sample should be very close to DC
    expect(out[len - 1]).toBeCloseTo(dc, 2);
  });

  it('attenuates high-frequency signal', () => {
    // 1000 Hz sine — well above 15 Hz cutoff
    const sr = 44100;
    const len = sr; // 1 second
    const freq = 1000;
    const input = new Float32Array(len);
    for (let i = 0; i < len; i++) input[i] = Math.sin(2 * Math.PI * freq * i / sr);

    const out = lowPass15Hz(input, sr);
    // After initial transient, peak amplitude should be very small
    let maxAbs = 0;
    for (let i = Math.floor(len / 2); i < len; i++) {
      if (Math.abs(out[i]) > maxAbs) maxAbs = Math.abs(out[i]);
    }
    expect(maxAbs).toBeLessThan(0.02);
  });

  it('preserves low-frequency content better than high', () => {
    const sr = 44100;
    const len = sr * 2;

    // 5 Hz sine — below cutoff
    const lowFreqInput = new Float32Array(len);
    for (let i = 0; i < len; i++) lowFreqInput[i] = Math.sin(2 * Math.PI * 5 * i / sr);
    const lowOut = lowPass15Hz(lowFreqInput, sr);

    // 500 Hz sine — well above cutoff
    const highFreqInput = new Float32Array(len);
    for (let i = 0; i < len; i++) highFreqInput[i] = Math.sin(2 * Math.PI * 500 * i / sr);
    const highOut = lowPass15Hz(highFreqInput, sr);

    // Measure RMS in second half (after transient)
    const rms = (arr, start) => {
      let sum = 0;
      for (let i = start; i < arr.length; i++) sum += arr[i] ** 2;
      return Math.sqrt(sum / (arr.length - start));
    };

    const lowRMS = rms(lowOut, len / 2);
    const highRMS = rms(highOut, len / 2);
    expect(lowRMS).toBeGreaterThan(highRMS * 10);
  });
});

// ============================================================
// zScoreNormalize
// ============================================================
describe('zScoreNormalize', () => {
  it('produces output with mean ~0 and SD ~1', () => {
    const input = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const out = zScoreNormalize(input);

    let sum = 0;
    for (let i = 0; i < out.length; i++) sum += out[i];
    const mean = sum / out.length;
    expect(mean).toBeCloseTo(0, 5);

    let ssq = 0;
    for (let i = 0; i < out.length; i++) ssq += (out[i] - mean) ** 2;
    const sd = Math.sqrt(ssq / out.length);
    expect(sd).toBeCloseTo(1, 5);
  });

  it('returns zeros for constant input', () => {
    const input = new Float32Array([5, 5, 5, 5, 5]);
    const out = zScoreNormalize(input);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBe(0);
    }
  });

  it('returns Float32Array of same length', () => {
    const input = new Float32Array([1, 2, 3]);
    const out = zScoreNormalize(input);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(3);
  });
});

// ============================================================
// resampleLinear
// ============================================================
describe('resampleLinear', () => {
  it('identity resampling at same length', () => {
    const input = new Float32Array([0, 1, 2, 3, 4]);
    const out = resampleLinear(input, 5);
    for (let i = 0; i < 5; i++) {
      expect(out[i]).toBeCloseTo(input[i], 10);
    }
  });

  it('upsample interpolates correctly', () => {
    // [0, 10] resampled to 3 points should give [0, 5, 10]
    const input = new Float32Array([0, 10]);
    const out = resampleLinear(input, 3);
    expect(out[0]).toBeCloseTo(0, 10);
    expect(out[1]).toBeCloseTo(5, 10);
    expect(out[2]).toBeCloseTo(10, 10);
  });

  it('downsample picks correct values', () => {
    // [0, 1, 2, 3, 4] resampled to 3 should give [0, 2, 4]
    const input = new Float32Array([0, 1, 2, 3, 4]);
    const out = resampleLinear(input, 3);
    expect(out[0]).toBeCloseTo(0, 10);
    expect(out[1]).toBeCloseTo(2, 10);
    expect(out[2]).toBeCloseTo(4, 10);
  });

  it('handles empty input', () => {
    const out = resampleLinear(new Float32Array(0), 10);
    expect(out.length).toBe(10);
    for (let i = 0; i < 10; i++) expect(out[i]).toBe(0);
  });

  it('handles single-element input', () => {
    const out = resampleLinear(new Float32Array([7]), 5);
    expect(out.length).toBe(5);
    for (let i = 0; i < 5; i++) expect(out[i]).toBe(7);
  });

  it('defaults to ENVELOPE_POINTS (1000)', () => {
    const input = new Float32Array([0, 1]);
    const out = resampleLinear(input);
    expect(out.length).toBe(ENVELOPE_POINTS);
    expect(out[0]).toBeCloseTo(0, 10);
    expect(out[999]).toBeCloseTo(1, 10);
    expect(out[500]).toBeCloseTo(500 / 999, 3);
  });
});

// ============================================================
// calculateSTI
// ============================================================
describe('calculateSTI', () => {
  it('returns null STI for fewer than 2 envelopes', () => {
    const single = [new Float32Array(ENVELOPE_POINTS).fill(1)];
    const result = calculateSTI(single);
    expect(result.sti).toBeNull();
    expect(result.sdProfile).toEqual([]);
  });

  it('returns zero STI for identical envelopes', () => {
    const env = new Float32Array(ENVELOPE_POINTS);
    for (let i = 0; i < ENVELOPE_POINTS; i++) env[i] = Math.sin(i / 100);
    const result = calculateSTI([env, env, env]);
    expect(result.sti).toBeCloseTo(0, 10);
    for (const p of result.sdProfile) expect(p.sd).toBeCloseTo(0, 10);
  });

  it('computes a known analytic value for simple case', () => {
    // Two envelopes: one all zeros, one all ones
    // At each sample point, values are [0, 1] -> mean=0.5, SD=sqrt(0.5^2/(2-1))=0.5 (Bessel)
    // Actually: ssq = (0-0.5)^2 + (1-0.5)^2 = 0.5, SD = sqrt(0.5/1) = sqrt(0.5)
    // Wait: Bessel: SD = sqrt(ssq / (N-1)) = sqrt(0.5 / 1) = sqrt(0.5) ≈ 0.7071
    // 50 points * sqrt(0.5) ≈ 35.355
    const env0 = new Float32Array(ENVELOPE_POINTS).fill(0);
    const env1 = new Float32Array(ENVELOPE_POINTS).fill(1);
    const result = calculateSTI([env0, env1]);
    const expected = 50 * Math.sqrt(0.5);
    expect(result.sti).toBeCloseTo(expected, 8);
  });

  it('samples exactly 50 points at the correct indices', () => {
    const env = new Float32Array(ENVELOPE_POINTS).fill(0);
    const result = calculateSTI([env, env]);
    expect(result.sdProfile.length).toBe(50);
    expect(result.perPointSDs.length).toBe(50);
    result.sdProfile.forEach((p, i) => {
      expect(p.index).toBe(STI_POINT_INDICES[i]);
    });
  });
});

// ============================================================
// biasCorrectSTI
// ============================================================
describe('biasCorrectSTI', () => {
  it('returns uncorrected value for N < 2', () => {
    expect(biasCorrectSTI(10, 1)).toBe(10);
  });

  it('correction factor > 1 for small N', () => {
    const sti = 20;
    const corrected = biasCorrectSTI(sti, 3);
    expect(corrected).toBeGreaterThan(sti);
  });

  it('correction factor approaches 1 as N grows', () => {
    const sti = 20;
    const corrected5 = biasCorrectSTI(sti, 5);
    const corrected50 = biasCorrectSTI(sti, 50);
    const corrected200 = biasCorrectSTI(sti, 200);

    // Factor should decrease toward 1
    const factor5 = corrected5 / sti;
    const factor50 = corrected50 / sti;
    const factor200 = corrected200 / sti;

    expect(factor5).toBeGreaterThan(factor50);
    expect(factor50).toBeGreaterThan(factor200);
    expect(factor200).toBeCloseTo(1, 1);
  });

  it('matches known correction factor for N=5', () => {
    // c5 = sqrt(4/2) * Gamma(2) / Gamma(5/2)
    //     = sqrt(2) * 1 / (3/2 * 1/2 * sqrt(pi)) = sqrt(2) / (3*sqrt(pi)/4)
    //     = 4*sqrt(2) / (3*sqrt(pi))
    const expected = Math.sqrt(2) * gammaFn(2) / gammaFn(2.5);
    const corrected = biasCorrectSTI(1, 5);
    expect(corrected).toBeCloseTo(expected, 10);
  });
});

// ============================================================
// computeNormalizedEnvelope — degenerate-segment guards (adversarial review)
// ============================================================
describe('computeNormalizedEnvelope degenerate segments', () => {
  const sr = 8000;

  it('returns null for a constant (zero-variance) segment so it never inflates STI', () => {
    // A flat plateau (clipping/saturation) z-scores to all zeros; it must be
    // excluded, not counted as a valid repetition.
    const env = new Float32Array(sr).fill(0.5);
    expect(computeNormalizedEnvelope(env, sr, 0.1, 0.9)).toBeNull();
  });

  it('returns null for a silent (all-zero) segment', () => {
    const env = new Float32Array(sr); // all zeros
    expect(computeNormalizedEnvelope(env, sr, 0.1, 0.9)).toBeNull();
  });

  it('returns null when the marked range is shorter than 2 samples', () => {
    const env = new Float32Array(sr);
    for (let i = 0; i < sr; i++) env[i] = Math.abs(Math.sin(i / 30));
    // 0.0001s @ 8000Hz rounds to a <2-sample span
    expect(computeNormalizedEnvelope(env, sr, 0.5, 0.5001)).toBeNull();
  });

  it('still returns a 1000-point envelope for a varying segment', () => {
    const env = new Float32Array(sr);
    for (let i = 0; i < sr; i++) env[i] = Math.abs(Math.sin(i / 30)) + 0.01;
    const out = computeNormalizedEnvelope(env, sr, 0.1, 0.9);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out).toHaveLength(ENVELOPE_POINTS);
  });
});

// ============================================================
// Integration: full pipeline with synthetic signals
// ============================================================
describe('full pipeline integration', () => {
  it('processes synthetic signal through the complete DSP chain', () => {
    const sr = 8000;
    const duration = 0.5; // 500ms
    const len = sr * duration;

    // Create two slightly different synthetic signals
    const signals = [];
    for (let s = 0; s < 5; s++) {
      const mono = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        // Base signal + slight per-repetition variation
        mono[i] = Math.sin(2 * Math.PI * 100 * i / sr) * (1 + 0.1 * s) +
                  0.5 * Math.sin(2 * Math.PI * 200 * i / sr);
      }
      signals.push(mono);
    }

    // Extract envelopes and compute normalized versions
    const normalizedEnvelopes = signals.map(mono => {
      const envelope = extractEnvelope(mono, sr);
      return computeNormalizedEnvelope(envelope, sr, 0, duration);
    }).filter(e => e !== null);

    expect(normalizedEnvelopes.length).toBe(5);
    normalizedEnvelopes.forEach(env => {
      expect(env.length).toBe(ENVELOPE_POINTS);
    });

    // Calculate STI
    const result = calculateSTI(normalizedEnvelopes);
    expect(result.sti).not.toBeNull();
    expect(result.sti).toBeGreaterThan(0);
    expect(result.sdProfile.length).toBe(50);

    // Bias-corrected STI should be larger
    const corrected = biasCorrectSTI(result.sti, 5);
    expect(corrected).toBeGreaterThan(result.sti);
  });

  it('identical repetitions produce STI of zero', () => {
    const sr = 8000;
    const duration = 0.5;
    const len = sr * duration;
    const mono = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      mono[i] = Math.sin(2 * Math.PI * 100 * i / sr);
    }

    const envelope = extractEnvelope(mono, sr);
    const normalized = computeNormalizedEnvelope(envelope, sr, 0, duration);

    // Same signal repeated 5 times
    const result = calculateSTI([normalized, normalized, normalized, normalized, normalized]);
    expect(result.sti).toBeCloseTo(0, 10);
  });
});

describe('detectOnsetOffset', () => {
  const sr = 8000;
  // Build a smoothed-envelope-shaped array: silence, burst, silence.
  function envelopeWithBurst(startSec, endSec, totalSec = 1, level = 1) {
    const env = new Float32Array(Math.round(totalSec * sr));
    const a = Math.round(startSec * sr), b = Math.round(endSec * sr);
    for (let i = a; i < b; i++) env[i] = level;
    return env;
  }

  it('finds onset and offset bracketing the burst', () => {
    const env = envelopeWithBurst(0.3, 0.7);
    const m = detectOnsetOffset(env, sr);
    expect(m).not.toBeNull();
    expect(m.onset).toBeCloseTo(0.3, 2);
    expect(m.offset).toBeCloseTo(0.7, 2);
    expect(m.offset).toBeGreaterThan(m.onset);
  });

  it('returns null for pure silence', () => {
    expect(detectOnsetOffset(new Float32Array(sr), sr)).toBeNull();
  });

  it('returns null for a constant (no dynamic range) signal', () => {
    expect(detectOnsetOffset(new Float32Array(sr).fill(0.5), sr)).toBeNull();
  });

  it('rejects a 1-sample transient click before the real burst', () => {
    const env = envelopeWithBurst(0.4, 0.7);
    env[800] = 1; // a single-sample spike at 0.1s (< minMs sustain)
    const m = detectOnsetOffset(env, sr);
    expect(m).not.toBeNull();
    expect(m.onset).toBeCloseTo(0.4, 2); // not 0.1 — the click is ignored
  });

  it('returns null on empty input or missing sample rate', () => {
    expect(detectOnsetOffset(new Float32Array(0), sr)).toBeNull();
    expect(detectOnsetOffset(envelopeWithBurst(0.3, 0.7), 0)).toBeNull();
  });
});
