export const MACOS_RECORDING_PERMISSION_GUIDANCE =
  'Sotto cannot access system audio. In System Settings → Privacy & Security → Screen & System Audio Recording, add Sotto and turn it on, then quit and reopen Sotto.';

export const WINDOWS_RECORDING_CAPTURE_GUIDANCE =
  'Sotto could not start Windows system-audio capture. Make sure an audio output device is active and allow any Windows capture prompt, then try again.';

export const GENERIC_RECORDING_PERMISSION_GUIDANCE =
  'Sotto could not access system audio. Check this device\'s recording permissions, then try again.';

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
