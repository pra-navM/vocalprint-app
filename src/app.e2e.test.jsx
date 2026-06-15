// End-to-end functional tests: render the real <App/>, drive the actual user
// flow through the DOM, and assert on persistence + analysis. Web Audio and
// Canvas (absent in happy-dom) are stubbed; IndexedDB is faked.
import 'fake-indexeddb/auto';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import App from './App.jsx';
import * as db from './db.js';
import { ENVELOPE_POINTS } from './dsp.js';

// ---- Stubs for browser APIs happy-dom doesn't implement ----

// A fake decoded AudioBuffer carrying a real signal so the DSP runs for real.
function fakeAudioBuffer(sampleRate = 8000, seconds = 1) {
  const length = sampleRate * seconds;
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) data[i] = Math.sin(i / 30) * 0.5;
  return {
    numberOfChannels: 1, sampleRate, duration: seconds, length,
    getChannelData: () => data,
  };
}

class MockAudioContext {
  constructor() { this.state = 'running'; this.destination = {}; }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  decodeAudioData() { return Promise.resolve(fakeAudioBuffer()); }
  createBuffer(channels, length, sampleRate) {
    const chans = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate,
      getChannelData: i => chans[i], copyToChannel: (src, i) => chans[i].set(src) };
  }
  createBufferSource() { return { buffer: null, connect() {}, start() {} }; }
  createMediaStreamSource() { return { connect() {} }; }
  createAnalyser() { return { fftSize: 2048, frequencyBinCount: 1024, getByteTimeDomainData() {} }; }
}

function stubCanvas() {
  const noop = () => {};
  const ctx2d = new Proxy({}, {
    get: (_t, p) => (p === 'canvas' ? {} : noop),
    set: () => true,
  });
  HTMLCanvasElement.prototype.getContext = () => ctx2d;
  HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 120 });
}

// happy-dom under Node's experimental localStorage gives a broken object; install
// a clean in-memory Storage so the app's persistence (loadFromLS/saveToLS) works.
function installLocalStorage() {
  const m = new Map();
  const storage = {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    clear: () => { m.clear(); },
    key: i => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  return storage;
}

async function resetDB() {
  db._resetForTests();
  await new Promise(resolve => {
    const req = indexedDB.deleteDatabase('vocalprint');
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  installLocalStorage();
  await resetDB();
  window.AudioContext = MockAudioContext;
  window.alert = vi.fn();
  window.confirm = vi.fn(() => true);
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = vi.fn();
  stubCanvas();
});

afterEach(() => cleanup());

// Build a stored recording with a valid normalized envelope (so it counts as analyzed).
function analyzedRecord(sessionId, i) {
  const norm = new Float32Array(ENVELOPE_POINTS);
  for (let k = 0; k < ENVELOPE_POINTS; k++) norm[k] = Math.sin(k / 50) + i * 0.05; // vary per rec → SD > 0
  return {
    id: `rec-${sessionId}-${i}`, sessionId, name: `Recording ${i + 1}`,
    sampleRate: 8000, duration: 1,
    pcm: new Float32Array([0.1, -0.1, 0.2]),
    envelope: new Float32Array([0.1, 0.2, 0.3]),
    onset: 0.1, offset: 0.9, normalizedEnvelope: norm,
    createdAt: 1000 + i,
  };
}

// Build an UNMARKED recording whose envelope has a clear burst, so auto-detect
// can find onset/offset from it.
function unmarkedRecord(sessionId, i) {
  const sr = 8000;
  const envelope = new Float32Array(sr); // 1 second
  for (let k = Math.round(0.3 * sr); k < Math.round(0.7 * sr); k++) envelope[k] = 1; // burst 0.3–0.7s
  return {
    id: `urec-${sessionId}-${i}`, sessionId, name: `Recording ${i + 1}`,
    sampleRate: sr, duration: 1,
    pcm: new Float32Array([0.1, -0.1, 0.2]),
    envelope,
    onset: null, offset: null, normalizedEnvelope: null,
    createdAt: 2000 + i,
  };
}

describe('E2E: patient → session → upload → persistence', () => {
  it('creates a patient and session, uploads a clip, shows it, and persists it', async () => {
    render(<App />);

    // Welcome → create first patient
    fireEvent.click(await screen.findByText('Create First Patient'));
    fireEvent.change(screen.getByPlaceholderText('e.g., John Smith'), { target: { value: 'Jane Doe' } });
    fireEvent.click(screen.getByText('Create Patient'));

    // Patient detail → new session
    fireEvent.click(await screen.findByText('+ New Session'));
    fireEvent.change(screen.getByPlaceholderText('e.g., Session 1 — baseline'), { target: { value: 'Baseline' } });
    fireEvent.change(screen.getByPlaceholderText('e.g., Buy Bobby a puppy'), { target: { value: 'Buy Bobby a puppy' } });
    fireEvent.click(screen.getByText('Create Session'));

    // Session view: upload an audio file via the hidden file input
    await screen.findByText('● Record');
    const fileInput = document.querySelector('input[type="file"]');
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'utterance1.wav', { type: 'audio/wav' });
    // Force the FileList (happy-dom won't accept assignment via fireEvent target).
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fireEvent.change(fileInput);

    // The recording row appears and the header count updates
    await screen.findByText(/utterance1\.wav/);
    await screen.findByText(/1 recording.*0 analyzed/);

    // And it was persisted to IndexedDB under the right session
    const sessions = JSON.parse(localStorage.getItem('vp_sessions'));
    const recs = await db.getRecordingsBySession(sessions[0].id);
    expect(recs).toHaveLength(1);
    expect(recs[0].name).toBe('utterance1.wav');
    expect(recs[0].pcm).toBeInstanceOf(Float32Array);
  });
});

describe('E2E: reload restores persisted recordings and computes STI', () => {
  it('loads 5 analyzed recordings from IndexedDB and shows the STI analysis', async () => {
    // Seed metadata in localStorage and analyzed recordings in IndexedDB,
    // simulating a returning clinician opening a prior session.
    const patientId = 'p1';
    const sessionId = 's1';
    localStorage.setItem('vp_patients', JSON.stringify([{ id: patientId, name: 'Jane Doe', pid: 'P-001' }]));
    localStorage.setItem('vp_sessions', JSON.stringify([{
      id: sessionId, patientId, name: 'Baseline', targetPhrase: 'Buy Bobby a puppy',
      date: new Date(0).toISOString(), stiResult: null, biasCorrectedSTI: null, n: 0,
    }]));
    for (let i = 0; i < 5; i++) await db.putRecording(analyzedRecord(sessionId, i));

    render(<App />);

    // Navigate: patient → session (sidebar entries)
    fireEvent.click(await screen.findByText('Jane Doe'));
    fireEvent.click(await screen.findByText('Baseline'));

    // Recordings reload from IndexedDB → all 5 analyzed
    await screen.findByText(/5 recordings.*5 analyzed/);

    // Full analysis pipeline ran: results dashboard + export available at N≥5
    await screen.findByText('Analysis Results');
    await screen.findByText(/Export Session JSON/);

    // The compute → write-back → sidebar path produced a numeric STI for N=5
    await screen.findByText(/STI: \d+\.\d+ \(N=5\)/);
  });

  it('export does not throw and produces a download', async () => {
    const patientId = 'p1';
    const sessionId = 's1';
    localStorage.setItem('vp_patients', JSON.stringify([{ id: patientId, name: 'Jane Doe', pid: '' }]));
    localStorage.setItem('vp_sessions', JSON.stringify([{
      id: sessionId, patientId, name: 'Sess/Test', targetPhrase: 'phrase',
      date: new Date(0).toISOString(), stiResult: null, biasCorrectedSTI: null, n: 0,
    }]));
    for (let i = 0; i < 5; i++) await db.putRecording(analyzedRecord(sessionId, i));

    render(<App />);
    fireEvent.click(await screen.findByText('Jane Doe'));
    fireEvent.click(await screen.findByText(/Sess\/Test/));
    const exportBtn = await screen.findByText(/Export Session JSON/);
    fireEvent.click(exportBtn);
    expect(URL.createObjectURL).toHaveBeenCalled();
  });
});

describe('E2E: session isolation', () => {
  it('shows only the selected session\'s recordings', async () => {
    const patientId = 'p1';
    localStorage.setItem('vp_patients', JSON.stringify([{ id: patientId, name: 'Jane Doe', pid: '' }]));
    localStorage.setItem('vp_sessions', JSON.stringify([
      { id: 'sA', patientId, name: 'Session A', targetPhrase: 'x', date: new Date(0).toISOString(), stiResult: null, biasCorrectedSTI: null, n: 0 },
      { id: 'sB', patientId, name: 'Session B', targetPhrase: 'x', date: new Date(0).toISOString(), stiResult: null, biasCorrectedSTI: null, n: 0 },
    ]));
    await db.putRecording(analyzedRecord('sA', 0));
    await db.putRecording(analyzedRecord('sA', 1));
    await db.putRecording(analyzedRecord('sB', 0));

    render(<App />);
    fireEvent.click(await screen.findByText('Jane Doe'));
    fireEvent.click(await screen.findByText('Session A'));
    await screen.findByText(/2 recordings.*2 analyzed/);

    fireEvent.click(screen.getByText('Session B'));
    await screen.findByText(/1 recording.*1 analyzed/);
  });
});

describe('E2E: auto-detect markers', () => {
  it('detects onset/offset from the envelope and marks the recording analyzed', async () => {
    const patientId = 'p1';
    const sessionId = 's1';
    localStorage.setItem('vp_patients', JSON.stringify([{ id: patientId, name: 'Jane Doe', pid: '' }]));
    localStorage.setItem('vp_sessions', JSON.stringify([{
      id: sessionId, patientId, name: 'Baseline', targetPhrase: 'phrase',
      date: new Date(0).toISOString(), stiResult: null, biasCorrectedSTI: null, n: 0,
    }]));
    await db.putRecording(unmarkedRecord(sessionId, 0));

    render(<App />);
    fireEvent.click(await screen.findByText('Jane Doe'));
    fireEvent.click(await screen.findByText('Baseline'));

    // Loaded but unmarked → 0 analyzed
    await screen.findByText(/1 recording.*0 analyzed/);

    // Click the per-recording Auto-detect button
    fireEvent.click(screen.getByText('⌖ Auto-detect'));

    // Markers placed → recording becomes analyzed, and the burst bounds show
    await screen.findByText(/1 recording.*1 analyzed/);
    await screen.findByText(/Onset: 0\.3/);
    await screen.findByText(/Offset: 0\.69|Offset: 0\.7/);

    // Persisted to IndexedDB with markers
    const recs = await db.getRecordingsBySession(sessionId);
    expect(recs[0].onset).toBeCloseTo(0.3, 2);
    expect(recs[0].normalizedEnvelope).toBeInstanceOf(Float32Array);
  });
});
