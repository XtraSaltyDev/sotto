import { describe, expect, it, vi } from 'vitest';

import {
  configureMacDesktopAudioFallback,
  MACOS_DESKTOP_AUDIO_FALLBACK_FEATURE,
  resolveLiveRecordingCapability,
} from './desktop-audio-capture';

describe('macOS desktop audio capture', () => {
  it('uses Electron\'s Screen & System Audio Recording fallback on macOS', () => {
    const appendSwitch = vi.fn();
    const getSwitchValue = vi.fn().mockReturnValue('');

    configureMacDesktopAudioFallback('darwin', {
      appendSwitch,
      getSwitchValue,
    });

    expect(getSwitchValue).toHaveBeenCalledWith('disable-features');
    expect(appendSwitch).toHaveBeenCalledOnce();
    expect(appendSwitch).toHaveBeenCalledWith(
      'disable-features',
      MACOS_DESKTOP_AUDIO_FALLBACK_FEATURE,
    );
  });

  it('preserves existing disabled features without duplicating the fallback', () => {
    const appendSwitch = vi.fn();
    const getSwitchValue = vi
      .fn()
      .mockReturnValue(
        `ExistingFeature,${MACOS_DESKTOP_AUDIO_FALLBACK_FEATURE}`,
      );

    configureMacDesktopAudioFallback('darwin', {
      appendSwitch,
      getSwitchValue,
    });

    expect(appendSwitch).toHaveBeenCalledWith(
      'disable-features',
      `ExistingFeature,${MACOS_DESKTOP_AUDIO_FALLBACK_FEATURE}`,
    );
  });

  it.each<NodeJS.Platform>(['win32', 'linux'])(
    'does not change Electron capture behavior on %s',
    (platform) => {
      const appendSwitch = vi.fn();
      const getSwitchValue = vi.fn();

      configureMacDesktopAudioFallback(platform, {
        appendSwitch,
        getSwitchValue,
      });

      expect(appendSwitch).not.toHaveBeenCalled();
      expect(getSwitchValue).not.toHaveBeenCalled();
    },
  );

  it('allows a first user-started capture to request macOS permission', () => {
    expect(
      resolveLiveRecordingCapability('darwin', '26.5.2', 'not-determined'),
    ).toEqual({
      state: 'setup-required',
      message: expect.stringContaining('Start live recording'),
    });
    expect(
      resolveLiveRecordingCapability('darwin', '26.5.2', 'unknown').state,
    ).toBe('setup-required');
  });

  it('opens settings only after macOS has denied or restricted capture', () => {
    expect(
      resolveLiveRecordingCapability('darwin', '26.5.2', 'denied'),
    ).toEqual({
      state: 'permission-required',
      message: expect.stringContaining('Screen & System Audio Recording'),
    });
    expect(
      resolveLiveRecordingCapability('darwin', '26.5.2', 'restricted').state,
    ).toBe('permission-required');
  });

  it('is ready after macOS grants screen and system-audio capture', () => {
    expect(
      resolveLiveRecordingCapability('darwin', '26.5.2', 'granted'),
    ).toEqual({
      state: 'ready',
      message: expect.stringContaining('system audio'),
    });
  });

  it('checks the macOS version before asking for permission', () => {
    expect(
      resolveLiveRecordingCapability('darwin', '12.7.6', 'not-determined'),
    ).toEqual({
      state: 'unsupported',
      message: expect.stringContaining('macOS 13'),
    });
  });

  it('keeps Windows ready and other platforms unsupported', () => {
    expect(
      resolveLiveRecordingCapability('win32', '0', 'unknown').state,
    ).toBe('ready');
    expect(
      resolveLiveRecordingCapability('linux', '0', 'unknown').state,
    ).toBe('unsupported');
  });
});
