import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend
} from 'recharts';
import {
  ENVELOPE_POINTS, toMono, extractEnvelope,
  calculateSTI, biasCorrectSTI,
} from './dsp.js';
import * as db from './db.js';
import { toStored, withMarker } from './recordingModel.js';

// ============================================================
// CONSTANTS
// ============================================================
// Clinical light palette. Token names are kept for compatibility across the
// file: `teal` is the primary accent (a calm clinical blue), `navy` and
// `darkPanel` are now light surfaces.
const COLORS = {
  bg: '#EEF2F7', panel: '#FFFFFF', teal: '#2563EB', amber: '#B45309',
  navy: '#FFFFFF', darkPanel: '#EDF1F6', text: '#1F2937', dimText: '#6B7280',
  red: '#DC2626', green: '#15803D', border: '#D8DFE7',
};
const FONTS = {
  mono: "'SF Mono', 'Cascadia Mono', Consolas, 'Roboto Mono', monospace",
  sans: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  display: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
};
const STI_SAMPLE_POINTS = 50;
const MIN_RECS = 5;
const PARSE_WARN_MS = 50;

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function loadFromLS(key, fallback) {
  try { const d = localStorage.getItem(key); return d ? JSON.parse(d) : fallback; }
  catch { return fallback; }
}
function saveToLS(key, data) {
  try { localStorage.setItem(key, JSON.stringify(data)); } catch { /* quota exceeded — ignore */ }
}

// ============================================================
// GLOBAL STYLES (injected once)
// ============================================================
function useGlobalStyles() {
  useEffect(() => {
    if (document.getElementById('vp-global-styles')) return;
    const style = document.createElement('style');
    style.id = 'vp-global-styles';
    style.textContent = `
      @keyframes vp-spin { to { transform: rotate(360deg); } }
      @keyframes vp-fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
      .vp-btn {
        padding: 8px 16px; border: 1px solid ${COLORS.border}; border-radius: 6px;
        background: ${COLORS.panel}; color: ${COLORS.text}; cursor: pointer;
        font-family: ${FONTS.sans}; font-size: 13px; transition: background 0.15s, border-color 0.15s;
      }
      .vp-btn:hover { border-color: ${COLORS.teal}; background: ${COLORS.darkPanel}; }
      .vp-btn-primary {
        background: ${COLORS.teal}; color: #ffffff; border-color: ${COLORS.teal}; font-weight: 600;
      }
      .vp-btn-primary:hover { background: #1D4ED8; border-color: #1D4ED8; }
      .vp-btn-danger { border-color: ${COLORS.red}; color: ${COLORS.red}; }
      .vp-btn-danger:hover { background: rgba(220,38,38,0.08); }
      .vp-input {
        padding: 8px 12px; border: 1px solid ${COLORS.border}; border-radius: 6px;
        background: ${COLORS.panel}; color: ${COLORS.text}; font-family: ${FONTS.sans};
        font-size: 13px; width: 100%; box-sizing: border-box;
      }
      .vp-input:focus { outline: none; border-color: ${COLORS.teal}; box-shadow: 0 0 0 3px rgba(37,99,235,0.15); }
      .vp-label { font-size: 12px; color: ${COLORS.dimText}; margin-bottom: 4px; font-family: ${FONTS.sans}; }
      * { box-sizing: border-box; }
    `;
    document.head.appendChild(style);
  }, []);
}

// ============================================================
// WAVEFORM CANVAS — envelope display with onset/offset markers
// ============================================================
function WaveformCanvas({ envelope, sampleRate, onset, offset, onOnsetChange, onOffsetChange, height = 120 }) {
  const canvasRef = useRef(null);
  const dragRef = useRef(null); // 'onset' | 'offset' | null
  const duration = envelope ? envelope.length / sampleRate : 0;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !envelope) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = COLORS.panel;
    ctx.fillRect(0, 0, w, h);

    // Find max for normalization
    let maxVal = 0;
    for (let i = 0; i < envelope.length; i++) if (envelope[i] > maxVal) maxVal = envelope[i];
    if (maxVal === 0) maxVal = 1;

    // Draw envelope curve
    ctx.beginPath();
    ctx.strokeStyle = COLORS.teal;
    ctx.lineWidth = 1.5;
    const samplesPerPx = envelope.length / w;
    for (let px = 0; px < w; px++) {
      const si = Math.floor(px * samplesPerPx);
      const ei = Math.min(Math.floor((px + 1) * samplesPerPx), envelope.length);
      let peak = 0;
      for (let j = si; j < ei; j++) if (envelope[j] > peak) peak = envelope[j];
      const y = h - (peak / maxVal) * h * 0.85 - h * 0.05;
      if (px === 0) ctx.moveTo(px, y); else ctx.lineTo(px, y);
    }
    ctx.stroke();

    // Filled area under curve
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(37,99,235,0.08)';
    ctx.fill();

    // Selected region shading
    if (onset !== null && offset !== null) {
      const x1 = (onset / duration) * w;
      const x2 = (offset / duration) * w;
      ctx.fillStyle = 'rgba(37,99,235,0.12)';
      ctx.fillRect(x1, 0, x2 - x1, h);
    }

    // Onset line
    if (onset !== null) {
      const x = (onset / duration) * w;
      ctx.beginPath();
      ctx.strokeStyle = COLORS.green;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.moveTo(x, 0); ctx.lineTo(x, h);
      ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = COLORS.green;
      ctx.font = '10px ' + FONTS.mono;
      ctx.fillText('ON ' + onset.toFixed(3) + 's', x + 3, 12);
    }

    // Offset line
    if (offset !== null) {
      const x = (offset / duration) * w;
      ctx.beginPath();
      ctx.strokeStyle = COLORS.amber;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.moveTo(x, 0); ctx.lineTo(x, h);
      ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = COLORS.amber;
      ctx.font = '10px ' + FONTS.mono;
      ctx.fillText('OFF ' + offset.toFixed(3) + 's', x + 3, 12);
    }

    // Time axis
    ctx.fillStyle = COLORS.dimText;
    ctx.font = '9px ' + FONTS.mono;
    const step = duration > 2 ? 0.5 : 0.25;
    for (let t = 0; t <= duration; t += step) {
      const x = (t / duration) * w;
      ctx.fillText(t.toFixed(2), x, h - 2);
    }
  }, [envelope, sampleRate, onset, offset, duration]);

  useEffect(() => { draw(); }, [draw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
      draw();
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [draw]);

  const getTimeFromX = useCallback((clientX) => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    return Math.max(0, Math.min(duration, (px / rect.width) * duration));
  }, [duration]);

  const handleMouseDown = useCallback((e) => {
    const t = getTimeFromX(e.clientX);
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const pxPerSec = rect.width / duration;
    const thresh = 8 / pxPerSec; // 8px tolerance
    if (onset !== null && Math.abs(t - onset) < thresh) { dragRef.current = 'onset'; }
    else if (offset !== null && Math.abs(t - offset) < thresh) { dragRef.current = 'offset'; }
    else {
      // Click to place: if no onset, set onset; if onset but no offset, set offset
      if (onset === null) { onOnsetChange(t); }
      else if (offset === null) { if (t > onset) onOffsetChange(t); else { onOffsetChange(onset); onOnsetChange(t); } }
      else {
        // Both set — move whichever is closer
        if (Math.abs(t - onset) < Math.abs(t - offset)) onOnsetChange(t);
        else onOffsetChange(t);
      }
    }
  }, [onset, offset, duration, getTimeFromX, onOnsetChange, onOffsetChange]);

  const handleMouseMove = useCallback((e) => {
    if (!dragRef.current) return;
    const t = getTimeFromX(e.clientX);
    if (dragRef.current === 'onset') {
      if (offset === null || t < offset) onOnsetChange(t);
    } else {
      if (onset === null || t > onset) onOffsetChange(t);
    }
  }, [onset, offset, getTimeFromX, onOnsetChange, onOffsetChange]);

  const handleMouseUp = useCallback(() => { dragRef.current = null; }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height, display: 'block', borderRadius: 6, cursor: 'crosshair', border: `1px solid ${COLORS.border}` }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    />
  );
}

// ============================================================
// LIVE WAVEFORM — real-time recording visualization
// ============================================================
function LiveWaveformCanvas({ analyserRef, isRecording }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    if (!isRecording || !analyserRef.current) return;
    const analyser = analyserRef.current;
    const bufLen = analyser.fftSize;
    const data = new Uint8Array(bufLen);
    const drawLoop = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      analyser.getByteTimeDomainData(data);
      const ctx = canvas.getContext('2d');
      const w = canvas.width = canvas.clientWidth;
      const h = canvas.height = canvas.clientHeight;
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, w, h);
      ctx.beginPath();
      ctx.strokeStyle = COLORS.teal;
      ctx.lineWidth = 2;
      const sliceW = w / bufLen;
      for (let i = 0; i < bufLen; i++) {
        const y = (data[i] / 255) * h;
        if (i === 0) ctx.moveTo(0, y); else ctx.lineTo(i * sliceW, y);
      }
      ctx.stroke();
      rafRef.current = requestAnimationFrame(drawLoop);
    };
    drawLoop();
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [isRecording, analyserRef]);

  return (
    <canvas ref={canvasRef} style={{
      width: '100%', height: 80, display: 'block', borderRadius: 6,
      border: `1px solid ${COLORS.border}`,
    }} />
  );
}

// ============================================================
// ANIMATED STI COUNTER
// ============================================================
function AnimatedSTI({ value, label, color = COLORS.teal }) {
  const [display, setDisplay] = useState(0);
  const rafRef = useRef(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- animation driven by rAF
    if (value === null || value === undefined) { setDisplay(0); return; }
    const start = performance.now();
    const dur = 1200;
    const animate = (now) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / dur, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(value * eased);
      if (progress < 1) rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [value]);

  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontFamily: FONTS.mono, fontSize: 48, fontWeight: 500, color, lineHeight: 1 }}>
        {value !== null ? display.toFixed(2) : '—'}
      </div>
      <div style={{ fontFamily: FONTS.sans, fontSize: 12, color: COLORS.dimText, marginTop: 4 }}>{label}</div>
    </div>
  );
}

// ============================================================
// MODAL WRAPPER
// ============================================================
function Modal({ open, onClose, title, children }) {
  if (!open) return null;
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(15,23,42,0.45)',
    }} onClick={onClose}>
      <div style={{
        background: COLORS.navy, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 24,
        minWidth: 360, maxWidth: 480, animation: 'vp-fadeIn 0.2s ease',
      }} onClick={e => e.stopPropagation()}>
        <h3 style={{ fontFamily: FONTS.display, color: COLORS.text, margin: '0 0 16px', fontSize: 20 }}>{title}</h3>
        {children}
      </div>
    </div>
  );
}

// ============================================================
// SPINNER
// ============================================================
function Spinner({ size = 24, color = COLORS.teal }) {
  return (
    <div style={{
      width: size, height: size, border: `2px solid ${COLORS.border}`, borderTopColor: color,
      borderRadius: '50%', animation: 'vp-spin 0.6s linear infinite', display: 'inline-block',
    }} />
  );
}

// ============================================================
// MAIN COMPONENT — VocalPrint E-STI Tracker
// ============================================================
export default function VocalPrint() {
  useGlobalStyles();

  // --- Patient & Session state (persisted to localStorage) ---
  const [patients, setPatients] = useState(() => loadFromLS('vp_patients', []));
  const [sessions, setSessions] = useState(() => loadFromLS('vp_sessions', []));
  const [selPatientId, setSelPatientId] = useState(null);
  const [selSessionId, setSelSessionId] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showNewPatient, setShowNewPatient] = useState(false);
  const [showNewSession, setShowNewSession] = useState(false);
  const [newPatientName, setNewPatientName] = useState('');
  const [newPatientPid, setNewPatientPid] = useState('');
  const [newSessionName, setNewSessionName] = useState('');
  const [newSessionPhrase, setNewSessionPhrase] = useState('');
  const [biasCorrection, setBiasCorrection] = useState(false);

  // --- Recording state (ephemeral, in-memory only) ---
  const [recordings, setRecordings] = useState([]); // array of recording objects for current session
  const [isRecording, setIsRecording] = useState(false);
  const [processing, setProcessing] = useState(false);

  // --- Audio refs ---
  const audioCtxRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const analyserRef = useRef(null);
  const streamRef = useRef(null);
  const fileInputRef = useRef(null);
  const recordingCountRef = useRef(0);
  const selSessionIdRef = useRef(null);
  const recordingsRef = useRef([]);

  // Persist patients and sessions
  useEffect(() => { saveToLS('vp_patients', patients); }, [patients]);
  useEffect(() => { saveToLS('vp_sessions', sessions); }, [sessions]);

  // Keep current session id available to recorder closures (which are
  // useCallback([]) and would otherwise capture a stale value).
  useEffect(() => { selSessionIdRef.current = selSessionId; }, [selSessionId]);

  // Load this session's recordings from IndexedDB when the session changes.
  useEffect(() => {
    setRecordings([]); // clear immediately so stale clips never flash
    if (!selSessionId) return;
    let cancelled = false;
    db.getRecordingsBySession(selSessionId).then(recs => {
      if (cancelled) return; // a newer session switch happened — drop this load
      recs.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      setRecordings(recs);
      recordingCountRef.current = recs.length;
    });
    return () => { cancelled = true; };
  }, [selSessionId]);

  // Keep recording count ref in sync for use in closures
  useEffect(() => { recordingCountRef.current = recordings.length; }, [recordings.length]);

  // Keep a live snapshot of recordings for handlers that must read the latest
  // committed state without re-creating their useCallback identity.
  useEffect(() => { recordingsRef.current = recordings; }, [recordings]);

  // --- AudioContext setup (Safari/iOS unlock on user gesture) ---
  const getAudioCtx = useCallback(async () => {
    if (!audioCtxRef.current) {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtxRef.current = new AC();
    }
    if (audioCtxRef.current.state === 'suspended') await audioCtxRef.current.resume();
    return audioCtxRef.current;
  }, []);

  // --- Process decoded audio into a recording object ---
  // sessionId is captured at record/upload start so the clip is always saved
  // to the session it was created in, even if the user switches sessions while
  // decoding is in flight.
  const processAudio = useCallback(async (audioBuffer, name, sessionId) => {
    setProcessing(true);
    try {
      if (!sessionId) return; // no session to attach this recording to
      await new Promise(r => setTimeout(r, 50)); // yield for UI
      const mono = toMono(audioBuffer);
      const sr = audioBuffer.sampleRate;
      const dur = audioBuffer.duration;
      if (dur < 0.5) {
        alert('Recording is too short (< 0.5s). Skipping.');
        return;
      }
      const envelope = extractEnvelope(mono, sr);
      const rec = {
        id: genId(), name, audioBuffer, pcm: mono, sampleRate: sr, duration: dur,
        envelope, onset: null, offset: null, normalizedEnvelope: null,
        createdAt: Date.now(),
      };
      db.putRecording(toStored(rec, sessionId));
      // Reflect in the live list only if that session is still the one on screen.
      setRecordings(prev => (selSessionIdRef.current === sessionId ? [...prev, rec] : prev));
    } catch (err) {
      console.error('Audio processing error:', err);
      alert('Failed to process audio: ' + (err?.message || err));
    } finally {
      setProcessing(false);
    }
  }, []);

  // --- Start recording ---
  const startRecording = useCallback(async () => {
    try {
      const sessionId = selSessionIdRef.current; // capture at record start
      const ctx = await getAudioCtx();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      analyserRef.current = analyser;

      const recorder = new MediaRecorder(stream);
      const chunks = []; // per-recording buffer — not shared, so a new recording can't clobber it
      recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        try {
          const blob = new Blob(chunks, { type: 'audio/webm' });
          const arrayBuf = await blob.arrayBuffer();
          const decoded = await ctx.decodeAudioData(arrayBuf);
          const idx = recordingCountRef.current + 1;
          await processAudio(decoded, `Recording ${idx}`, sessionId);
        } catch (err) {
          console.error('Recording decode error:', err);
          alert('Failed to process recording: ' + (err?.message || err));
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch (err) {
      alert('Microphone access denied or unavailable: ' + (err?.message || err));
    }
  }, [getAudioCtx, processAudio]);

  // --- Stop recording ---
  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }, [isRecording]);

  // --- File upload ---
  const handleFileUpload = useCallback(async (files) => {
    const sessionId = selSessionIdRef.current; // capture at upload start
    const ctx = await getAudioCtx();
    for (const file of files) {
      try {
        const arrayBuf = await file.arrayBuffer();
        const decoded = await ctx.decodeAudioData(arrayBuf);
        await processAudio(decoded, file.name, sessionId);
      } catch (err) {
        alert('Failed to decode ' + file.name + ': ' + (err?.message || err));
      }
    }
  }, [getAudioCtx, processAudio]);

  // --- Update onset/offset for a recording ---
  const updateRecMarker = useCallback((recId, key, value) => {
    const target = recordingsRef.current.find(r => r.id === recId);
    if (!target) return;
    const updated = withMarker(target, key, value);
    setRecordings(prev => prev.map(r => (r.id === recId ? updated : r)));
    db.putRecording(toStored(updated, selSessionIdRef.current));
  }, []);

  const updateRecOnset = useCallback((recId, onset) => updateRecMarker(recId, 'onset', onset), [updateRecMarker]);
  const updateRecOffset = useCallback((recId, offset) => updateRecMarker(recId, 'offset', offset), [updateRecMarker]);

  // --- Delete a recording ---
  const deleteRecording = useCallback((recId) => {
    setRecordings(prev => prev.filter(r => r.id !== recId));
    db.deleteRecording(recId);
  }, []);

  // --- Playback ---
  const playRecording = useCallback(async (rec) => {
    const ctx = await getAudioCtx();
    const source = ctx.createBufferSource();
    // Recordings loaded from IndexedDB have no live AudioBuffer — rebuild from PCM.
    let buf = rec.audioBuffer;
    if (!buf) {
      buf = db.pcmToAudioBuffer(ctx, rec.pcm, rec.sampleRate);
      rec.audioBuffer = buf; // cache so repeated plays don't rebuild
    }
    source.buffer = buf;
    source.connect(ctx.destination);
    const startTime = rec.onset !== null ? rec.onset : 0;
    const dur = rec.offset !== null ? rec.offset - startTime : undefined;
    source.start(0, startTime, dur);
  }, [getAudioCtx]);

  // --- STI computation (memoized) ---
  const analyzedRecs = useMemo(() => recordings.filter(r => r.normalizedEnvelope != null), [recordings]);
  const stiResult = useMemo(() => {
    if (analyzedRecs.length < 2) return null;
    const envelopes = analyzedRecs.map(r => r.normalizedEnvelope);
    return calculateSTI(envelopes);
  }, [analyzedRecs]);

  const stiValue = stiResult?.sti ?? null;
  const biasCorrectedSTI = useMemo(() => {
    if (stiValue === null || analyzedRecs.length < 2) return null;
    return biasCorrectSTI(stiValue, analyzedRecs.length);
  }, [stiValue, analyzedRecs.length]);

  // --- Parsing QC: duration stats ---
  const parsedDurations = useMemo(() => {
    return analyzedRecs.map(r => ({ id: r.id, name: r.name, onset: r.onset, offset: r.offset, duration: r.offset - r.onset }));
  }, [analyzedRecs]);

  const durationStats = useMemo(() => {
    if (parsedDurations.length < 2) return { mean: 0, sd: 0, warn: false };
    const durs = parsedDurations.map(d => d.duration);
    const mean = durs.reduce((a, b) => a + b, 0) / durs.length;
    const ssq = durs.reduce((a, v) => a + (v - mean) ** 2, 0);
    const sd = Math.sqrt(ssq / (durs.length - 1));
    return { mean, sd, warn: sd * 1000 > PARSE_WARN_MS };
  }, [parsedDurations]);

  // --- Overlay chart data (all normalized envelopes) ---
  const overlayData = useMemo(() => {
    if (analyzedRecs.length === 0) return [];
    const data = [];
    for (let i = 0; i < ENVELOPE_POINTS; i += 2) { // every other point for perf
      const pt = { time: (i / 10).toFixed(1) };
      analyzedRecs.forEach((r, idx) => { pt[`r${idx}`] = r.normalizedEnvelope[i]; });
      data.push(pt);
    }
    return data;
  }, [analyzedRecs]);

  // --- SD profile chart data ---
  const sdData = useMemo(() => {
    if (!stiResult) return [];
    return stiResult.sdProfile.map(p => ({ time: p.normalizedTime.toFixed(0), sd: p.sd }));
  }, [stiResult]);

  // --- Patient & Session CRUD ---
  const createPatient = useCallback(() => {
    if (!newPatientName.trim()) return;
    const p = { id: genId(), name: newPatientName.trim(), pid: newPatientPid.trim() };
    setPatients(prev => [...prev, p]);
    setSelPatientId(p.id);
    setNewPatientName(''); setNewPatientPid('');
    setShowNewPatient(false);
  }, [newPatientName, newPatientPid]);

  const deletePatient = useCallback((pid) => {
    const sids = sessions.filter(s => s.patientId === pid).map(s => s.id);
    setPatients(prev => prev.filter(p => p.id !== pid));
    setSessions(prev => prev.filter(s => s.patientId !== pid));
    if (selPatientId === pid) { setSelPatientId(null); setSelSessionId(null); }
    db.deleteRecordingsBySessions(sids);
  }, [selPatientId, sessions]);

  const createSession = useCallback(() => {
    if (!newSessionName.trim() || !newSessionPhrase.trim() || !selPatientId) return;
    const s = {
      id: genId(), patientId: selPatientId, name: newSessionName.trim(),
      targetPhrase: newSessionPhrase.trim(), date: new Date().toISOString(),
      stiResult: null, biasCorrectedSTI: null, n: 0,
    };
    setSessions(prev => [...prev, s]);
    setSelSessionId(s.id);
    setNewSessionName(''); setNewSessionPhrase('');
    setShowNewSession(false);
  }, [newSessionName, newSessionPhrase, selPatientId]);

  const deleteSession = useCallback((sid) => {
    setSessions(prev => prev.filter(s => s.id !== sid));
    if (selSessionId === sid) setSelSessionId(null);
    db.deleteRecordingsBySession(sid);
  }, [selSessionId]);

  // Save STI result to session metadata. When the STI becomes unavailable
  // (e.g. recordings deleted below the minimum), clear the stored result so the
  // sidebar never shows a stale STI for a session that no longer supports one.
  useEffect(() => {
    if (!selSessionId) return;
    setSessions(prev => prev.map(s => {
      if (s.id !== selSessionId) return s;
      if (stiValue === null) {
        if (s.stiResult === null && s.n === 0) return s; // already cleared
        return { ...s, stiResult: null, biasCorrectedSTI: null, n: 0 };
      }
      return { ...s, stiResult: stiValue, biasCorrectedSTI, n: analyzedRecs.length };
    }));
  }, [selSessionId, stiValue, biasCorrectedSTI, analyzedRecs.length]);

  // --- Export session data ---
  const exportSession = useCallback(() => {
    const session = sessions.find(s => s.id === selSessionId);
    if (!session) return;
    const exportData = {
      session: { name: session.name, targetPhrase: session.targetPhrase, date: session.date },
      n: analyzedRecs.length,
      sti: stiValue,
      // Always present (null when not applied) so the export schema is stable.
      biasCorrectedSTI: biasCorrection ? biasCorrectedSTI : null,
      biasCorrection,
      sdProfile: stiResult?.sdProfile ?? null,
      recordings: analyzedRecs.map(r => ({
        name: r.name, onset: r.onset, offset: r.offset,
        duration: r.offset - r.onset,
        normalizedEnvelope: r.normalizedEnvelope ? Array.from(r.normalizedEnvelope) : null,
      })),
      durationStats: { mean: durationStats.mean, sd: durationStats.sd },
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    // Strip whitespace and characters that are invalid in filenames (Windows/POSIX).
    const safeName = session.name.replace(/\s+/g, '_').replace(/[\\/:*?"<>|]/g, '-');
    a.href = url; a.download = `vocalprint_${safeName}_${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(url);
  }, [selSessionId, sessions, analyzedRecs, stiValue, biasCorrectedSTI, biasCorrection, stiResult, durationStats]);

  // --- Derived data ---
  const selPatient = patients.find(p => p.id === selPatientId);
  const selSession = sessions.find(s => s.id === selSessionId);
  const patientSessions = sessions.filter(s => s.patientId === selPatientId);

  // Detect cross-session phrase mismatches
  const distinctPhrases = useMemo(() => {
    return new Set(patientSessions.map(s => s.targetPhrase));
  }, [patientSessions]);

  // Chart colors for envelope overlays
  // Categorical palette for overlaid repetitions — saturated enough to
  // distinguish lines, dark enough to read on a white chart.
  const envColors = ['#2563EB', '#D55E00', '#059669', '#7C3AED', '#DB2777', '#0891B2', '#CA8A04',
    '#475569', '#0072B2', '#B91C1C', '#15803D', '#9333EA', '#C2410C', '#0D9488', '#BE185D'];

  // ============================================================
  // RENDER
  // ============================================================
  return (
    <div style={{
      display: 'flex', height: '100vh', width: '100vw', background: COLORS.bg,
      fontFamily: FONTS.sans, color: COLORS.text, overflow: 'hidden',
    }}>
      {/* ===================== SIDEBAR ===================== */}
      <div style={{
        width: sidebarOpen ? 280 : 48, minWidth: sidebarOpen ? 280 : 48,
        background: COLORS.navy, borderRight: `1px solid ${COLORS.border}`,
        display: 'flex', flexDirection: 'column', transition: 'width 0.2s, min-width 0.2s', overflow: 'hidden',
      }}>
        {/* Toggle button */}
        <button onClick={() => setSidebarOpen(!sidebarOpen)} style={{
          background: 'none', border: 'none', color: COLORS.teal, cursor: 'pointer',
          padding: '12px', fontSize: 18, textAlign: sidebarOpen ? 'right' : 'center',
        }}>
          {sidebarOpen ? '◁' : '▷'}
        </button>
        {sidebarOpen && (
          <div style={{ padding: '0 12px 12px', flex: 1, overflowY: 'auto' }}>
            {/* Logo */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontFamily: FONTS.display, fontSize: 22, color: COLORS.teal, fontWeight: 700 }}>VocalPrint</div>
              <div style={{ fontSize: 10, color: COLORS.dimText, fontFamily: FONTS.mono }}>E-STI Tracker</div>
            </div>
            {/* Patients */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: COLORS.dimText }}>Patients</span>
                <button className="vp-btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => setShowNewPatient(true)}>+ Add</button>
              </div>
              {patients.map(p => (
                <div key={p.id} onClick={() => { setSelPatientId(p.id); setSelSessionId(null); }}
                  style={{
                    padding: '8px 10px', borderRadius: 6, marginBottom: 4, cursor: 'pointer',
                    background: selPatientId === p.id ? COLORS.darkPanel : 'transparent',
                    borderLeft: selPatientId === p.id ? `3px solid ${COLORS.teal}` : '3px solid transparent',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{p.name}</div>
                    {p.pid && <div style={{ fontSize: 10, color: COLORS.dimText, fontFamily: FONTS.mono }}>{p.pid}</div>}
                  </div>
                  <button className="vp-btn-danger" style={{ padding: '1px 5px', fontSize: 10, background: 'none', border: 'none', cursor: 'pointer', color: COLORS.red }}
                    onClick={e => { e.stopPropagation(); if (confirm('Delete patient and all sessions?')) deletePatient(p.id); }}>✕</button>
                </div>
              ))}
              {patients.length === 0 && <div style={{ fontSize: 12, color: COLORS.dimText, padding: 8 }}>No patients yet</div>}
            </div>
            {/* Sessions */}
            {selPatientId && (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: COLORS.dimText }}>Sessions</span>
                  <button className="vp-btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => setShowNewSession(true)}>+ Add</button>
                </div>
                {patientSessions.map(s => (
                  <div key={s.id} onClick={() => setSelSessionId(s.id)}
                    style={{
                      padding: '8px 10px', borderRadius: 6, marginBottom: 4, cursor: 'pointer',
                      background: selSessionId === s.id ? COLORS.darkPanel : 'transparent',
                      borderLeft: selSessionId === s.id ? `3px solid ${COLORS.teal}` : '3px solid transparent',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{s.name}</div>
                      <div style={{ fontSize: 10, color: COLORS.dimText, fontFamily: FONTS.mono }}>{s.targetPhrase}</div>
                      {s.stiResult !== null && <div style={{ fontSize: 10, color: COLORS.teal, fontFamily: FONTS.mono }}>STI: {s.stiResult.toFixed(2)} (N={s.n})</div>}
                    </div>
                    <button style={{ padding: '1px 5px', fontSize: 10, background: 'none', border: 'none', cursor: 'pointer', color: COLORS.red }}
                      onClick={e => { e.stopPropagation(); if (confirm('Delete session?')) deleteSession(s.id); }}>✕</button>
                  </div>
                ))}
                {patientSessions.length === 0 && <div style={{ fontSize: 12, color: COLORS.dimText, padding: 8 }}>No sessions yet</div>}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ===================== MAIN CONTENT ===================== */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>

        {/* --- MODALS --- */}
        <Modal open={showNewPatient} onClose={() => setShowNewPatient(false)} title="New Patient">
          <div style={{ marginBottom: 12 }}>
            <div className="vp-label">Patient Name *</div>
            <input className="vp-input" value={newPatientName} onChange={e => setNewPatientName(e.target.value)}
              placeholder="e.g., John Smith" autoFocus onKeyDown={e => e.key === 'Enter' && createPatient()} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <div className="vp-label">Patient ID (optional)</div>
            <input className="vp-input" value={newPatientPid} onChange={e => setNewPatientPid(e.target.value)}
              placeholder="e.g., P-001" onKeyDown={e => e.key === 'Enter' && createPatient()} />
          </div>
          <button className="vp-btn vp-btn-primary" onClick={createPatient} style={{ width: '100%' }}>Create Patient</button>
        </Modal>

        <Modal open={showNewSession} onClose={() => setShowNewSession(false)} title="New Session">
          <div style={{ marginBottom: 12 }}>
            <div className="vp-label">Session Name *</div>
            <input className="vp-input" value={newSessionName} onChange={e => setNewSessionName(e.target.value)}
              placeholder="e.g., Session 1 — baseline" autoFocus />
          </div>
          <div style={{ marginBottom: 16 }}>
            <div className="vp-label">Target Phrase * (must be identical across recordings)</div>
            <input className="vp-input" value={newSessionPhrase} onChange={e => setNewSessionPhrase(e.target.value)}
              placeholder="e.g., Buy Bobby a puppy" onKeyDown={e => e.key === 'Enter' && createSession()} />
          </div>
          <div style={{ fontSize: 11, color: COLORS.dimText, marginBottom: 16 }}>
            The STI can only be compared across recordings of the same target utterance (same words, same syllable count).
          </div>
          <button className="vp-btn vp-btn-primary" onClick={createSession} style={{ width: '100%' }}>Create Session</button>
        </Modal>

        {/* --- WELCOME / NO SELECTION --- */}
        {!selPatientId && (
          <div style={{ textAlign: 'center', marginTop: 80 }}>
            <div style={{ fontFamily: FONTS.display, fontSize: 36, color: COLORS.teal, marginBottom: 8 }}>VocalPrint</div>
            <div style={{ fontFamily: FONTS.mono, fontSize: 14, color: COLORS.dimText, marginBottom: 24 }}>
              Envelope-based Spatiotemporal Index Tracker
            </div>
            <div style={{ color: COLORS.dimText, fontSize: 14, marginBottom: 24 }}>
              Create a patient profile to begin tracking speech motor stability.
            </div>
            <button className="vp-btn vp-btn-primary" onClick={() => setShowNewPatient(true)}>Create First Patient</button>
          </div>
        )}

        {/* --- PATIENT DETAIL (no session selected) --- */}
        {selPatientId && !selSessionId && (
          <div>
            <h2 style={{ fontFamily: FONTS.display, fontSize: 24, color: COLORS.text, marginBottom: 4 }}>
              {selPatient?.name}
            </h2>
            {selPatient?.pid && <div style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.dimText, marginBottom: 16 }}>ID: {selPatient.pid}</div>}
            <button className="vp-btn vp-btn-primary" onClick={() => setShowNewSession(true)} style={{ marginBottom: 24 }}>+ New Session</button>

            {/* Cross-session phrase mismatch warning */}
            {distinctPhrases.size > 1 && (
              <div style={{ background: 'rgba(245,158,11,0.1)', border: `1px solid ${COLORS.amber}`, borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 12, color: COLORS.amber }}>
                ⚠ This patient has sessions with different target phrases ({Array.from(distinctPhrases).map(p => `"${p}"`).join(', ')}). STI values are only comparable across sessions using the same utterance.
              </div>
            )}

            {/* STI Trend Chart */}
            {patientSessions.filter(s => s.stiResult !== null).length > 0 && (
              <div style={{ background: COLORS.navy, borderRadius: 12, padding: 20, border: `1px solid ${COLORS.border}` }}>
                <h3 style={{ fontFamily: FONTS.display, fontSize: 18, marginBottom: 16 }}>STI Trend Over Time</h3>
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart data={patientSessions.filter(s => s.stiResult !== null).map(s => ({
                    name: s.name, sti: s.stiResult, date: new Date(s.date).toLocaleDateString(), n: s.n, phrase: s.targetPhrase,
                  }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
                    <XAxis dataKey="name" stroke={COLORS.dimText} fontSize={11} />
                    <YAxis stroke={COLORS.dimText} fontSize={11} />
                    <Tooltip contentStyle={{ background: COLORS.navy, border: `1px solid ${COLORS.border}`, borderRadius: 8, fontFamily: FONTS.mono, fontSize: 12 }}
                      formatter={(value, name) => [value.toFixed(2), name]}
                      labelFormatter={(label, payload) => {
                        if (payload && payload[0]) {
                          const d = payload[0].payload;
                          return `${label} — "${d.phrase}" (N=${d.n}, ${d.date})`;
                        }
                        return label;
                      }} />
                    <Line type="monotone" dataKey="sti" stroke={COLORS.teal} strokeWidth={2} dot={{ fill: COLORS.teal, r: 5 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        )}

        {/* --- SESSION VIEW --- */}
        {selSession && (
          <div>
            {/* Session header */}
            <div style={{ marginBottom: 20 }}>
              <h2 style={{ fontFamily: FONTS.display, fontSize: 24, color: COLORS.text, marginBottom: 2 }}>{selSession.name}</h2>
              <div style={{ fontFamily: FONTS.mono, fontSize: 13, color: COLORS.teal }}>Target: "{selSession.targetPhrase}"</div>
              <div style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.dimText, marginTop: 2 }}>
                {new Date(selSession.date).toLocaleDateString()} · {recordings.length} recording{recordings.length !== 1 ? 's' : ''} · {analyzedRecs.length} analyzed
              </div>
            </div>

            {/* Methodological warnings */}
            {analyzedRecs.length > 0 && analyzedRecs.length < MIN_RECS && (
              <div style={{ background: 'rgba(245,158,11,0.1)', border: `1px solid ${COLORS.amber}`, borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 12, color: COLORS.amber }}>
                ⚠ Only {analyzedRecs.length} recording{analyzedRecs.length !== 1 ? 's' : ''} analyzed. Minimum recommended: {MIN_RECS}. The literature typically uses 10–15 repetitions for reliable STI estimates (Wisler et al. 2022).
              </div>
            )}
            {durationStats.warn && (
              <div style={{ background: 'rgba(245,158,11,0.1)', border: `1px solid ${COLORS.amber}`, borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 12, color: COLORS.amber }}>
                ⚠ Parsed duration SD = {(durationStats.sd * 1000).toFixed(1)} ms (threshold: {PARSE_WARN_MS} ms). Inconsistent onset/offset placement inflates STI (Wisler et al. 2022). Review your onset/offset markers.
              </div>
            )}

            {/* Recording controls */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
              {isRecording ? (
                <button className="vp-btn" style={{ borderColor: COLORS.red, color: COLORS.red }}
                  onClick={stopRecording}>■ Stop Recording</button>
              ) : (
                <button className="vp-btn vp-btn-primary" onClick={startRecording}>● Record</button>
              )}
              <button className="vp-btn" onClick={() => fileInputRef.current?.click()}>↑ Upload Audio</button>
              <input ref={fileInputRef} type="file" accept=".wav,.mp3,.webm,.ogg,audio/*" multiple hidden
                onChange={e => { if (e.target.files?.length) handleFileUpload(Array.from(e.target.files)); e.target.value = ''; }} />
              {processing && <><Spinner size={18} /> <span style={{ fontSize: 12, color: COLORS.dimText }}>Processing audio...</span></>}
            </div>

            {/* Drag-and-drop zone */}
            <div style={{
              border: `2px dashed ${COLORS.border}`, borderRadius: 8, padding: 16, textAlign: 'center',
              marginBottom: 16, fontSize: 12, color: COLORS.dimText, cursor: 'pointer',
            }}
              onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = COLORS.teal; }}
              onDragLeave={e => { e.currentTarget.style.borderColor = COLORS.border; }}
              onDrop={e => { e.preventDefault(); e.currentTarget.style.borderColor = COLORS.border; handleFileUpload(Array.from(e.dataTransfer.files)); }}
              onClick={() => fileInputRef.current?.click()}>
              Drop audio files here (.wav, .mp3, .webm, .ogg) or click to browse
            </div>

            {/* Live waveform during recording */}
            {isRecording && <LiveWaveformCanvas analyserRef={analyserRef} isRecording={isRecording} />}

            {/* Recording list */}
            {recordings.map((rec, idx) => (
              <div key={rec.id} style={{
                background: COLORS.navy, border: `1px solid ${COLORS.border}`, borderRadius: 10,
                padding: 14, marginBottom: 12, animation: 'vp-fadeIn 0.3s ease',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontFamily: FONTS.mono, fontSize: 13, fontWeight: 500 }}>#{idx + 1} {rec.name}</span>
                    <span style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.dimText }}>{rec.duration.toFixed(2)}s @ {rec.sampleRate}Hz</span>
                    {rec.duration < 0.5 && <span style={{ fontSize: 10, color: COLORS.red }}>Too short</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="vp-btn" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => playRecording(rec)}>▶ Play</button>
                    <button className="vp-btn" style={{ padding: '3px 8px', fontSize: 11, color: COLORS.red, borderColor: COLORS.red }}
                      onClick={() => deleteRecording(rec.id)}>✕</button>
                  </div>
                </div>
                <WaveformCanvas
                  envelope={rec.envelope} sampleRate={rec.sampleRate}
                  onset={rec.onset} offset={rec.offset}
                  onOnsetChange={t => updateRecOnset(rec.id, t)}
                  onOffsetChange={t => updateRecOffset(rec.id, t)}
                />
                <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 11, fontFamily: FONTS.mono, color: COLORS.dimText }}>
                  <span>Onset: {rec.onset !== null ? rec.onset.toFixed(3) + 's' : '—'}</span>
                  <span>Offset: {rec.offset !== null ? rec.offset.toFixed(3) + 's' : '—'}</span>
                  <span>Parsed: {rec.onset !== null && rec.offset !== null ? ((rec.offset - rec.onset) * 1000).toFixed(1) + ' ms' : '—'}</span>
                  {rec.onset !== null && rec.offset !== null && durationStats.mean > 0 &&
                    Math.abs((rec.offset - rec.onset) - durationStats.mean) * 1000 > PARSE_WARN_MS && (
                    <span style={{ color: COLORS.amber }}>⚠ Duration differs from mean by {(Math.abs((rec.offset - rec.onset) - durationStats.mean) * 1000).toFixed(1)} ms</span>
                  )}
                </div>
                <div style={{ fontSize: 10, color: COLORS.dimText, marginTop: 4 }}>
                  Click waveform to set onset, click again to set offset. Drag markers to adjust.
                </div>
              </div>
            ))}

            {/* ===================== RESULTS DASHBOARD ===================== */}
            {analyzedRecs.length >= 2 && (
              <div style={{ marginTop: 24 }}>
                <h3 style={{ fontFamily: FONTS.display, fontSize: 20, color: COLORS.text, marginBottom: 16 }}>Analysis Results</h3>

                {/* Informational message when between 2-4 recordings */}
                {analyzedRecs.length >= 2 && analyzedRecs.length < MIN_RECS && (
                  <div style={{ background: 'rgba(37,99,235,0.08)', border: `1px solid ${COLORS.teal}`, borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 12, color: COLORS.teal }}>
                    {analyzedRecs.length < 3
                      ? `${analyzedRecs.length} recordings analyzed — QC table available. Add ${3 - analyzedRecs.length} more for envelope overlay preview, ${MIN_RECS - analyzedRecs.length} more for full STI analysis and export.`
                      : `${analyzedRecs.length} recordings analyzed — overlay preview available. Add ${MIN_RECS - analyzedRecs.length} more for full STI + SD profile analysis and export.`
                    }
                  </div>
                )}

                {/* STI Display — only show at >= 5 recordings */}
                {analyzedRecs.length >= MIN_RECS && (
                  <div style={{
                    display: 'flex', gap: 24, justifyContent: 'center', flexWrap: 'wrap',
                    background: COLORS.navy, borderRadius: 12, padding: 24, border: `1px solid ${COLORS.border}`, marginBottom: 20,
                  }}>
                    <AnimatedSTI value={stiValue} label={`STI (N = ${analyzedRecs.length})`} />
                    {biasCorrection && <AnimatedSTI value={biasCorrectedSTI} label="Bias-Corrected STI" color={COLORS.amber} />}
                    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12 }}>
                        <input type="checkbox" checked={biasCorrection} onChange={e => setBiasCorrection(e.target.checked)} />
                        Bias correction (Wisler et al. 2022)
                      </label>
                      <div style={{ fontSize: 10, color: COLORS.dimText }}>
                        Healthy adult range: ~12-22 (for "Buy Bobby a puppy")
                      </div>
                    </div>
                  </div>
                )}

                {/* Overlay Chart — show at >= 3 recordings */}
                {analyzedRecs.length >= 3 && (
                  <div style={{ background: COLORS.navy, borderRadius: 12, padding: 20, border: `1px solid ${COLORS.border}`, marginBottom: 20 }}>
                    <h4 style={{ fontFamily: FONTS.display, fontSize: 16, marginBottom: 12, color: COLORS.text }}>
                      Normalized Envelope Overlay {analyzedRecs.length < MIN_RECS ? '(Preview)' : ''}
                    </h4>
                    <div style={{ fontSize: 11, color: COLORS.dimText, marginBottom: 8 }}>
                      Tight bunching = stable motor output. Wide spread = variable.
                    </div>
                    <ResponsiveContainer width="100%" height={280}>
                      <LineChart data={overlayData}>
                        <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
                        <XAxis dataKey="time" stroke={COLORS.dimText} fontSize={10} label={{ value: 'Normalized Time (%)', position: 'insideBottom', offset: -5, style: { fontSize: 10, fill: COLORS.dimText } }} />
                        <YAxis stroke={COLORS.dimText} fontSize={10} label={{ value: 'Amplitude (z)', angle: -90, position: 'insideLeft', style: { fontSize: 10, fill: COLORS.dimText } }} />
                        <Tooltip contentStyle={{ background: COLORS.navy, border: `1px solid ${COLORS.border}`, borderRadius: 8, fontFamily: FONTS.mono, fontSize: 11 }} />
                        {analyzedRecs.map((_, i) => (
                          <Line key={i} type="monotone" dataKey={`r${i}`} stroke={envColors[i % envColors.length]}
                            strokeWidth={1.5} dot={false} strokeOpacity={0.7} name={`Rep ${i + 1}`} />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* SD Profile Chart — show at >= 5 recordings */}
                {analyzedRecs.length >= MIN_RECS && stiResult && (
                  <div style={{ background: COLORS.navy, borderRadius: 12, padding: 20, border: `1px solid ${COLORS.border}`, marginBottom: 20 }}>
                    <h4 style={{ fontFamily: FONTS.display, fontSize: 16, marginBottom: 12, color: COLORS.text }}>
                      Standard Deviation Profile (50 points)
                    </h4>
                    <div style={{ fontSize: 11, color: COLORS.dimText, marginBottom: 8 }}>
                      SD across {analyzedRecs.length} repetitions at 50 equally-spaced time points. Peaks indicate regions of high articulatory variability.
                    </div>
                    <ResponsiveContainer width="100%" height={220}>
                      <LineChart data={sdData}>
                        <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
                        <XAxis dataKey="time" stroke={COLORS.dimText} fontSize={10} label={{ value: 'Normalized Time (%)', position: 'insideBottom', offset: -5, style: { fontSize: 10, fill: COLORS.dimText } }} />
                        <YAxis stroke={COLORS.dimText} fontSize={10} label={{ value: 'SD', angle: -90, position: 'insideLeft', style: { fontSize: 10, fill: COLORS.dimText } }} />
                        <Tooltip contentStyle={{ background: COLORS.navy, border: `1px solid ${COLORS.border}`, borderRadius: 8, fontFamily: FONTS.mono, fontSize: 11 }} />
                        <Line type="monotone" dataKey="sd" stroke={COLORS.amber} strokeWidth={2} dot={{ fill: COLORS.amber, r: 3 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* Parsing QC Table — show at >= 2 recordings */}
                {parsedDurations.length > 0 && (
                  <div style={{ background: COLORS.navy, borderRadius: 12, padding: 20, border: `1px solid ${COLORS.border}`, marginBottom: 20 }}>
                    <h4 style={{ fontFamily: FONTS.display, fontSize: 16, marginBottom: 12, color: COLORS.text }}>
                      Parsing Quality Control
                    </h4>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONTS.mono, fontSize: 12 }}>
                        <thead>
                          <tr style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                            <th style={{ textAlign: 'left', padding: '6px 8px', color: COLORS.dimText, fontWeight: 500 }}>Recording</th>
                            <th style={{ textAlign: 'right', padding: '6px 8px', color: COLORS.dimText, fontWeight: 500 }}>Onset (s)</th>
                            <th style={{ textAlign: 'right', padding: '6px 8px', color: COLORS.dimText, fontWeight: 500 }}>Offset (s)</th>
                            <th style={{ textAlign: 'right', padding: '6px 8px', color: COLORS.dimText, fontWeight: 500 }}>Duration (ms)</th>
                            <th style={{ textAlign: 'center', padding: '6px 8px', color: COLORS.dimText, fontWeight: 500 }}>Flag</th>
                          </tr>
                        </thead>
                        <tbody>
                          {parsedDurations.map(d => {
                            const devMs = Math.abs(d.duration - durationStats.mean) * 1000;
                            const flagged = devMs > PARSE_WARN_MS;
                            return (
                              <tr key={d.id} style={{ borderBottom: `1px solid ${COLORS.border}`, background: flagged ? 'rgba(245,158,11,0.06)' : 'transparent' }}>
                                <td style={{ padding: '6px 8px' }}>{d.name}</td>
                                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{d.onset.toFixed(3)}</td>
                                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{d.offset.toFixed(3)}</td>
                                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{(d.duration * 1000).toFixed(1)}</td>
                                <td style={{ padding: '6px 8px', textAlign: 'center', color: flagged ? COLORS.amber : COLORS.green }}>
                                  {flagged ? `⚠ +${devMs.toFixed(1)} ms` : '✓'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot>
                          <tr style={{ borderTop: `2px solid ${COLORS.border}` }}>
                            <td style={{ padding: '6px 8px', fontWeight: 600 }}>Summary</td>
                            <td colSpan={2} style={{ padding: '6px 8px', textAlign: 'right' }}>
                              Mean: {(durationStats.mean * 1000).toFixed(1)} ms
                            </td>
                            <td style={{ padding: '6px 8px', textAlign: 'right', color: durationStats.warn ? COLORS.amber : COLORS.text }}>
                              SD: {(durationStats.sd * 1000).toFixed(1)} ms
                            </td>
                            <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                              {durationStats.warn && <span style={{ color: COLORS.amber }}>⚠ SD &gt; {PARSE_WARN_MS} ms</span>}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>
                )}

                {/* Export — only at >= 5 recordings */}
                {analyzedRecs.length >= MIN_RECS && (
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button className="vp-btn vp-btn-primary" onClick={exportSession}>↓ Export Session JSON</button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
