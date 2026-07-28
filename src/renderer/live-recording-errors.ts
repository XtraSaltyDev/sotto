export const MACOS_RECORDING_PERMISSION_GUIDANCE =
  'Sotto cannot access system audio. In System Settings → Privacy & Security → Screen & System Audio Recording, add Sotto and turn it on, then quit and reopen Sotto.';

export const liveRecordingStartErrorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return 'Sotto could not start live meeting capture.';
  }

  if (
    error.name === 'NotAllowedError' ||
    /invalid capture constraints|permission denied|not allowed/iu.test(error.message)
  ) {
    return MACOS_RECORDING_PERMISSION_GUIDANCE;
  }

  return error.message;
};
