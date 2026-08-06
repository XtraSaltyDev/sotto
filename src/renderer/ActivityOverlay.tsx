import { useEffect, useState } from 'react';

import type {
  ActivityAction,
  AppState,
  TranscriptionJobSnapshot,
} from '../shared/contracts';
import { SpinnerIcon } from './icons';
import { isRunningJob, recordingElapsedMs } from './app-format';

export const formatActivityDuration = (durationMs: number): string => {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((part) => part.toString().padStart(2, '0'))
    .join(':');
};

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
    <ActivityOverlayContent
      appState={appState}
      error={error}
      now={now}
      onRequestAction={requestAction}
      pendingAction={pendingAction}
    />
  );
};

export const ActivityOverlayContent = ({
  appState,
  error,
  now,
  onRequestAction,
  pendingAction,
}: {
  appState: AppState | null;
  error: string | null;
  now: number;
  onRequestAction: (action: ActivityAction) => void;
  pendingAction: ActivityAction | null;
}) => {
  const recording = appState?.recording.active ?? null;
  const job = appState?.activeJob ?? null;
  const runningJob = isRunningJob(job);
  const pauseAction: ActivityAction | null = recording
    ? recording.paused
      ? 'resume-recording'
      : 'pause-recording'
    : null;
  const primaryAction: ActivityAction | null = recording
    ? 'stop-recording'
    : runningJob
      ? 'cancel-transcription'
      : null;
  const status = error
    ? 'Sotto needs attention'
    : recording
      ? recording.paused
        ? 'Recording paused'
        : recording.kind === 'dictation'
          ? 'Dictating…'
          : 'Recording…'
      : job
        ? `${jobTitle(job)}…`
        : 'Finishing…';
  const source = recording?.sourceName ?? job?.sourceName ?? 'Sotto activity';
  const detail = recording
    ? formatActivityDuration(recordingElapsedMs(recording, now))
    : job
      ? job.progress > 0
        ? `${Math.round(Math.min(1, Math.max(0, job.progress)) * 100)}%`
        : 'Working…'
      : 'Please wait';
  const primaryLabel = recording
    ? recording.kind === 'dictation'
      ? 'Stop dictation'
      : 'Stop recording'
    : 'Cancel transcription';

  return (
    <main
      className={`activity-overlay${recording?.paused ? ' activity-overlay--paused' : ''}${error ? ' activity-overlay--error' : ''}`}
      aria-label={`${status}. ${detail}. ${source}`}
      aria-live="polite"
    >
      {pauseAction ? (
        <button
          aria-label={recording?.paused ? 'Resume recording' : 'Pause recording'}
          className={`activity-overlay__record-control${recording?.paused ? ' activity-overlay__record-control--paused' : ''}`}
          disabled={pendingAction !== null}
          onClick={() => onRequestAction(pauseAction)}
          title={recording?.paused ? 'Resume recording' : 'Pause recording'}
          type="button"
        >
          {pendingAction === 'pause-recording' || pendingAction === 'resume-recording' ? (
            <SpinnerIcon className="spinner" />
          ) : (
            <span className="activity-overlay__record-dot" />
          )}
        </button>
      ) : (
        <span className="activity-overlay__record-control activity-overlay__record-control--working">
          <SpinnerIcon className="spinner" />
        </span>
      )}

      <span className="activity-overlay__divider" aria-hidden="true" />

      <div className="activity-overlay__center" title={source}>
        <span className="activity-overlay__status">
          <strong>{status}</strong>
          <span>{error ?? detail}</span>
        </span>
        <span className="activity-overlay__waveform" aria-hidden="true">
          <i /><i /><i /><i /><i />
        </span>
      </div>

      <span className="activity-overlay__divider" aria-hidden="true" />

      <button
        aria-label={primaryAction ? primaryLabel : 'Sotto is finishing'}
        className="activity-overlay__stop"
        disabled={primaryAction === null || pendingAction !== null}
        onClick={() => {
          if (primaryAction) onRequestAction(primaryAction);
        }}
        title={primaryAction ? primaryLabel : 'Sotto is finishing'}
        type="button"
      >
        {pendingAction === primaryAction && primaryAction !== null ? (
          <SpinnerIcon className="spinner" />
        ) : (
          <span aria-hidden="true" />
        )}
      </button>
    </main>
  );
};
