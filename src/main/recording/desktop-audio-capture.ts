import type { LiveRecordingCapability } from '../../shared/contracts';

export const MACOS_DESKTOP_AUDIO_FALLBACK_FEATURE =
  'MacCatapLoopbackAudioForScreenShare';

export const MACOS_SCREEN_RECORDING_SETTINGS_URLS = [
  'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture',
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
] as const;

export type ScreenRecordingAccessStatus =
  | 'denied'
  | 'granted'
  | 'not-determined'
  | 'restricted'
  | 'unknown';

type CommandLineSwitchTarget = {
  appendSwitch: (name: string, value?: string) => void;
  getSwitchValue: (name: string) => string;
};

export const configureMacDesktopAudioFallback = (
  platform: NodeJS.Platform,
  commandLine: CommandLineSwitchTarget,
): void => {
  if (platform !== 'darwin') return;

  const disabledFeatures = new Set(
    commandLine
      .getSwitchValue('disable-features')
      .split(',')
      .map((feature) => feature.trim())
      .filter(Boolean),
  );
  disabledFeatures.add(MACOS_DESKTOP_AUDIO_FALLBACK_FEATURE);

  commandLine.appendSwitch('disable-features', [...disabledFeatures].join(','));
};

export const resolveLiveRecordingCapability = (
  platform: NodeJS.Platform,
  systemVersion: string,
  screenAccessStatus: ScreenRecordingAccessStatus,
): LiveRecordingCapability => {
  if (platform === 'win32') {
    return {
      state: 'ready',
      message: 'Live meeting capture can record system audio and microphone input.',
    };
  }

  if (platform !== 'darwin') {
    return {
      state: 'unsupported',
      message: 'Live meeting capture is only supported on macOS and Windows.',
    };
  }

  const majorVersion = Number.parseInt(systemVersion.split('.')[0] ?? '', 10);
  if (!Number.isFinite(majorVersion) || majorVersion < 13) {
    return {
      state: 'unsupported',
      message: 'Live meeting capture requires macOS 13 or newer for desktop audio capture.',
    };
  }

  if (screenAccessStatus !== 'granted') {
    return {
      state: 'permission-required',
      message:
        'Add Sotto under System Settings → Privacy & Security → Screen & System Audio Recording, turn it on, then quit and reopen Sotto.',
    };
  }

  return {
    state: 'ready',
    message: 'Live meeting capture can record system audio and microphone input.',
  };
};
