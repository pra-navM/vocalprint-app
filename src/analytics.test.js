import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { track, pageview } from './analytics.js';

// Capture any pixel requests the module would make.
let sent;
class MockImage {
  set src(v) { sent.push(v); }
  get src() { return sent[sent.length - 1]; }
}

beforeEach(() => {
  sent = [];
  globalThis.Image = MockImage;
  // default: tracking not disabled by DNT
  Object.defineProperty(navigator, 'doNotTrack', { value: '0', configurable: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('analytics', () => {
  it('is a complete no-op when no endpoint is configured', () => {
    track('sti_computed');
    pageview();
    expect(sent).toHaveLength(0);
  });

  it('sends only the event name when configured (no PHI in payload)', () => {
    vi.stubEnv('VITE_GOATCOUNTER_URL', 'https://x.goatcounter.com/count');
    track('sti_computed');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('https://x.goatcounter.com/count');
    expect(sent[0]).toContain(encodeURIComponent('/event/sti_computed'));
    // Guardrail: nothing identifying is ever in the payload.
    for (const term of ['patient', 'pid', 'name', 'phrase', 'Bobby']) {
      expect(sent[0].toLowerCase()).not.toContain(term.toLowerCase());
    }
  });

  it('does nothing when Do-Not-Track is enabled, even if configured', () => {
    vi.stubEnv('VITE_GOATCOUNTER_URL', 'https://x.goatcounter.com/count');
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true });
    track('sti_computed');
    pageview();
    expect(sent).toHaveLength(0);
  });

  it('never throws even if Image construction fails', () => {
    vi.stubEnv('VITE_GOATCOUNTER_URL', 'https://x.goatcounter.com/count');
    globalThis.Image = class { set src(_v) { throw new Error('blocked'); } };
    expect(() => track('sti_computed')).not.toThrow();
  });
});
