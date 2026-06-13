// Pure helpers for the recording data model — kept out of the component file
// so they can be unit-tested and reused without pulling in React.
import { computeNormalizedEnvelope } from './dsp.js';

// Strip the (non-cloneable) live audioBuffer and tag with sessionId for IndexedDB.
export function toStored(rec, sessionId) {
  return {
    id: rec.id, sessionId, name: rec.name,
    sampleRate: rec.sampleRate, duration: rec.duration,
    pcm: rec.pcm, envelope: rec.envelope,
    onset: rec.onset, offset: rec.offset,
    normalizedEnvelope: rec.normalizedEnvelope,
    createdAt: rec.createdAt,
  };
}

// Apply a new onset/offset to a recording, recomputing the normalized envelope
// when both markers form a valid range. When the range is invalid the stale
// envelope is cleared so it can never feed a wrong STI.
export function withMarker(rec, key, value) {
  const updated = { ...rec, [key]: value };
  if (updated.onset !== null && updated.offset !== null && updated.offset > updated.onset) {
    updated.normalizedEnvelope = computeNormalizedEnvelope(rec.envelope, rec.sampleRate, updated.onset, updated.offset);
  } else {
    updated.normalizedEnvelope = null;
  }
  return updated;
}
