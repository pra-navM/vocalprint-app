// Privacy-preserving, cookieless analytics.
//
// Sends ONLY anonymous event names (e.g. "sti_computed") via a pixel request —
// never patient names, IDs, target phrases, or STI values. No cookies, no
// fingerprinting, no third-party script.
//
// Fully disabled unless VITE_GOATCOUNTER_URL is set at build time, and always
// disabled when the user has Do-Not-Track enabled. If unconfigured it is a
// complete no-op, so nothing is sent from local/offline use.

function endpoint() {
  // e.g. "https://stitracker.goatcounter.com/count"
  return (import.meta.env && import.meta.env.VITE_GOATCOUNTER_URL) || '';
}

function doNotTrack() {
  if (typeof navigator === 'undefined') return false;
  const v = navigator.doNotTrack || (typeof window !== 'undefined' && window.doNotTrack) || navigator.msDoNotTrack;
  return v === '1' || v === 'yes';
}

function send(path) {
  const url = endpoint();
  if (!url || doNotTrack()) return;
  try {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    // Only the path/event name is transmitted — no patient data, ever.
    img.src = `${url}?p=${encodeURIComponent(path)}`;
  } catch {
    /* analytics must never affect the app */
  }
}

/** Count a page visit. */
export function pageview() {
  send(typeof location !== 'undefined' ? location.pathname : '/');
}

/** Count a named usage event (no values, no PHI). e.g. track('sti_computed'). */
export function track(event) {
  send(`/event/${event}`);
}
