export const MACOS_RECORDING_PERMISSION_GUIDANCE =
  'Sotto cannot access system audio. In System Settings → Privacy & Security → Screen & System Audio Recording, add Sotto and turn it on, then quit and reopen Sotto. No recording was started.';

export const WINDOWS_RECORDING_CAPTURE_GUIDANCE =
  'Sotto could not start Windows system-audio capture. Make sure an audio output device is active and allow any Windows capture prompt, then try again. No recording was started.';

export const GENERIC_RECORDING_PERMISSION_GUIDANCE =
  'Sotto could not access system audio. Check this device\'s recording permissions, then try again. No recording was started.';

export interface RecordingFailurePresentation {
  kind: 'error' | 'recovery';
  title: string;
}

const normalizedPlatform = (platform: string): string =>
  platform.trim().toLowerCase();

const isMacOSPlatform = (platform: string): boolean => {
  const normalized = normalizedPlatform(platform);
  return normalized === 'darwin' || normalized.startsWith('mac');
};

const isWindowsPlatform = (platform: string): boolean => {
  const normalized = normalizedPlatform(platform);
  return normalized === 'win32' || normalized.startsWith('windows');
};

export const liveRecordingStartErrorMessage = (
  error: unknown,
  platform: string,
): string => {
  if (!(error instanceof Error)) {
    return 'Sotto could not start live meeting capture.';
  }

  if (
    error.name === 'NotAllowedError' ||
    /invalid capture constraints|permission denied|not allowed/iu.test(error.message)
  ) {
    if (isMacOSPlatform(platform)) return MACOS_RECORDING_PERMISSION_GUIDANCE;
    if (isWindowsPlatform(platform)) return WINDOWS_RECORDING_CAPTURE_GUIDANCE;
    return GENERIC_RECORDING_PERMISSION_GUIDANCE;
  }

  return error.message;
};

export const recordingFailurePresentation = (
  message: string,
  platform: string,
): RecordingFailurePresentation => {
  if (/kept for automatic recovery|recovered locally/iu.test(message)) {
    return { kind: 'recovery', title: 'Your recording was kept' };
  }
  if (/imports? (?:of .*)?w(?:as|ere) interrupted/iu.test(message)) {
    return { kind: 'error', title: 'An import did not finish' };
  }
  if (/could not be read and (?:is|are) hidden/iu.test(message)) {
    return { kind: 'error', title: 'Some transcripts are hidden' };
  }
  if (/storage|disk|free up space|ENOSPC/iu.test(message)) {
    return { kind: 'error', title: 'Local storage needs attention' };
  }
  if (/permission|access|system settings|system-audio capture|capture prompt/iu.test(message)) {
    if (isMacOSPlatform(platform)) {
      return { kind: 'error', title: 'Allow recording access on macOS' };
    }
    if (isWindowsPlatform(platform)) {
      return { kind: 'error', title: 'Windows audio capture did not start' };
    }
  }
  return { kind: 'error', title: 'Sotto could not complete that action' };
};
