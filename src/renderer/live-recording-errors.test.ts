import { describe, expect, it } from 'vitest';

import {
  GENERIC_RECORDING_PERMISSION_GUIDANCE,
  liveRecordingStartErrorMessage,
  MACOS_RECORDING_PERMISSION_GUIDANCE,
  MACOS_RECORDING_SOURCE_GUIDANCE,
  recordingFailurePresentation,
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

  it.each([
    // What Chromium actually reports when loopback capture cannot open. It was
    // reaching the user as this bare string, explaining nothing.
    new DOMException('Could not start audio source', 'NotReadableError'),
    new DOMException('Could not start video source', 'NotReadableError'),
    new DOMException('Something else entirely', 'NotReadableError'),
  ])('explains a source that will not open on macOS', (error) => {
    const message = liveRecordingStartErrorMessage(error, 'MacIntel');

    expect(message).toBe(MACOS_RECORDING_SOURCE_GUIDANCE);
    // Per-copy approval is the part users cannot guess: a rebuilt or freshly
    // installed Sotto is a different app to macOS.
    expect(message).toMatch(/per copy/iu);
    expect(message).toMatch(/another app is holding the audio device/iu);
  });

  it('uses Windows capture guidance when a source will not open on Windows', () => {
    const message = liveRecordingStartErrorMessage(
      new DOMException('Could not start audio source', 'NotReadableError'),
      'Win32',
    );

    expect(message).toBe(WINDOWS_RECORDING_CAPTURE_GUIDANCE);
    expect(message).not.toMatch(/macOS|System Settings/iu);
  });

  it('prefers the denial explanation when a failure matches both', () => {
    // Denied by name, unopenable by message, so each branch matches through a
    // different test and only their order decides the answer.
    expect(
      liveRecordingStartErrorMessage(
        new DOMException('Could not start audio source', 'NotAllowedError'),
        'MacIntel',
      ),
    ).toBe(MACOS_RECORDING_PERMISSION_GUIDANCE);
  });

  it('heads an unopenable source without asserting which cause it was', () => {
    const presentation = recordingFailurePresentation(
      MACOS_RECORDING_SOURCE_GUIDANCE,
      'MacIntel',
    );

    expect(presentation).toEqual({
      kind: 'error',
      title: 'Sotto could not start system audio',
    });
    // Not the permission heading: the device may simply be busy.
    expect(presentation.title).not.toMatch(/allow/iu);
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

  it('gives macOS and Windows permission failures distinct headings', () => {
    expect(
      recordingFailurePresentation(MACOS_RECORDING_PERMISSION_GUIDANCE, 'MacIntel'),
    ).toEqual({ kind: 'error', title: 'Allow recording access on macOS' });
    expect(
      recordingFailurePresentation(WINDOWS_RECORDING_CAPTURE_GUIDANCE, 'Win32'),
    ).toEqual({ kind: 'error', title: 'Windows audio capture did not start' });
  });

  it('makes retained audio clear instead of presenting it as a total loss', () => {
    expect(
      recordingFailurePresentation(
        'Sotto could not finish saving the recording, but the closed audio was kept for automatic recovery after restart.',
        'Win32',
      ),
    ).toEqual({ kind: 'recovery', title: 'Your recording was kept' });
  });
});
