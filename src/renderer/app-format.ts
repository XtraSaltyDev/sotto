import type {
  LiveRecordingSnapshot,
  SavedRecordingSummary,
  TranscriptionJobSnapshot,
} from '../shared/contracts';
import {
  MAX_EXPECTED_SPEAKER_COUNT,
  MIN_EXPECTED_SPEAKER_COUNT,
} from '../shared/contracts';
import {
  appThemeFromPreference,
  THEME_STORAGE_KEY,
  type AppTheme,
} from './theme';

export const formatDuration = (durationMs: number): string => {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds
        .toString()
        .padStart(2, '0')}`
    : `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

export const formatDate = (value: string): string =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));

export const formatFileSize = (bytes: number): string => {
  if (bytes < 1_024 * 1_024) return `${Math.max(1, Math.round(bytes / 1_024))} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(bytes < 10 * 1_024 * 1_024 ? 1 : 0)} MB`;
};

export const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });

export const isRunningJob = (job: TranscriptionJobSnapshot | null): boolean =>
  job !== null &&
  ['preparing', 'normalizing', 'transcribing', 'saving'].includes(job.stage);

export const jobLabel = (job: TranscriptionJobSnapshot): string => {
  if (job.stage === 'normalizing') return 'Preparing audio';
  if (job.stage === 'transcribing') return 'Transcribing locally';
  if (job.stage === 'saving') return 'Saving transcript';
  if (job.stage === 'completed') return 'Transcript complete';
  if (job.stage === 'cancelled') return 'Transcription cancelled';
  if (job.stage === 'failed') return 'Could not transcribe recording';
  return 'Preparing recording';
};

export const recordingLabel = (recording: LiveRecordingSnapshot | null): string =>
  recording?.kind === 'dictation'
    ? 'Recording dictation'
    : recording
      ? 'Recording live meeting audio'
      : 'Record live meeting';

export const recordingElapsedMs = (
  recording: LiveRecordingSnapshot,
  now = Date.now(),
): number => {
  const elapsedWhilePaused = recording.paused && recording.pausedAt
    ? Math.max(0, now - Date.parse(recording.pausedAt))
    : 0;
  return Math.max(
    0,
    now - Date.parse(recording.startedAt) - recording.pausedDurationMs - elapsedWhilePaused,
  );
};

export const dictationShortcutLabel = (): string =>
  /Mac|iPhone|iPad/iu.test(navigator.platform)
    ? '⌘⇧D · mic only'
    : 'Ctrl+Shift+D · mic only';

export const EXPECTED_SPEAKER_OPTIONS = Array.from(
  {
    length:
      MAX_EXPECTED_SPEAKER_COUNT - MIN_EXPECTED_SPEAKER_COUNT + 1,
  },
  (_, index) => MIN_EXPECTED_SPEAKER_COUNT + index,
);

export const savedRecordingLabel = (recording: SavedRecordingSummary): string => {
  if (recording.transcriptionState === 'completed') return 'Transcript ready';
  if (recording.transcriptionState === 'transcribing') return 'Transcribing';
  if (recording.transcriptionState === 'failed') return 'Transcription failed';
  if (recording.transcriptionState === 'cancelled') return 'Transcription cancelled';
  return 'Ready to transcribe';
};

export const recordingMimeType = (): string | undefined => {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm'];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
};

export type MeetingDetailMode = 'summary' | 'transcript';

export const meetingDetailModeForKey = (
  current: MeetingDetailMode,
  key: string,
): MeetingDetailMode | null => {
  if (key === 'Home') return 'summary';
  if (key === 'End') return 'transcript';
  // With exactly two tabs, every arrow key wraps to the other tab. Revisit
  // this if the meeting detail view ever gains a third mode.
  if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(key)) {
    return current === 'summary' ? 'transcript' : 'summary';
  }
  return null;
};

export const closeOutputMenu = (target: HTMLElement): void => {
  target.closest('details')?.removeAttribute('open');
};

export const initialAppTheme = (): AppTheme => {
  let storedTheme: string | null = null;
  try {
    storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // A restricted storage area should not prevent Sotto from opening.
  }
  const prefersDark =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  return appThemeFromPreference(storedTheme, prefersDark);
};
