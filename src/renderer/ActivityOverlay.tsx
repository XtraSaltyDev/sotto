import { useEffect, useState } from 'react';

import type {
  ActivityAction,
  AppState,
  LiveRecordingSnapshot,
  TranscriptionJobSnapshot,
} from '../shared/contracts';
import { CancelIcon, MicrophoneIcon, SpinnerIcon } from './icons';

const RUNNING_STAGES = new Set([
  'preparing',
  'normalizing',
  'transcribing',
  'saving',
]);

const isRunningJob = (job: TranscriptionJobSnapshot | null): boolean =>
  job !== null && RUNNING_STAGES.has(job.stage);

const formatDuration = (durationMs: number): string => {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

const recordingTitle = (recording: LiveRecordingSnapshot): string =>
  recording.kind === 'dictation' ? 'Dictating' : 'Recording meeting';

const jobTitle = (job: TranscriptionJobSnapshot): string => {
  if (job.stage === 'normalizing' || job.stage === 'preparing') {
    return 'Preparing transcription';
  }
  if (job.stage === 'saving') return 'Saving transcript';
  return 'Transcribing';
};

export const ActivityOverlay = () => {
  const [appState, setAppState] = useState<AppState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pendingAction, setPendingAction] = useState<ActivityAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!window.sotto) return undefined;
    void window.sotto
      .getAppState()
      .then(setAppState)
      .catch(() => setError('Sotto could not load the current activity.'));
    return window.sotto.onAppStateChanged((nextState) => {
      setAppState(nextState);
      setError(null);
    });
  }, []);

  useEffect(() => {
    if (!appState?.recording.active) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [appState?.recording.active]);

  const recording = appState?.recording.active ?? null;
  const job = appState?.activeJob ?? null;
  const runningJob = isRunningJob(job);
  const action = recording
    ? 'stop-recording'
    : runningJob
      ? 'cancel-transcription'
      : null;
  const title = recording
    ? recordingTitle(recording)
    : job
      ? jobTitle(job)
      : 'Finishing';
  const source = recording?.sourceName ?? job?.sourceName ?? 'Sotto is finishing this action.';
  const timer = recording
    ? formatDuration(Math.max(0, now - new Date(recording.startedAt).getTime()))
    : null;
  const progress = job ? Math.round(Math.min(1, Math.max(0, job.progress)) * 100) : 0;

  const requestAction = (nextAction: ActivityAction): void => {
    if (!window.sotto || pendingAction) return;
    setError(null);
    setPendingAction(nextAction);
    void window.sotto
      .requestActivityAction(nextAction)
      .catch(() => setError('Sotto could not complete that request.'))
      .finally(() => setPendingAction(null));
  };

  return (
    <main className="activity-overlay" aria-live="polite">
      <div className="activity-overlay__header">
        <div className="activity-overlay__identity">
          <span className="activity-overlay__mark" aria-hidden="true">S</span>
          <span>
            <strong>Sotto</strong>
            <small>{title}</small>
          </span>
        </div>
        <span className="activity-overlay__indicator" aria-label="Active" />
      </div>

      <div className="activity-overlay__details">
        <span className="activity-overlay__source" title={source}>{source}</span>
        {timer ? (
          <span className="activity-overlay__timer">{timer}</span>
        ) : job ? (
          <span className="activity-overlay__progress">
            {job.progress > 0 ? `${progress}%` : 'Working…'}
          </span>
        ) : null}
      </div>

      <div className="activity-overlay__footer">
        <p>{error ?? (recording?.kind === 'dictation'
          ? 'Listening for dictation. Your target app stays focused.'
          : job?.message ?? 'Sotto is working on your recording.')}</p>
        {action ? (
          <button
            className="activity-overlay__action"
            disabled={pendingAction !== null}
            onClick={() => requestAction(action)}
            type="button"
          >
            {pendingAction ? <SpinnerIcon className="spinner" /> : action === 'stop-recording' ? <CancelIcon /> : <MicrophoneIcon />}
            {pendingAction === 'stop-recording'
              ? 'Stopping…'
              : pendingAction === 'cancel-transcription'
                ? 'Cancelling…'
                : action === 'stop-recording'
                  ? recording?.kind === 'dictation' ? 'Stop dictation' : 'Stop recording'
                  : 'Cancel transcription'}
          </button>
        ) : null}
      </div>
    </main>
  );
};
