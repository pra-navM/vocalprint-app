import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  openDB, putRecording, getRecordingsBySession, deleteRecording,
  deleteRecordingsBySession, deleteRecordingsBySessions, pcmToAudioBuffer,
  _resetForTests,
} from './db.js';

// Build a representative stored recording.
function makeRec(id, sessionId, overrides = {}) {
  return {
    id, sessionId, name: `Recording ${id}`,
    sampleRate: 44100, duration: 1.5,
    pcm: new Float32Array([0.1, -0.2, 0.3, -0.4]),
    envelope: new Float32Array([0.1, 0.2, 0.3]),
    onset: null, offset: null, normalizedEnvelope: null,
    createdAt: 1000,
    ...overrides,
  };
}

beforeEach(async () => {
  // Close any memoized connection, then wipe the database for isolation.
  _resetForTests();
  await new Promise(resolve => {
    const req = indexedDB.deleteDatabase('vocalprint');
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
});

describe('openDB', () => {
  it('creates the recordings store with a sessionId index', async () => {
    const db = await openDB();
    expect(db.objectStoreNames.contains('recordings')).toBe(true);
    const tx = db.transaction('recordings', 'readonly');
    const store = tx.objectStore('recordings');
    expect(Array.from(store.indexNames)).toContain('sessionId');
  });
});

describe('put / get round-trip', () => {
  it('stores and retrieves a recording by session', async () => {
    await putRecording(makeRec('a1', 's1'));
    const recs = await getRecordingsBySession('s1');
    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe('a1');
    expect(recs[0].name).toBe('Recording a1');
  });

  it('returns [] for an unknown session', async () => {
    expect(await getRecordingsBySession('nope')).toEqual([]);
  });

  it('upserts on matching id rather than duplicating', async () => {
    await putRecording(makeRec('a1', 's1', { onset: null }));
    await putRecording(makeRec('a1', 's1', {
      onset: 0.2, offset: 0.9,
      normalizedEnvelope: new Float32Array(1000).fill(0.5),
    }));
    const recs = await getRecordingsBySession('s1');
    expect(recs).toHaveLength(1);
    expect(recs[0].onset).toBe(0.2);
    expect(recs[0].normalizedEnvelope).toHaveLength(1000);
  });

  it('isolates recordings by session', async () => {
    await putRecording(makeRec('a1', 's1'));
    await putRecording(makeRec('a2', 's1'));
    await putRecording(makeRec('b1', 's2'));
    expect(await getRecordingsBySession('s1')).toHaveLength(2);
    expect(await getRecordingsBySession('s2')).toHaveLength(1);
  });
});

describe('serialization round-trip', () => {
  it('preserves Float32Array type, length, and values', async () => {
    const pcm = new Float32Array([0.11, -0.22, 0.33, -0.44, 0.55]);
    const norm = new Float32Array(1000);
    for (let i = 0; i < 1000; i++) norm[i] = Math.sin(i / 50);
    await putRecording(makeRec('a1', 's1', { pcm, normalizedEnvelope: norm }));

    const [rec] = await getRecordingsBySession('s1');
    expect(rec.pcm).toBeInstanceOf(Float32Array);
    expect(rec.pcm).toHaveLength(5);
    expect(rec.normalizedEnvelope).toBeInstanceOf(Float32Array);
    expect(rec.normalizedEnvelope).toHaveLength(1000);
    for (let i = 0; i < pcm.length; i++) {
      expect(rec.pcm[i]).toBeCloseTo(pcm[i], 6);
    }
    expect(rec.normalizedEnvelope[500]).toBeCloseTo(norm[500], 6);
  });

  it('round-trips null normalizedEnvelope as null', async () => {
    await putRecording(makeRec('a1', 's1', { normalizedEnvelope: null }));
    const [rec] = await getRecordingsBySession('s1');
    expect(rec.normalizedEnvelope).toBeNull();
  });
});

describe('ordering by createdAt', () => {
  it('sorts to insertion order after the documented sort', async () => {
    await putRecording(makeRec('c', 's1', { createdAt: 3000 }));
    await putRecording(makeRec('a', 's1', { createdAt: 1000 }));
    await putRecording(makeRec('b', 's1', { createdAt: 2000 }));
    const recs = await getRecordingsBySession('s1');
    recs.sort((x, y) => (x.createdAt ?? 0) - (y.createdAt ?? 0));
    expect(recs.map(r => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('deletion', () => {
  it('deleteRecording removes only the given id', async () => {
    await putRecording(makeRec('a1', 's1'));
    await putRecording(makeRec('a2', 's1'));
    await deleteRecording('a1');
    const recs = await getRecordingsBySession('s1');
    expect(recs.map(r => r.id)).toEqual(['a2']);
  });

  it('deleteRecordingsBySession clears one session, leaves others', async () => {
    await putRecording(makeRec('a1', 's1'));
    await putRecording(makeRec('a2', 's1'));
    await putRecording(makeRec('b1', 's2'));
    await deleteRecordingsBySession('s1');
    expect(await getRecordingsBySession('s1')).toEqual([]);
    expect(await getRecordingsBySession('s2')).toHaveLength(1);
  });

  it('deleteRecordingsBySessions clears multiple sessions in one call', async () => {
    await putRecording(makeRec('a1', 's1'));
    await putRecording(makeRec('b1', 's2'));
    await putRecording(makeRec('c1', 's3'));
    await deleteRecordingsBySessions(['s1', 's2']);
    expect(await getRecordingsBySession('s1')).toEqual([]);
    expect(await getRecordingsBySession('s2')).toEqual([]);
    expect(await getRecordingsBySession('s3')).toHaveLength(1);
  });

  it('deleteRecordingsBySessions is a no-op for an empty list', async () => {
    await putRecording(makeRec('a1', 's1'));
    await deleteRecordingsBySessions([]);
    expect(await getRecordingsBySession('s1')).toHaveLength(1);
  });
});

describe('pcmToAudioBuffer', () => {
  it('builds a mono buffer and copies PCM unchanged', () => {
    const pcm = new Float32Array([0.1, 0.2, 0.3]);
    const channelData = new Float32Array(3);
    const ctx = {
      createBuffer: vi.fn((channels, length, sampleRate) => ({
        numberOfChannels: channels, length, sampleRate,
        copyToChannel: (src) => channelData.set(src),
      })),
    };
    const buf = pcmToAudioBuffer(ctx, pcm, 22050);
    expect(ctx.createBuffer).toHaveBeenCalledWith(1, 3, 22050);
    expect(buf.length).toBe(3);
    expect(buf.sampleRate).toBe(22050);
    expect(Array.from(channelData)).toEqual([
      expect.closeTo(0.1, 6), expect.closeTo(0.2, 6), expect.closeTo(0.3, 6),
    ]);
  });

  it('falls back to getChannelData when copyToChannel is absent', () => {
    const pcm = new Float32Array([0.5, -0.5]);
    const channelData = new Float32Array(2);
    const ctx = {
      createBuffer: () => ({ getChannelData: () => channelData }),
    };
    pcmToAudioBuffer(ctx, pcm, 44100);
    expect(Array.from(channelData)).toEqual([0.5, -0.5]);
  });
});

describe('graceful degradation when IndexedDB is unavailable', () => {
  let saved;
  beforeEach(() => {
    saved = globalThis.indexedDB;
    globalThis.indexedDB = undefined;
  });
  afterEach(() => { globalThis.indexedDB = saved; });

  it('reads resolve to [] and writes resolve without throwing', async () => {
    await expect(putRecording(makeRec('x', 's1'))).resolves.toBeUndefined();
    await expect(getRecordingsBySession('s1')).resolves.toEqual([]);
    await expect(deleteRecording('x')).resolves.toBeUndefined();
    await expect(deleteRecordingsBySession('s1')).resolves.toBeUndefined();
    await expect(deleteRecordingsBySessions(['s1'])).resolves.toBeUndefined();
  });
});
