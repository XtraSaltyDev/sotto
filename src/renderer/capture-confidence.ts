import type {
  CapturePermissionState,
  CaptureSignalState,
  CaptureTrackState,
  LiveCaptureSourceHealth,
} from '../shared/contracts';

/** A small RMS floor that ignores analyser noise while still catching speech. */
export const CAPTURE_SIGNAL_RMS_THRESHOLD = 0.012;
export const CAPTURE_SIGNAL_CHECK_DELAY_MS = 1_500;

export const hasUsableSignal = (
  samples: Float32Array,
  threshold = CAPTURE_SIGNAL_RMS_THRESHOLD,
): boolean => {
  if (samples.length === 0) return false;
  let sumSquares = 0;
  for (const sample of samples) sumSquares += sample * sample;
  return Math.sqrt(sumSquares / samples.length) >= threshold;
};

export const sourceHealth = (
  permission: CapturePermissionState,
  track: CaptureTrackState,
  signal: CaptureSignalState,
): LiveCaptureSourceHealth => ({ permission, track, signal });

export const captureSourceLabel = (source: 'desktop' | 'microphone'): string =>
  source === 'desktop' ? 'System audio' : 'Microphone';

export const captureSourceStatus = (
  health: LiveCaptureSourceHealth,
): { label: string; tone: 'neutral' | 'good' | 'warning' | 'bad' } => {
  if (health.permission === 'not-used') {
    return { label: 'Not used', tone: 'neutral' };
  }
  if (health.permission === 'denied') {
    return { label: 'Permission needed', tone: 'bad' };
  }
  if (health.track === 'missing') {
    return { label: 'No audio track', tone: 'bad' };
  }
  if (health.track === 'ended') {
    return { label: 'Track ended', tone: 'bad' };
  }
  if (health.track === 'unknown') {
    return health.permission === 'granted'
      ? { label: 'Permission granted', tone: 'good' }
      : { label: 'Not checked yet', tone: 'neutral' };
  }
  if (health.signal === 'detected') {
    return { label: 'Signal detected', tone: 'good' };
  }
  if (health.signal === 'silent') {
    return { label: 'No signal yet', tone: 'warning' };
  }
  return { label: 'Track ready · listening', tone: 'good' };
};

export const captureSourceGuidance = (
  source: 'desktop' | 'microphone',
  health: LiveCaptureSourceHealth,
  kind: 'meeting' | 'dictation',
): string | null => {
  if (health.permission === 'not-used') return null;
  if (health.permission === 'denied') {
    return source === 'desktop'
      ? 'Allow System Audio Recording for this Sotto, then retry the meeting recording.'
      : kind === 'dictation'
        ? 'Allow microphone access for this Sotto in System Settings, then retry.'
        : 'The meeting can continue without microphone audio; allow microphone access if you want the local speaker captured.';
  }
  if (health.track === 'missing') {
    return source === 'desktop'
      ? 'No system-audio track arrived. Check the meeting output and macOS recording access, then retry.'
      : 'No microphone track arrived. Check the selected input and microphone access, then retry.';
  }
  if (health.track === 'ended') {
    return source === 'desktop'
      ? 'System audio stopped. Check the meeting output and recording access before starting again.'
      : 'Microphone audio stopped. Check the input device before starting again.';
  }
  if (health.signal === 'silent') {
    return source === 'desktop'
      ? 'Play meeting audio. If this stays silent, check the meeting output and System Audio Recording access.'
      : 'Speak for a moment. If this stays silent, check the selected microphone in System Settings.';
  }
  return null;
};

export const sameCaptureHealth = (
  left: LiveCaptureSourceHealth,
  right: LiveCaptureSourceHealth,
): boolean =>
  left.permission === right.permission &&
  left.track === right.track &&
  left.signal === right.signal;
