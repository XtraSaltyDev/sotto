import { describe, expect, it } from 'vitest';

import {
  CAPTURE_SIGNAL_RMS_THRESHOLD,
  captureSourceGuidance,
  captureSourceStatus,
  hasUsableSignal,
  sourceHealth,
} from './capture-confidence';

describe('capture confidence', () => {
  it('recognizes a real signal while ignoring silence below the noise floor', () => {
    expect(hasUsableSignal(new Float32Array(128))).toBe(false);
    expect(
      hasUsableSignal(
        Float32Array.from({ length: 128 }, () => CAPTURE_SIGNAL_RMS_THRESHOLD * 2),
      ),
    ).toBe(true);
  });

  it('describes permission before a stream has been opened', () => {
    expect(captureSourceStatus(sourceHealth('denied', 'unknown', 'unknown'))).toEqual({
      label: 'Permission needed',
      tone: 'bad',
    });
    expect(captureSourceGuidance(
      'microphone',
      sourceHealth('denied', 'unknown', 'unknown'),
      'dictation',
    )).toMatch(/microphone access/iu);
  });

  it('keeps a quiet but valid track distinguishable from a missing track', () => {
    expect(captureSourceStatus(sourceHealth('granted', 'ready', 'silent'))).toEqual({
      label: 'No signal yet',
      tone: 'warning',
    });
    expect(captureSourceStatus(sourceHealth('granted', 'missing', 'silent'))).toEqual({
      label: 'No audio track',
      tone: 'bad',
    });
    expect(captureSourceGuidance(
      'desktop',
      sourceHealth('granted', 'ready', 'silent'),
      'meeting',
    )).toMatch(/Play meeting audio/iu);
  });
});
