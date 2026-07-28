import { describe, expect, it } from 'vitest';

import {
  liveRecordingStartErrorMessage,
  MACOS_RECORDING_PERMISSION_GUIDANCE,
} from './live-recording-errors';

describe('live recording error guidance', () => {
  it.each([
    new DOMException('Invalid capture constraints', 'AbortError'),
    new DOMException('Permission denied', 'NotAllowedError'),
  ])('replaces browser permission failures with macOS setup steps', (error) => {
    expect(liveRecordingStartErrorMessage(error)).toBe(
      MACOS_RECORDING_PERMISSION_GUIDANCE,
    );
  });

  it('preserves a specific non-permission failure', () => {
    expect(
      liveRecordingStartErrorMessage(new Error('Audio encoding failed.')),
    ).toBe('Audio encoding failed.');
  });

  it('uses a safe fallback for unknown thrown values', () => {
    expect(liveRecordingStartErrorMessage('failed')).toBe(
      'Sotto could not start live meeting capture.',
    );
  });
});
