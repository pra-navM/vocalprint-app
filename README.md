# STI Tracker — Envelope-based Spatiotemporal Index (E-STI) Analysis

A browser-based clinical tool for speech-language professionals to quantify **speech-motor
stability** using the **Envelope-based Spatiotemporal Index (E-STI)**. Record or upload
repeated productions of a target utterance, mark (or auto-detect) the onset/offset of each
repetition, and the app computes the STI and tracks it across sessions for each patient.

**Live app:** https://pra-navm.github.io/vocalprint-app/

## What it does

- Patients → sessions → repeated recordings, with a per-session target phrase.
- Records from the microphone or accepts uploaded audio (`.wav`, `.mp3`, `.webm`, `.ogg`).
- Extracts the amplitude **envelope** (half-wave rectification + 15 Hz low-pass).
- **Auto-detect** onset/offset from the envelope (energy-threshold), with manual click/drag override.
- Computes the **E-STI** with optional small-sample bias correction (Wisler et al. 2022),
  an SD profile, an envelope overlay, and a QC table for parse consistency.
- Tracks STI across sessions and exports a session as JSON.

## Privacy

All clinical data — patients, sessions, recordings, and analysis — **stays on the device**
in the browser (`localStorage` + IndexedDB). Nothing is uploaded; there is no server and no
account. The app is **installable as a PWA** and works fully offline once installed.

Tip: prefer coded identifiers (e.g. `P-001`) over names so the tool holds no identifiable data.

### Analytics (optional, anonymous, off by default)

Usage analytics are **disabled unless explicitly configured** and are always disabled when the
browser's *Do-Not-Track* is on. When enabled they send only **anonymous event names**
(e.g. `sti_computed`) via a cookieless pixel — never patient names, IDs, target phrases, or STI
values. See `src/analytics.js`. To enable, set a [GoatCounter](https://www.goatcounter.com/)
(or compatible) count URL at build time:

```bash
VITE_GOATCOUNTER_URL="https://yourcode.goatcounter.com/count" npm run build
```

## Develop

```bash
npm install
npm run dev       # local dev server
npm test          # vitest (DSP, persistence, helpers, end-to-end flow)
npm run lint
npm run build     # production build (PWA manifest + service worker)
npm run preview   # serve the production build locally
```

## Deploy

Pushing to `main` runs CI (lint + tests + build) and deploys to GitHub Pages. The Pages base
path is `/vocalprint-app/` (configured in `vite.config.js`).

## Method references

Howell et al. (2009); Benham et al. (2023); Vuolo & Wisler (2024); Wisler et al. (2022);
Smith et al. (1995); Smith & Goffman (1998).
