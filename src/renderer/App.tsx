import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AppState,
  LiveRecordingSnapshot,
  SavedRecordingSummary,
  StartLiveRecordingResult,
  TranscriptDetail,
  TranscriptExportFormat,
  TranscriptSpeaker,
  TranscriptSummary,
  TranscriptionJobSnapshot,
} from '../shared/contracts';
import { clearSavedSpeakerDraft } from './speaker-drafts';
import { liveRecordingStartErrorMessage } from './live-recording-errors';
import { releaseAbandonedLiveRecordingStart } from './live-recording-start-cleanup';
import { isIndeterminateTranscriptionProgress } from './transcription-progress';
import {
  activeSegmentIndexAt,
  isPunctuationOnlyToken,
  PLAYBACK_JUMP_SECONDS,
  shouldIgnorePlaybackShortcut,
} from './playback';
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

const SpeakerEditor = ({
  speakers,
  onRename,
}: {
  speakers: TranscriptSpeaker[];
  onRename: (speakerId: string, label: string) => Promise<string | null>;
}) => {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="speaker-editor" aria-labelledby="speaker-editor-title">
      <div>
        <h2 id="speaker-editor-title">Speakers</h2>
        <p>These names apply to this transcript only.</p>
      </div>
      <div className="speaker-editor__list">
        {speakers.map((speaker) => (
          <form
            className="speaker-editor__row"
            key={speaker.id}
            onSubmit={(event) => {
              event.preventDefault();
              const label = drafts[speaker.id] ?? '';
              setSavingId(speaker.id);
              setError(null);
              void onRename(speaker.id, label)
                .then((reason) => {
                  setSavingId(null);
                  setError(reason);
                  if (!reason) {
                    setDrafts((current) =>
                      clearSavedSpeakerDraft(current, speaker.id, label),
                    );
                  }
                })
                .catch(() => {
                  setSavingId(null);
                  setError('Sotto could not save that speaker name.');
                });
            }}
          >
            <label htmlFor={`speaker-${speaker.id}`}>{speaker.label}</label>
            <input
              id={`speaker-${speaker.id}`}
              maxLength={100}
              onChange={(event) =>
                setDrafts((current) => ({
                  ...current,
                  [speaker.id]: event.target.value,
                }))
              }
              value={drafts[speaker.id] ?? speaker.label}
            />
            <button
              disabled={savingId === speaker.id || !(drafts[speaker.id] ?? '').trim()}
              type="submit"
            >
              {savingId === speaker.id ? 'Saving…' : 'Save'}
            </button>
          </form>
        ))}
      </div>
      {error ? <p className="speaker-editor__error" role="alert">{error}</p> : null}
    </section>
  );
};

const TranscriptView = ({
  transcript,
  loading,
  message,
  onBack,
  onDelete,
  onDeletePlayback,
  onExport,
  onExportRecording,
  onRenameSpeaker,
}: {
  transcript: TranscriptDetail | null;
  loading: boolean;
  message: string | null;
  onBack: () => void;
  onDelete: () => void;
  onDeletePlayback: () => void;
  onExport: (format: TranscriptExportFormat) => void;
  onExportRecording: () => void;
  onRenameSpeaker: (speakerId: string, label: string) => Promise<string | null>;
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [playbackRate, setPlaybackRate] = useState(1);
  const playbackAvailable = transcript?.playback.state === 'available';
  const activeSegmentIndex = transcript
    ? activeSegmentIndexAt(transcript.segments, currentTimeMs)
    : -1;

  const seekTo = useCallback((milliseconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const seconds = Math.max(0, milliseconds / 1_000);
    audio.currentTime = Number.isFinite(audio.duration)
      ? Math.min(seconds, audio.duration)
      : seconds;
    setCurrentTimeMs(audio.currentTime * 1_000);
  }, []);

  const jumpBy = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    seekTo((audio.currentTime + seconds) * 1_000);
  }, [seekTo]);

  const togglePlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().catch(() => {
        setPlaybackError(
          'Sotto could not play this saved audio. The file may be damaged or use an unsupported encoding.',
        );
      });
    } else {
      audio.pause();
    }
  }, []);

  useEffect(() => {
    setCurrentTimeMs(0);
    setPlaybackError(null);
  }, [transcript?.id]);

  useEffect(() => {
    if (!playbackAvailable) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        shouldIgnorePlaybackShortcut(event.target)
      ) {
        return;
      }
      if (event.code === 'Space' && !event.repeat) {
        event.preventDefault();
        togglePlayback();
      } else if (event.code === 'ArrowLeft') {
        event.preventDefault();
        jumpBy(-PLAYBACK_JUMP_SECONDS);
      } else if (event.code === 'ArrowRight') {
        event.preventDefault();
        jumpBy(PLAYBACK_JUMP_SECONDS);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [jumpBy, playbackAvailable, togglePlayback]);

  return (
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
          <button className="icon-button" onClick={() => onExport('docx')} type="button">
            <DownloadIcon />
            <span>Export DOCX</span>
          </button>
          <button className="icon-button" onClick={() => onExport('txt')} type="button">
            <DownloadIcon />
            <span>Export TXT</span>
          </button>
          <button className="icon-button icon-button--danger" onClick={onDelete} type="button">
            <TrashIcon />
            <span>Delete transcript</span>
          </button>
        </div>
      ) : null}
    </header>
    {message ? (
      <p className="transcript-message" role="alert">{message}</p>
    ) : null}
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
          {transcript.speakerAnalysis ? (
            <p className="engine-note">
              Speaker labels: {transcript.speakerAnalysis.engine.name}{' '}
              {transcript.speakerAnalysis.engine.version}
            </p>
          ) : (
            <p className="engine-note">No reliable speaker labels were found.</p>
          )}
        </header>
        <section className="playback" aria-labelledby="playback-title">
          <div className="playback__heading">
            <div>
              <h2 id="playback-title">Synchronized playback</h2>
              {transcript.playback.state === 'available' ? (
                <p>
                  {formatFileSize(transcript.playback.sizeBytes)} saved privately on this device
                </p>
              ) : (
                <p>Playback audio is not available for this transcript.</p>
              )}
            </div>
            {transcript.playback.state === 'available' ? (
              <button className="playback__delete" onClick={onDeletePlayback} type="button">
                Delete playback audio
              </button>
            ) : null}
          </div>
          {transcript.playback.state === 'available' ? (
            <>
              <audio
                controls
                key={transcript.playback.url}
                onError={() => setPlaybackError(
                  'Sotto could not decode this saved audio. The transcript is still safe.',
                )}
                onLoadedMetadata={(event) => {
                  event.currentTarget.playbackRate = playbackRate;
                  setPlaybackError(null);
                }}
                onTimeUpdate={(event) =>
                  setCurrentTimeMs(event.currentTarget.currentTime * 1_000)
                }
                preload="metadata"
                ref={audioRef}
                src={transcript.playback.url}
              >
                Your system does not support local audio playback.
              </audio>
              <div className="playback__controls">
                <button onClick={() => jumpBy(-PLAYBACK_JUMP_SECONDS)} type="button">
                  −{PLAYBACK_JUMP_SECONDS}s
                </button>
                <button onClick={() => jumpBy(PLAYBACK_JUMP_SECONDS)} type="button">
                  +{PLAYBACK_JUMP_SECONDS}s
                </button>
                <label>
                  Speed
                  <select
                    onChange={(event) => {
                      const rate = Number(event.target.value);
                      setPlaybackRate(rate);
                      if (audioRef.current) audioRef.current.playbackRate = rate;
                    }}
                    value={playbackRate}
                  >
                    {[0.75, 1, 1.25, 1.5, 2].map((rate) => (
                      <option key={rate} value={rate}>{rate}x</option>
                    ))}
                  </select>
                </label>
                <span>Space: play/pause · ←/→: jump 5 seconds</span>
              </div>
            </>
          ) : (
            <p className="playback__unavailable">
              It may have been deleted or moved by another tool, or this may be an older
              transcript created before Sotto retained playback audio. You can still read,
              rename speakers, export, or delete the transcript.
            </p>
          )}
          {playbackError ? <p className="playback__error" role="alert">{playbackError}</p> : null}
        </section>
        {transcript.speakerAnalysis?.speakers.length ? (
          <SpeakerEditor
            key={transcript.id}
            onRename={onRenameSpeaker}
            speakers={transcript.speakerAnalysis.speakers}
          />
        ) : null}
        <div className="segments" aria-label="Transcript text">
          {transcript.segments.length === 0 ? (
            <p className="no-speech">No speech was detected in this recording.</p>
          ) : (
            transcript.segments.map((segment, index) => {
              const speaker = transcript.speakerAnalysis?.speakers.find(
                (candidate) => candidate.id === segment.speakerId,
              );
              return (
              <div
                className={`segment${transcript.speakerAnalysis ? ' segment--with-speaker' : ''}${activeSegmentIndex === index ? ' segment--active' : ''}${playbackAvailable ? ' segment--seekable' : ''}`}
                key={`${segment.startMs}-${index}`}
                onClick={(event) => {
                  if (!playbackAvailable || (event.target as HTMLElement).closest('button')) return;
                  seekTo(segment.startMs);
                }}
              >
                <time>
                  {playbackAvailable ? (
                    <button onClick={() => seekTo(segment.startMs)} type="button">
                      {formatDuration(segment.startMs)}
                    </button>
                  ) : formatDuration(segment.startMs)}
                </time>
                {transcript.speakerAnalysis ? (
                  <span className={`segment__speaker${speaker ? '' : ' segment__speaker--unknown'}`}>
                    {speaker?.label ?? 'Unclear'}
                  </span>
                ) : null}
                <p>
                  {playbackAvailable && segment.words.length > 0
                    ? segment.words.map((word, wordIndex) => {
                        const key = `${word.startMs}-${word.endMs}-${wordIndex}`;
                        return word.text.trim().length === 0 || isPunctuationOnlyToken(word.text) ? (
                          <span className="transcript-word transcript-word--punctuation" key={key}>
                            {wordIndex === 0 ? word.text.trimStart() : word.text}
                          </span>
                        ) : (
                          <button
                            aria-label={`Seek to ${word.text.trim()} at ${formatDuration(word.startMs)}`}
                            className="transcript-word"
                            key={key}
                            onClick={(event) => {
                              event.stopPropagation();
                              seekTo(word.startMs);
                            }}
                            type="button"
                          >
                            {wordIndex === 0 ? word.text.trimStart() : word.text}
                          </button>
                        );
                      })
                    : segment.text}
                </p>
              </div>
              );
            })
          )}
        </div>
      </article>
    ) : (
      <div className="detail-loading">That transcript is no longer available.</div>
    )}
  </main>
  );
};

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
    setMessage(null);
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
  const recordingCapabilityState = appState?.recording.capability.state;
  const needsRecordingSetup = recordingCapabilityState === 'setup-required';
  const recordingElapsed = activeRecording
    ? Math.max(0, recordingTick - new Date(activeRecording.startedAt).getTime())
    : 0;
  const canImport =
    appState?.engine.state === 'ready' &&
    !running &&
    !activeRecording &&
    !isStartingRecording &&
    !isStoppingRecording &&
    !isSelecting;
  const canRecord =
    appState?.engine.state === 'ready' &&
    (recordingCapabilityState === 'ready' || needsRecordingSetup) &&
    !running &&
    !activeRecording &&
    !isStartingRecording &&
    !isStoppingRecording &&
    !isSelecting;
  const progress = useMemo(
    () => Math.round(Math.min(1, Math.max(0, appState?.activeJob?.progress ?? 0)) * 100),
    [appState?.activeJob?.progress],
  );
  const progressIsIndeterminate = isIndeterminateTranscriptionProgress(
    appState?.activeJob ?? null,
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
    let desktopStreamClaimed = false;
    let startRecording: Promise<StartLiveRecordingResult> | null = null;
    let startResultHandled = false;
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
      startRecording = window.sotto.startLiveRecording();
      const started = await withTimeout(
        startRecording,
        20_000,
        'Sotto timed out while opening the private recording file.',
      );
      startResultHandled = true;
      if (started.outcome === 'rejected') {
        setMessage(started.reason);
        return;
      }
      recordingId = started.recording.id;
      recordingIdRef.current = recordingId;

      const desktopStream = await desktopCapture;
      desktopStreamRef.current = desktopStream;
      desktopStreamClaimed = true;
      if (desktopStream.getAudioTracks().length === 0) {
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
        microphoneStreamRef.current = microphoneStream;
      } catch {
        setMessage(
          'Microphone access was not granted. Sotto will record Teams audio only for this meeting.',
        );
      }

      const context = new AudioContext();
      audioContextRef.current = context;
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
        liveRecordingStartErrorMessage(error, navigator.platform),
      );
    } finally {
      void releaseAbandonedLiveRecordingStart({
        cancelRecording: (lateRecordingId) =>
          withTimeout(
            window.sotto.cancelLiveRecording(lateRecordingId),
            5_000,
            'Sotto timed out while clearing the incomplete recording.',
          ),
        desktopCapture,
        desktopStreamClaimed,
        startRecording,
        startResultHandled,
      });
      setIsStartingRecording(false);
    }
  };

  const handleOpenRecordingSettings = async () => {
    if (!window.sotto) return;
    setMessage(null);
    const result = await window.sotto.openRecordingSettings();
    if (result.outcome === 'failed') setMessage(result.reason);
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

  const handleExport = async (format: TranscriptExportFormat) => {
    if (!window.sotto || !selectedId) return;
    setMessage(null);
    try {
      const result = await window.sotto.exportTranscript(selectedId, format);
      if (result.outcome === 'failed') setMessage(result.reason);
      if (result.outcome === 'not-found') {
        setMessage('That transcript is no longer available.');
      }
    } catch {
      setMessage(`Sotto could not export that ${format.toUpperCase()} file.`);
    }
  };

  const handleRenameSpeaker = async (
    speakerId: string,
    label: string,
  ): Promise<string | null> => {
    if (!window.sotto || !selectedId) return 'Sotto could not rename that speaker.';
    const result = await window.sotto.renameTranscriptSpeaker(
      selectedId,
      speakerId,
      label,
    );
    if (result.outcome === 'rejected') return result.reason;
    if (result.outcome === 'not-found') return 'That speaker is no longer available.';

    setTranscript((current) =>
      current?.speakerAnalysis
        ? {
            ...current,
            speakerAnalysis: {
              ...current.speakerAnalysis,
              speakers: current.speakerAnalysis.speakers.map((speaker) =>
                speaker.id === result.speaker.id ? result.speaker : speaker,
              ),
            },
          }
        : current,
    );
    return null;
  };

  const handleDelete = async () => {
    if (!window.sotto || !selectedId) return;
    const recordingNote = transcript?.recordingId
      ? ' The original recording will stay saved.'
      : transcript?.playback.state === 'available'
        ? ' Its retained playback audio will also be deleted.'
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

  const handleDeletePlayback = async () => {
    if (!window.sotto || !selectedId || transcript?.playback.state !== 'available') {
      return;
    }
    const description =
      transcript.playback.kind === 'live-recording'
        ? 'saved live recording'
        : 'retained playback audio';
    if (
      !window.confirm(
        `Delete this ${description}? The transcript will stay saved. This cannot be undone.`,
      )
    ) {
      return;
    }
    setMessage(null);
    const result = await window.sotto.deletePlayback(selectedId);
    if (result.outcome === 'rejected') {
      setMessage(result.reason);
    } else if (result.outcome === 'not-found') {
      setMessage('That playback audio is no longer available.');
      setTranscript((current) => current
        ? { ...current, playback: { state: 'unavailable', reason: 'missing' } }
        : current);
    } else {
      setTranscript((current) => current
        ? {
            ...current,
            recordingId:
              current.playback.state === 'available' &&
              current.playback.kind === 'live-recording'
                ? undefined
                : current.recordingId,
            playback: { state: 'unavailable', reason: 'missing' },
          }
        : current);
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
          message={message}
          onBack={() => {
            setMessage(null);
            setSelectedId(null);
          }}
          onDelete={() => void handleDelete()}
          onDeletePlayback={() => void handleDeletePlayback()}
          onExport={(format) => void handleExport(format)}
          onExportRecording={() => {
            if (transcript?.recordingId) void exportRecording(transcript.recordingId);
          }}
          onRenameSpeaker={handleRenameSpeaker}
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
                  <span>{progressIsIndeterminate ? 'Working…' : `${progress}%`}</span>
                </div>
                <div
                  className={`progress-track${progressIsIndeterminate ? ' progress-track--indeterminate' : ''}`}
                  aria-label="Transcription progress"
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={progressIsIndeterminate ? undefined : progress}
                  role="progressbar"
                >
                  <span style={progressIsIndeterminate ? undefined : { width: `${progress}%` }} />
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
              <span>{isStartingRecording ? 'Opening capture…' : activeRecording ? 'Stop recording' : needsRecordingSetup ? 'Set up live recording' : 'Record live meeting'}</span>
              <span className="button__status">{activeRecording ? formatDuration(recordingElapsed) : needsRecordingSetup ? 'One-time macOS approval' : 'System + mic'}</span>
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
              <div className="recording-permission">
                <p className="import-message import-message--notice">
                  {appState?.recording.capability.message ?? 'Checking live capture support…'}
                </p>
                {appState?.recording.capability.state === 'permission-required' ? (
                  <button
                    className="recording-permission__button"
                    onClick={() => void handleOpenRecordingSettings()}
                    type="button"
                  >
                    Open Screen & System Audio Settings
                  </button>
                ) : null}
              </div>
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
