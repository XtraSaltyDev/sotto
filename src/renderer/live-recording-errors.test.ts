import { describe, expect, it } from 'vitest';

import {
  GENERIC_RECORDING_PERMISSION_GUIDANCE,
  liveRecordingStartErrorMessage,
  MACOS_RECORDING_PERMISSION_GUIDANCE,
  WINDOWS_RECORDING_CAPTURE_GUIDANCE,
} from './live-recording-errors';

describe('live recording error guidance', () => {
  it.each([
    new DOMException('Invalid capture constraints', 'AbortError'),
    new DOMException('Permission denied', 'NotAllowedError'),
  ])('replaces browser permission failures with macOS setup steps', (error) => {
    expect(liveRecordingStartErrorMessage(error, 'MacIntel')).toBe(
      MACOS_RECORDING_PERMISSION_GUIDANCE,
    );
  });

  it.each([
    new DOMException('Invalid capture constraints', 'AbortError'),
    new DOMException('Permission denied', 'NotAllowedError'),
  ])('uses Windows capture guidance for Windows permission failures', (error) => {
    const message = liveRecordingStartErrorMessage(error, 'Win32');

    expect(message).toBe(WINDOWS_RECORDING_CAPTURE_GUIDANCE);
    expect(message).not.toMatch(/macOS|System Settings/iu);
  });

  it('uses platform-neutral guidance when the renderer platform is unknown', () => {
    expect(
      liveRecordingStartErrorMessage(
        new DOMException('Permission denied', 'NotAllowedError'),
        'Linux x86_64',
      ),
    ).toBe(GENERIC_RECORDING_PERMISSION_GUIDANCE);
  });

  it('preserves a specific non-permission failure', () => {
    expect(
      liveRecordingStartErrorMessage(new Error('Audio encoding failed.'), 'Win32'),
    ).toBe('Audio encoding failed.');
  });

  it('uses a safe fallback for unknown thrown values', () => {
    expect(liveRecordingStartErrorMessage('failed', 'MacIntel')).toBe(
      'Sotto could not start live meeting capture.',
    );
  });
});
