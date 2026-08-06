import { useEffect, useState } from 'react';

import type {
  ActivityAction,
  AppState,
  LiveRecordingSnapshot,
  TranscriptionJobSnapshot,
} from '../shared/contracts';
import { CancelIcon, MicrophoneIcon, SpinnerIcon } from './icons';
import { formatDuration, isRunningJob, recordingElapsedMs } from './app-format';

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
  const recordingAction = recording
    ? recording.paused
      ? 'resume-recording'
      : 'pause-recording'
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
    ? formatDuration(recordingElapsedMs(recording, now))
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
        <span
          className={`activity-overlay__indicator${recording?.paused ? ' activity-overlay__indicator--paused' : ''}`}
          aria-label={recording?.paused ? 'Paused' : 'Active'}
        />
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
        <p>{error ?? (recording?.paused
          ? `Recording paused. ${recording.markers.length} bookmark${recording.markers.length === 1 ? '' : 's'} saved.`
          : recording?.kind === 'dictation'
            ? 'Listening for dictation. Your target app stays focused.'
            : job?.message ?? 'Sotto is working on your recording.')}</p>
        {recording ? (
          <div className="activity-overlay__actions">
            <button
              className="activity-overlay__action"
              disabled={pendingAction !== null}
              onClick={() => requestAction('add-marker')}
              type="button"
            >
              {pendingAction === 'add-marker' ? <SpinnerIcon className="spinner" /> : null}
              {pendingAction === 'add-marker' ? 'Saving…' : 'Mark moment'}
            </button>
            <button
              className="activity-overlay__action"
              disabled={pendingAction !== null}
              onClick={() => requestAction(recordingAction as ActivityAction)}
              type="button"
            >
              {pendingAction === 'pause-recording' || pendingAction === 'resume-recording'
                ? <SpinnerIcon className="spinner" />
                : <MicrophoneIcon />}
              {pendingAction === 'pause-recording'
                ? 'Pausing…'
                : pendingAction === 'resume-recording'
                  ? 'Resuming…'
                : recording.paused ? 'Resume' : 'Pause'}
            </button>
            <button
              className="activity-overlay__action"
              disabled={pendingAction !== null}
              onClick={() => requestAction('stop-recording')}
              type="button"
            >
              {pendingAction === 'stop-recording' ? <SpinnerIcon className="spinner" /> : <CancelIcon />}
              {pendingAction === 'stop-recording'
                ? 'Stopping…'
                : recording.kind === 'dictation' ? 'Stop dictation' : 'Stop recording'}
            </button>
          </div>
        ) : runningJob ? (
          <button
            className="activity-overlay__action"
            disabled={pendingAction !== null}
            onClick={() => requestAction('cancel-transcription')}
            type="button"
          >
            {pendingAction ? <SpinnerIcon className="spinner" /> : <CancelIcon />}
            {pendingAction === 'cancel-transcription' ? 'Cancelling…' : 'Cancel transcription'}
          </button>
        ) : null}
      </div>
    </main>
  );
};
