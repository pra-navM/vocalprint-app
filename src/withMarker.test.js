import { describe, it, expect } from 'vitest';
import { withMarker, withMarkers } from './recordingModel.js';
import { ENVELOPE_POINTS } from './dsp.js';

// A synthetic 1-second envelope so computeNormalizedEnvelope has real data.
function makeRec(extra = {}) {
  const sampleRate = 8000;
  const envelope = new Float32Array(sampleRate);
  for (let i = 0; i < envelope.length; i++) envelope[i] = Math.abs(Math.sin(i / 40)) + 0.01;
  return {
    id: 'r1', name: 'rec', sampleRate, duration: 1,
    envelope, onset: null, offset: null, normalizedEnvelope: null,
    ...extra,
  };
}

describe('withMarker', () => {
  it('computes a normalized envelope once both markers form a valid range', () => {
    const rec = makeRec({ onset: 0.2 });
    const result = withMarker(rec, 'offset', 0.8);
    expect(result.offset).toBe(0.8);
    expect(result.normalizedEnvelope).toBeInstanceOf(Float32Array);
    expect(result.normalizedEnvelope).toHaveLength(ENVELOPE_POINTS);
  });

  it('leaves normalizedEnvelope null when only one marker is set', () => {
    const rec = makeRec();
    expect(withMarker(rec, 'onset', 0.2).normalizedEnvelope).toBeNull();
  });

  it('clears a previously valid normalizedEnvelope when the range becomes invalid (regression for marker race)', () => {
    // Start from a valid, analyzed recording.
    const valid = withMarker(makeRec({ onset: 0.2 }), 'offset', 0.8);
    expect(valid.normalizedEnvelope).toBeInstanceOf(Float32Array);

    // Move onset past offset — range is now invalid, envelope must be cleared
    // so a stale envelope can't feed a wrong STI.
    const invalid = withMarker(valid, 'onset', 0.9);
    expect(invalid.onset).toBe(0.9);
    expect(invalid.offset).toBe(0.8);
    expect(invalid.normalizedEnvelope).toBeNull();
  });

  it('does not mutate the input recording', () => {
    const rec = makeRec({ onset: 0.2 });
    withMarker(rec, 'offset', 0.8);
    expect(rec.offset).toBeNull();
    expect(rec.normalizedEnvelope).toBeNull();
  });
});

describe('withMarkers', () => {
  it('sets both markers and computes the normalized envelope in one step', () => {
    const result = withMarkers(makeRec(), 0.2, 0.8);
    expect(result.onset).toBe(0.2);
    expect(result.offset).toBe(0.8);
    expect(result.normalizedEnvelope).toBeInstanceOf(Float32Array);
    expect(result.normalizedEnvelope).toHaveLength(ENVELOPE_POINTS);
  });

  it('clears the envelope for an invalid range (offset <= onset)', () => {
    expect(withMarkers(makeRec(), 0.8, 0.2).normalizedEnvelope).toBeNull();
    expect(withMarkers(makeRec(), 0.5, 0.5).normalizedEnvelope).toBeNull();
  });

  it('does not mutate the input recording', () => {
    const rec = makeRec();
    withMarkers(rec, 0.2, 0.8);
    expect(rec.onset).toBeNull();
    expect(rec.offset).toBeNull();
    expect(rec.normalizedEnvelope).toBeNull();
  });
});
