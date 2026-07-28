import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AppState,
  LiveRecordingSnapshot,
  SavedRecordingSummary,
  TranscriptDetail,
  TranscriptSummary,
  TranscriptionJobSnapshot,
} from '../shared/contracts';
import {
  ArrowLeftIcon,
  AudioFileIcon,
  BrandIcon,
  CancelIcon,
  DocumentIcon,
  DownloadIcon,
  FolderIcon,
  InboxIcon,
  LockIcon,
  MicrophoneIcon,
  SpinnerIcon,
  TrashIcon,
} from './icons';

const formatDuration = (durationMs: number): string => {
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

const formatDate = (value: string): string =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));

const formatFileSize = (bytes: number): string => {
  if (bytes < 1_024 * 1_024) return `${Math.max(1, Math.round(bytes / 1_024))} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(bytes < 10 * 1_024 * 1_024 ? 1 : 0)} MB`;
};

const withTimeout = async <T,>(
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

const isRunningJob = (job: TranscriptionJobSnapshot | null): boolean =>
  job !== null &&
  ['preparing', 'normalizing', 'transcribing', 'saving'].includes(job.stage);

const jobLabel = (job: TranscriptionJobSnapshot): string => {
  if (job.stage === 'normalizing') return 'Preparing audio';
  if (job.stage === 'transcribing') return 'Transcribing locally';
  if (job.stage === 'saving') return 'Saving transcript';
  if (job.stage === 'completed') return 'Transcript complete';
  if (job.stage === 'cancelled') return 'Transcription cancelled';
  if (job.stage === 'failed') return 'Could not transcribe recording';
  return 'Preparing recording';
};

const recordingLabel = (recording: LiveRecordingSnapshot | null): string =>
  recording ? 'Recording live meeting audio' : 'Record live meeting';

const savedRecordingLabel = (recording: SavedRecordingSummary): string => {
  if (recording.transcriptionState === 'completed') return 'Transcript ready';
  if (recording.transcriptionState === 'transcribing') return 'Transcribing';
  if (recording.transcriptionState === 'failed') return 'Transcription failed';
  if (recording.transcriptionState === 'cancelled') return 'Transcription cancelled';
  return 'Ready to transcribe';
};

const recordingMimeType = (): string | undefined => {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm'];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
};

const TranscriptList = ({
  transcripts,
  onOpen,
}: {
  transcripts: TranscriptSummary[];
  onOpen: (id: string) => void;
}) => (
  <section className="recent" id="recent" aria-labelledby="recent-title">
    <h2 id="recent-title">Recent</h2>
    {transcripts.length === 0 ? (
      <div className="empty-state">
        <InboxIcon />
        <h3>No transcripts yet</h3>
        <p>Import a meeting or recording. The finished transcript will appear here.</p>
      </div>
    ) : (
      <div className="transcript-list">
        {transcripts.map((transcript) => (
          <button
            className="transcript-row"
            key={transcript.id}
            onClick={() => onOpen(transcript.id)}
            type="button"
          >
            <DocumentIcon />
            <span className="transcript-row__body">
              <strong>{transcript.title}</strong>
              <span>{transcript.preview || 'No speech detected'}</span>
            </span>
            <span className="transcript-row__meta">
              <span>{formatDate(transcript.createdAt)}</span>
              <span>{formatDuration(transcript.durationMs)}</span>
            </span>
          </button>
        ))}
      </div>
    )}
  </section>
);

const SavedRecordingList = ({
  busyId,
  onDelete,
  onExport,
  onOpenTranscript,
  onRetry,
  recordings,
}: {
  busyId: string | null;
  onDelete: (recording: SavedRecordingSummary) => void;
  onExport: (recording: SavedRecordingSummary) => void;
  onOpenTranscript: (id: string) => void;
  onRetry: (recording: SavedRecordingSummary) => void;
  recordings: SavedRecordingSummary[];
}) => {
  if (recordings.length === 0) return null;

  return (
    <section
      className="saved-recordings"
      aria-labelledby="saved-recordings-title"
    >
      <div className="section-heading">
        <div>
          <h2 id="saved-recordings-title">Saved recordings</h2>
          <p>Original live WebM files kept privately on this device.</p>
        </div>
      </div>
      <div className="recording-list">
        {recordings.map((recording) => {
          const busy = busyId === recording.id;
          const canRetry = ['ready', 'failed', 'cancelled'].includes(
            recording.transcriptionState,
          );
          return (
            <article className="saved-recording-row" key={recording.id}>
              <AudioFileIcon />
              <div className="saved-recording-row__body">
                <strong>{recording.sourceName}</strong>
                <span>
                  {formatDate(recording.completedAt)} ·{' '}
                  {formatFileSize(recording.sizeBytes)}
                </span>
                <p>{recording.message}</p>
              </div>
              <div className="saved-recording-row__status">
                <span
                  className={`status-pill status-pill--${recording.transcriptionState}`}
                >
                  {savedRecordingLabel(recording)}
                </span>
                <div className="recording-actions">
                  {recording.transcriptId ? (
                    <button
                      disabled={busy}
                      onClick={() => onOpenTranscript(recording.transcriptId as string)}
                      type="button"
                    >
                      <DocumentIcon /> Open transcript
                    </button>
                  ) : null}
                  {canRetry ? (
                    <button
                      disabled={busy}
                      onClick={() => onRetry(recording)}
                      type="button"
                    >
                      {busy ? <SpinnerIcon className="spinner" /> : <MicrophoneIcon />}
                      Retry transcription
                    </button>
                  ) : null}
                  <button
                    disabled={busy}
                    onClick={() => onExport(recording)}
                    type="button"
                  >
                    <DownloadIcon /> Export recording
                  </button>
                  <button
                    className="recording-action--danger"
                    disabled={
                      busy || recording.transcriptionState === 'transcribing'
                    }
                    onClick={() => onDelete(recording)}
                    type="button"
                  >
                    <TrashIcon /> Delete recording
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
};

const TranscriptView = ({
  transcript,
  loading,
  onBack,
  onDelete,
  onDeleteRecording,
  onExport,
  onExportRecording,
}: {
  transcript: TranscriptDetail | null;
  loading: boolean;
  onBack: () => void;
  onDelete: () => void;
  onDeleteRecording: () => void;
  onExport: () => void;
  onExportRecording: () => void;
}) => (
  <main className="workspace">
    <header className="topbar topbar--detail">
      <button className="icon-button icon-button--back" onClick={onBack} type="button">
        <ArrowLeftIcon />
        <span>Transcripts</span>
      </button>
      {transcript ? (
        <div className="detail-actions">
          {transcript.recordingId ? (
            <button className="icon-button" onClick={onExportRecording} type="button">
              <DownloadIcon />
              <span>Export recording</span>
            </button>
          ) : null}
          <button className="icon-button" onClick={onExport} type="button">
            <DownloadIcon />
            <span>Export transcript</span>
          </button>
          {transcript.recordingId ? (
            <button
              className="icon-button icon-button--danger"
              onClick={onDeleteRecording}
              type="button"
            >
              <TrashIcon />
              <span>Delete recording</span>
            </button>
          ) : null}
          <button className="icon-button icon-button--danger" onClick={onDelete} type="button">
            <TrashIcon />
            <span>Delete transcript</span>
          </button>
        </div>
      ) : null}
    </header>
    {loading ? (
      <div className="detail-loading"><SpinnerIcon className="spinner" /> Loading transcript…</div>
    ) : transcript ? (
      <article className="transcript-detail">
        <header className="transcript-detail__header">
          <p className="eyebrow">Local transcript</p>
          <h1>{transcript.title}</h1>
          <p>
            {formatDate(transcript.completedAt)} · {formatDuration(transcript.durationMs)} ·{' '}
            {transcript.language.toUpperCase()}
          </p>
          <p className="engine-note">
            {transcript.engine.name} {transcript.engine.version} · {transcript.engine.model}
          </p>
        </header>
        <div className="segments" aria-label="Transcript text">
          {transcript.segments.length === 0 ? (
            <p className="no-speech">No speech was detected in this recording.</p>
          ) : (
            transcript.segments.map((segment, index) => (
              <div className="segment" key={`${segment.startMs}-${index}`}>
                <time>{formatDuration(segment.startMs)}</time>
                <p>{segment.text}</p>
              </div>
            ))
          )}
        </div>
      </article>
    ) : (
      <div className="detail-loading">That transcript is no longer available.</div>
    )}
  </main>
);

export const App = () => {
  const [appState, setAppState] = useState<AppState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptDetail | null>(null);
  const [isLoadingTranscript, setIsLoadingTranscript] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const [isStoppingRecording, setIsStoppingRecording] = useState(false);
  const [recordingActionId, setRecordingActionId] = useState<string | null>(null);
  const [recordingTick, setRecordingTick] = useState(() => Date.now());
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingStopPromiseRef = useRef<Promise<void> | null>(null);
  const recordingChunkQueueRef = useRef<Promise<void>>(Promise.resolve());
  const recordingChunkErrorRef = useRef<string | null>(null);
  const recordingIdRef = useRef<string | null>(null);
  const stoppingRecordingRef = useRef(false);
  const desktopStreamRef = useRef<MediaStream | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  const refresh = useCallback(async () => {
    if (!window.sotto) {
      setMessage('Sotto must run in its desktop window.');
      return;
    }

    try {
      setAppState(await window.sotto.getAppState());
    } catch {
      setMessage('Sotto could not load its local state.');
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (!window.sotto) return undefined;

    return window.sotto.onAppStateChanged((nextState) => setAppState(nextState));
  }, [refresh]);

  useEffect(() => {
    if (!appState?.recording.active) return undefined;
    setRecordingTick(Date.now());
    const timer = window.setInterval(() => setRecordingTick(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [appState?.recording.active]);

  useEffect(() => {
    if (!selectedId || !window.sotto) {
      setTranscript(null);
      return undefined;
    }

    let cancelled = false;
    setIsLoadingTranscript(true);
    window.sotto
      .getTranscript(selectedId)
      .then((detail) => {
        if (!cancelled) setTranscript(detail);
      })
      .catch(() => {
        if (!cancelled) setMessage('Sotto could not open that transcript.');
      })
      .finally(() => {
        if (!cancelled) setIsLoadingTranscript(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const running = isRunningJob(appState?.activeJob ?? null);
  const activeRecording = appState?.recording.active ?? null;
  const recordingElapsed = activeRecording
    ? Math.max(0, recordingTick - new Date(activeRecording.startedAt).getTime())
    : 0;
  const canImport =
    appState?.engine.state === 'ready' &&
    !running &&
    !activeRecording &&
    !isStartingRecording &&
    !isSelecting;
  const canRecord =
    appState?.engine.state === 'ready' &&
    appState.recording.capability.state === 'ready' &&
    !running &&
    !activeRecording &&
    !isStartingRecording &&
    !isSelecting;
  const progress = useMemo(
    () => Math.round(Math.min(1, Math.max(0, appState?.activeJob?.progress ?? 0)) * 100),
    [appState?.activeJob?.progress],
  );

  const cleanupCapture = async () => {
    mediaRecorderRef.current = null;
    desktopStreamRef.current?.getTracks().forEach((track) => track.stop());
    microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
    desktopStreamRef.current = null;
    microphoneStreamRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== 'closed') await context.close();
  };

  const handleStopLiveRecording = async () => {
    const recorder = mediaRecorderRef.current;
    const recordingId = recordingIdRef.current;
    if (
      !window.sotto ||
      !recorder ||
      !recordingId ||
      stoppingRecordingRef.current
    ) {
      return;
    }

    stoppingRecordingRef.current = true;
    setIsStoppingRecording(true);
    try {
      if (recorder.state !== 'inactive') recorder.stop();
      await withTimeout(
        recordingStopPromiseRef.current ?? Promise.resolve(),
        10_000,
        'Sotto timed out while closing the local audio encoder.',
      );
      await withTimeout(
        recordingChunkQueueRef.current,
        20_000,
        'Sotto timed out while saving the final recording data.',
      );
      if (recordingChunkErrorRef.current) {
        throw new Error(recordingChunkErrorRef.current);
      }

      await cleanupCapture();
      const result = await withTimeout(
        window.sotto.finishLiveRecording(recordingId),
        25_000,
        'Sotto timed out while finalizing the recording. Restart Sotto to check for a recovered saved recording.',
      );
      if (result.outcome === 'rejected') setMessage(result.reason);
      if (result.outcome === 'not-found') {
        setMessage('That live recording was already closed.');
      }
    } catch (error) {
      await withTimeout(
        window.sotto.cancelLiveRecording(recordingId),
        5_000,
        'Sotto timed out while clearing the incomplete recording.',
      ).catch(() => undefined);
      await cleanupCapture();
      setMessage(
        error instanceof Error
          ? error.message
          : 'Sotto could not finish the live recording.',
      );
    } finally {
      recordingIdRef.current = null;
      recordingStopPromiseRef.current = null;
      recordingChunkQueueRef.current = Promise.resolve();
      recordingChunkErrorRef.current = null;
      stoppingRecordingRef.current = false;
      setIsStoppingRecording(false);
    }
  };

  const handleStartLiveRecording = async () => {
    if (!window.sotto || !canRecord) return;
    setMessage(null);
    setIsStartingRecording(true);

    let recordingId: string | null = null;
    let desktopCapture: Promise<MediaStream> | null = null;
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error('This build cannot request desktop audio capture.');
      }

      // Start the display request synchronously from the button gesture. An
      // IPC round-trip before getDisplayMedia can consume the browser's
      // transient user activation and make the OS prompt fail.
      desktopCapture = navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: { frameRate: 1, height: 240, width: 320 },
      });
      const started = await withTimeout(
        window.sotto.startLiveRecording(),
        20_000,
        'Sotto timed out while opening the private recording file.',
      );
      if (started.outcome === 'rejected') {
        void desktopCapture
          .then((unusedStream) => {
            unusedStream.getTracks().forEach((track) => track.stop());
          })
          .catch(() => undefined);
        setMessage(started.reason);
        return;
      }
      recordingId = started.recording.id;
      recordingIdRef.current = recordingId;

      const desktopStream = await desktopCapture;
      if (desktopStream.getAudioTracks().length === 0) {
        desktopStream.getTracks().forEach((track) => track.stop());
        throw new Error(
          'Sotto did not receive Teams audio. Allow screen and system-audio capture, then try again.',
        );
      }

      let microphoneStream: MediaStream | null = null;
      try {
        microphoneStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
      } catch {
        setMessage(
          'Microphone access was not granted. Sotto will record Teams audio only for this meeting.',
        );
      }

      const context = new AudioContext();
      await context.resume();
      const destination = context.createMediaStreamDestination();
      context.createMediaStreamSource(desktopStream).connect(destination);
      if (microphoneStream?.getAudioTracks().length) {
        context.createMediaStreamSource(microphoneStream).connect(destination);
      }

      if (typeof MediaRecorder === 'undefined') {
        throw new Error('This build cannot encode a live recording.');
      }
      const mimeType = recordingMimeType();
      const recorder = mimeType
        ? new MediaRecorder(destination.stream, {
            audioBitsPerSecond: 96_000,
            mimeType,
          })
        : new MediaRecorder(destination.stream, { audioBitsPerSecond: 96_000 });

      recordingChunkQueueRef.current = Promise.resolve();
      recordingChunkErrorRef.current = null;
      recorder.ondataavailable = (event) => {
        if (
          !event.data.size ||
          !window.sotto ||
          !recordingId ||
          recordingChunkErrorRef.current
        ) {
          return;
        }
        const currentId = recordingId;
        const sendChunk = recordingChunkQueueRef.current.then(async () => {
          const result = await withTimeout(
            window.sotto.appendLiveRecordingChunk(
              currentId,
              await event.data.arrayBuffer(),
            ),
            20_000,
            'Sotto timed out while writing the live recording to disk.',
          );
          if (result.outcome === 'rejected') throw new Error(result.reason);
        });
        recordingChunkQueueRef.current = sendChunk.catch((error: unknown) => {
          recordingChunkErrorRef.current =
            error instanceof Error
              ? error.message
              : 'Sotto could not save the live recording.';
          if (recorder.state === 'recording') recorder.stop();
          queueMicrotask(() => void handleStopLiveRecording());
        });
      };
      recorder.onerror = () => {
        recordingChunkErrorRef.current = 'Sotto could not encode the live recording.';
        if (recorder.state === 'recording') recorder.stop();
        queueMicrotask(() => void handleStopLiveRecording());
      };
      recordingStopPromiseRef.current = new Promise<void>((resolve, reject) => {
        recorder.addEventListener('stop', () => resolve(), { once: true });
        recorder.addEventListener(
          'error',
          () => reject(new Error('Sotto could not encode the live recording.')),
          { once: true },
        );
      });

      desktopStream.getTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          if (mediaRecorderRef.current?.state === 'recording') {
            void handleStopLiveRecording();
          }
        });
      });

      desktopStreamRef.current = desktopStream;
      microphoneStreamRef.current = microphoneStream;
      audioContextRef.current = context;
      mediaRecorderRef.current = recorder;
      recorder.start(1_000);
    } catch (error) {
      if (recordingId && window.sotto) {
        await withTimeout(
          window.sotto.cancelLiveRecording(recordingId),
          5_000,
          'Sotto timed out while clearing the incomplete recording.',
        ).catch(() => undefined);
      }
      await cleanupCapture();
      recordingIdRef.current = null;
      setMessage(
        error instanceof Error
          ? error.message
          : 'Sotto could not start live meeting capture.',
      );
    } finally {
      setIsStartingRecording(false);
    }
  };

  const handleImport = async () => {
    if (!window.sotto || !canImport) return;
    setMessage(null);
    setIsSelecting(true);

    try {
      const result = await window.sotto.importMedia();
      if (result.outcome === 'rejected') setMessage(result.reason);
    } catch {
      setMessage('Sotto could not open the recording picker. Please try again.');
    } finally {
      setIsSelecting(false);
    }
  };

  const handleCancel = async () => {
    const jobId = appState?.activeJob?.id;
    if (window.sotto && jobId) await window.sotto.cancelTranscription(jobId);
  };

  const handleExport = async () => {
    if (!window.sotto || !selectedId) return;
    const result = await window.sotto.exportTranscript(selectedId);
    if (result.outcome === 'failed') setMessage(result.reason);
  };

  const handleDelete = async () => {
    if (!window.sotto || !selectedId) return;
    const recordingNote = transcript?.recordingId
      ? ' The original recording will stay saved.'
      : '';
    if (
      !window.confirm(
        `Delete this local transcript?${recordingNote} This cannot be undone.`,
      )
    ) {
      return;
    }

    const result = await window.sotto.deleteTranscript(selectedId);
    if (result.outcome === 'deleted') {
      setSelectedId(null);
      setTranscript(null);
    }
  };

  const retryRecording = async (recordingId: string) => {
    if (!window.sotto || recordingActionId) return;
    setMessage(null);
    setRecordingActionId(recordingId);
    try {
      const result = await window.sotto.retryRecording(recordingId);
      if (result.outcome === 'rejected') setMessage(result.reason);
      if (result.outcome === 'not-found') {
        setMessage('That saved recording is no longer available.');
      }
    } catch {
      setMessage('Sotto could not retry transcription for that recording.');
    } finally {
      setRecordingActionId(null);
    }
  };

  const exportRecording = async (recordingId: string) => {
    if (!window.sotto || recordingActionId) return;
    setMessage(null);
    setRecordingActionId(recordingId);
    try {
      const result = await window.sotto.exportRecording(recordingId);
      if (result.outcome === 'failed') setMessage(result.reason);
      if (result.outcome === 'not-found') {
        setMessage('That saved recording is no longer available.');
      }
    } catch {
      setMessage('Sotto could not open the recording export dialog.');
    } finally {
      setRecordingActionId(null);
    }
  };

  const deleteRecording = async (recordingId: string) => {
    if (!window.sotto || recordingActionId) return;
    if (
      !window.confirm(
        'Delete this saved original recording? Any transcript will be kept. This cannot be undone.',
      )
    ) {
      return;
    }

    setMessage(null);
    setRecordingActionId(recordingId);
    try {
      const result = await window.sotto.deleteRecording(recordingId);
      if (result.outcome === 'rejected') setMessage(result.reason);
      if (result.outcome === 'not-found') {
        setMessage('That saved recording is no longer available.');
      }
      if (result.outcome === 'deleted') {
        setTranscript((current) =>
          current?.recordingId === recordingId
            ? { ...current, recordingId: undefined }
            : current,
        );
      }
    } catch {
      setMessage('Sotto could not delete that saved recording.');
    } finally {
      setRecordingActionId(null);
    }
  };

  if (selectedId) {
    return (
      <div className="app-shell">
        <Sidebar />
        <TranscriptView
          loading={isLoadingTranscript}
          onBack={() => setSelectedId(null)}
          onDelete={() => void handleDelete()}
          onDeleteRecording={() => {
            if (transcript?.recordingId) void deleteRecording(transcript.recordingId);
          }}
          onExport={() => void handleExport()}
          onExportRecording={() => {
            if (transcript?.recordingId) void exportRecording(transcript.recordingId);
          }}
          transcript={transcript}
        />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="workspace">
        <header className="topbar"><h1>Transcripts</h1></header>
        <section className="intro" aria-labelledby="intro-title">
          <div className="intro__copy">
            <p className="eyebrow">Private, on-device transcription</p>
            <h2 id="intro-title">Your words, kept close.</h2>
            <p>Import a meeting, interview, lecture, or video. Sotto processes it entirely on this device.</p>
          </div>

          <div className="import-panel" aria-live="polite">
            <AudioFileIcon className="import-panel__icon" />
            {activeRecording ? (
              <div className="recording-card" aria-live="polite">
                <div className="recording-card__heading">
                  <span><strong>{recordingLabel(activeRecording)}</strong><small>{activeRecording.sourceName}</small></span>
                  <span className="recording-card__dot" aria-label="Recording" />
                </div>
                <div className="recording-card__timer">{formatDuration(recordingElapsed)}</div>
                <p>Teams/system audio and microphone are kept on this device.</p>
                <button className="text-button" disabled={isStoppingRecording} onClick={() => void handleStopLiveRecording()} type="button">
                  <CancelIcon /> {isStoppingRecording ? 'Stopping and preparing transcript…' : 'Stop recording'}
                </button>
              </div>
            ) : appState?.activeJob ? (
              <div className={`job-card job-card--${appState.activeJob.stage}`}>
                <div className="job-card__heading">
                  <span><strong>{jobLabel(appState.activeJob)}</strong><small>{appState.activeJob.sourceName}</small></span>
                  <span>{progress}%</span>
                </div>
                <div className="progress-track" aria-label="Transcription progress" aria-valuemax={100} aria-valuemin={0} aria-valuenow={progress} role="progressbar">
                  <span style={{ width: `${progress}%` }} />
                </div>
                <p>{appState.activeJob.message}</p>
                {running ? (
                  <button className="text-button" onClick={() => void handleCancel()} type="button"><CancelIcon /> Cancel</button>
                ) : appState.activeJob.recordingId &&
                  ['failed', 'cancelled'].includes(appState.activeJob.stage) ? (
                  <button
                    className="text-button"
                    disabled={recordingActionId === appState.activeJob.recordingId}
                    onClick={() =>
                      void retryRecording(appState.activeJob?.recordingId as string)
                    }
                    type="button"
                  >
                    {recordingActionId === appState.activeJob.recordingId ? (
                      <SpinnerIcon className="spinner" />
                    ) : (
                      <MicrophoneIcon />
                    )}{' '}
                    Retry transcription
                  </button>
                ) : null}
              </div>
            ) : (
              <p className="import-panel__prompt">Choose a recording with an audio track.</p>
            )}

            <button className="button button--primary" disabled={!canImport} onClick={() => void handleImport()} type="button">
              {isSelecting ? <SpinnerIcon className="spinner" /> : <FolderIcon />}
              <span>{isSelecting ? 'Opening…' : running ? 'Transcription in progress' : 'Import Recording'}</span>
            </button>
            <button
              className={`button button--record${activeRecording ? ' button--recording' : ''}`}
              disabled={activeRecording ? isStoppingRecording : !canRecord}
              onClick={() => void (activeRecording ? handleStopLiveRecording() : handleStartLiveRecording())}
              type="button"
            >
              {isStartingRecording || isStoppingRecording ? <SpinnerIcon className="spinner" /> : <MicrophoneIcon />}
              <span>{isStartingRecording ? 'Opening capture…' : activeRecording ? 'Stop recording' : 'Record live meeting'}</span>
              <span className="button__status">{activeRecording ? formatDuration(recordingElapsed) : 'System + mic'}</span>
            </button>

            {appState?.engine.state !== 'ready' ? (
              <p className="import-message import-message--error" role="alert">
                {appState?.engine.message ?? 'Checking the local transcription engine…'}
              </p>
            ) : (
              <p className="import-message import-message--notice">
                Local engine ready · {appState.engine.modelName}
              </p>
            )}
            {appState?.recording.capability.state !== 'ready' ? (
              <p className="import-message import-message--notice">
                {appState?.recording.capability.message ?? 'Checking live capture support…'}
              </p>
            ) : null}
            {appState?.recording.storageMessage ? (
              <p className="import-message import-message--error" role="alert">
                {appState.recording.storageMessage}
              </p>
            ) : null}
            {message ? <p className="import-message import-message--error" role="alert">{message}</p> : null}
          </div>
        </section>
        <SavedRecordingList
          busyId={recordingActionId}
          onDelete={(recording) => void deleteRecording(recording.id)}
          onExport={(recording) => void exportRecording(recording.id)}
          onOpenTranscript={setSelectedId}
          onRetry={(recording) => void retryRecording(recording.id)}
          recordings={appState?.recordings ?? []}
        />
        <TranscriptList onOpen={setSelectedId} transcripts={appState?.transcripts ?? []} />
      </main>
    </div>
  );
};

const Sidebar = () => (
  <aside className="sidebar" aria-label="Sotto navigation">
    <div className="brand"><BrandIcon className="brand__mark" /><span>Sotto</span></div>
    <nav className="navigation" aria-label="Primary">
      <a className="navigation__item navigation__item--active" href="#recent"><DocumentIcon /><span>Transcripts</span></a>
    </nav>
    <div className="privacy-note"><LockIcon /><span>Media and transcripts stay on this device.</span></div>
  </aside>
);
