import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type {
  AppState,
  ExpectedSpeakerCount,
  LiveRecordingSnapshot,
  LocalAiConnectionSummary,
  LocalAiMeetingSummary,
  MeetingSummary,
  RecordingKind,
  SavedRecordingSummary,
  StartLiveRecordingResult,
  TranscriptDetail,
  TranscriptCopyKind,
  TranscriptExportFormat,
  TranscriptLibraryResult,
  TranscriptSpeaker,
  TranscriptSummary,
  TranscriptionJobSnapshot,
} from '../shared/contracts';
import {
  isExpectedSpeakerCount,
  MAX_EXPECTED_SPEAKER_COUNT,
  MAX_TRANSCRIPT_LIBRARY_QUERY_CHARACTERS,
  MIN_EXPECTED_SPEAKER_COUNT,
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
  adjacentSearchResult,
  matchingTranscriptSegmentIndexes,
} from './transcript-search';
import {
  createTranscriptLibraryQuery,
  parseTranscriptTagDraft,
  type TranscriptLibraryDateRange,
} from './transcript-library';
import { mergeMeetingLibraryItems } from './meeting-library';
import {
  ArrowLeftIcon,
  AudioFileIcon,
  BrandIcon,
  CancelIcon,
  CopyIcon,
  DocumentIcon,
  DownloadIcon,
  FolderIcon,
  InboxIcon,
  LockIcon,
  MicrophoneIcon,
  ModelIcon,
  SpinnerIcon,
  TrashIcon,
} from './icons';
import { LocalAiSettings } from './LocalAiSettings';
import {
  TRANSCRIPT_COPY_OPTIONS,
  TRANSCRIPT_EXPORT_OPTIONS,
  transcriptCopySuccessMessage,
  transcriptExportFailureLabel,
} from './transcript-output-actions';

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
  recording?.kind === 'dictation'
    ? 'Recording dictation'
    : recording
      ? 'Recording live meeting audio'
      : 'Record live meeting';

const dictationShortcutLabel = (): string =>
  /Mac|iPhone|iPad/iu.test(navigator.platform)
    ? '⌘⇧D · mic only'
    : 'Ctrl+Shift+D · mic only';

const EXPECTED_SPEAKER_OPTIONS = Array.from(
  {
    length:
      MAX_EXPECTED_SPEAKER_COUNT - MIN_EXPECTED_SPEAKER_COUNT + 1,
  },
  (_, index) => MIN_EXPECTED_SPEAKER_COUNT + index,
);

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

interface TranscriptLibraryViewState {
  query: string;
  dateRange: TranscriptLibraryDateRange;
  speaker: string;
  tag: string;
}

type AppPage = 'transcripts' | 'local-ai';

const MeetingLibrary = ({
  busyId,
  recordings,
  transcripts,
  onDeleteRecording,
  onDeleteTranscript,
  onExportRecording,
  onOpen,
  onRetryRecording,
  onViewStateChange,
  viewState,
}: {
  busyId: string | null;
  recordings: SavedRecordingSummary[];
  transcripts: TranscriptSummary[];
  onDeleteRecording: (recording: SavedRecordingSummary) => void;
  onDeleteTranscript: (transcript: TranscriptSummary) => void;
  onExportRecording: (recording: SavedRecordingSummary) => void;
  onOpen: (id: string) => void;
  onRetryRecording: (recording: SavedRecordingSummary) => void;
  onViewStateChange: (
    update: (current: TranscriptLibraryViewState) => TranscriptLibraryViewState,
  ) => void;
  viewState: TranscriptLibraryViewState;
}) => {
  const { query, dateRange, speaker, tag } = viewState;
  const [result, setResult] = useState<TranscriptLibraryResult>({
    transcripts,
    availableSpeakers: [],
    availableTags: [],
  });
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const deferredQuery = useDeferredValue(query);
  const transcriptRevision = useMemo(
    () =>
      transcripts
        .map((transcript) =>
          [
            transcript.id,
            transcript.title,
            transcript.preview,
            ...transcript.tags,
          ].join('\u0001'),
        )
        .join('\u0002'),
    [transcripts],
  );

  useEffect(() => {
    if (!window.sotto) {
      setResult((current) => ({ ...current, transcripts }));
      return undefined;
    }
    let cancelled = false;
    setIsSearching(true);
    setSearchError(null);
    window.sotto
      .searchTranscriptLibrary(
        createTranscriptLibraryQuery({
          dateRange,
          speaker,
          tag,
          text: deferredQuery,
        }),
      )
      .then((nextResult) => {
        if (cancelled) return;
        setResult(nextResult);
        if (
          speaker &&
          !nextResult.availableSpeakers.some(
            (candidate) =>
              candidate.toLocaleLowerCase() === speaker.toLocaleLowerCase(),
          )
        ) {
          onViewStateChange((current) => ({ ...current, speaker: '' }));
        }
        if (
          tag &&
          !nextResult.availableTags.some(
            (candidate) =>
              candidate.toLocaleLowerCase() === tag.toLocaleLowerCase(),
          )
        ) {
          onViewStateChange((current) => ({ ...current, tag: '' }));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSearchError('Sotto could not search the local transcript library.');
        }
      })
      .finally(() => {
        if (!cancelled) setIsSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    dateRange,
    deferredQuery,
    onViewStateChange,
    speaker,
    tag,
    transcriptRevision,
    transcripts,
  ]);

  useEffect(() => {
    const focusLibrarySearch = (event: KeyboardEvent) => {
      if (
        event.key.toLocaleLowerCase() === 'f' &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey
      ) {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', focusLibrarySearch);
    return () => window.removeEventListener('keydown', focusLibrarySearch);
  }, []);

  const hasFilters =
    query.trim().length > 0 ||
    dateRange !== 'all' ||
    speaker.length > 0 ||
    tag.length > 0;
  const resultTranscriptIds = useMemo(
    () => new Set(result.transcripts.map((candidate) => candidate.id)),
    [result.transcripts],
  );
  const visibleRecordings = useMemo(
    () => hasFilters
      ? recordings.filter(
          (recording) =>
            recording.transcriptId &&
            resultTranscriptIds.has(recording.transcriptId),
        )
      : recordings,
    [hasFilters, recordings, resultTranscriptIds],
  );
  const meetings = useMemo(
    () => mergeMeetingLibraryItems(result.transcripts, visibleRecordings),
    [result.transcripts, visibleRecordings],
  );
  const totalMeetingCount = useMemo(
    () => mergeMeetingLibraryItems(transcripts, recordings).length,
    [recordings, transcripts],
  );

  return (
    <section
      className="transcript-library"
      id="transcript-library"
      aria-labelledby="library-title"
    >
      <div className="section-heading">
        <div>
          <h2 id="library-title">Meeting Library</h2>
          <p>Transcripts and original recordings, together in one place.</p>
        </div>
        <span aria-live="polite" className="library-count">
          {isSearching
            ? 'Searching…'
            : `${meetings.length} ${meetings.length === 1 ? 'meeting' : 'meetings'}`}
        </span>
      </div>
      {transcripts.length > 0 ? (
        <div className="library-tools" role="search">
          <div className="library-search">
            <label htmlFor="library-search">Search transcripts</label>
            <input
              autoComplete="off"
              id="library-search"
              maxLength={MAX_TRANSCRIPT_LIBRARY_QUERY_CHARACTERS}
              onChange={(event) =>
                onViewStateChange((current) => ({
                  ...current,
                  query: event.target.value,
                }))
              }
              placeholder="Titles, words, speakers, summaries, or tags"
              ref={searchInputRef}
              type="search"
              value={query}
            />
          </div>
          <label>
            Date
            <select
              onChange={(event) =>
                onViewStateChange((current) => ({
                  ...current,
                  dateRange: event.target.value as TranscriptLibraryDateRange,
                }))
              }
              value={dateRange}
            >
              <option value="all">Any time</option>
              <option value="today">Today</option>
              <option value="7-days">Last 7 days</option>
              <option value="30-days">Last 30 days</option>
              <option value="this-year">This year</option>
            </select>
          </label>
          <label>
            Speaker
            <select
              disabled={result.availableSpeakers.length === 0}
              onChange={(event) =>
                onViewStateChange((current) => ({
                  ...current,
                  speaker: event.target.value,
                }))
              }
              value={speaker}
            >
              <option value="">Any speaker</option>
              {result.availableSpeakers.map((label) => (
                <option key={label} value={label}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            Tag
            <select
              disabled={result.availableTags.length === 0}
              onChange={(event) =>
                onViewStateChange((current) => ({
                  ...current,
                  tag: event.target.value,
                }))
              }
              value={tag}
            >
              <option value="">Any tag</option>
              {result.availableTags.map((label) => (
                <option key={label} value={label}>{label}</option>
              ))}
            </select>
          </label>
          <button
            className="library-clear"
            disabled={!hasFilters}
            onClick={() => {
              onViewStateChange(() => ({
                query: '',
                dateRange: 'all',
                speaker: '',
                tag: '',
              }));
              searchInputRef.current?.focus();
            }}
            type="button"
          >
            Clear
          </button>
        </div>
      ) : null}
      {searchError ? <p className="library-error" role="alert">{searchError}</p> : null}
      {totalMeetingCount === 0 ? (
        <div className="empty-state">
          <InboxIcon />
          <h3>No meetings yet</h3>
          <p>Import a file or record a meeting. It will appear here when saved.</p>
        </div>
      ) : meetings.length === 0 ? (
        <div className="empty-state empty-state--compact">
          <InboxIcon />
          <h3>No matching meetings</h3>
          <p>Try a different word, date, speaker, or tag.</p>
        </div>
      ) : (
        <div className="meeting-list" aria-label="Meeting search results">
          {meetings.map(({ key, recording, transcript }) => {
            const busy = recording ? busyId === recording.id : false;
            const canRetry = recording
              ? ['ready', 'failed', 'cancelled'].includes(
                  recording.transcriptionState,
                )
              : false;
            const title = transcript?.title ?? recording?.sourceName ?? 'Untitled meeting';
            const date = transcript?.createdAt ?? recording?.completedAt ?? '';
            const detail = transcript
              ? formatDuration(transcript.durationMs)
              : recording
                ? formatFileSize(recording.sizeBytes)
                : '';
            return (
              <article className="meeting-row" key={key}>
                <span className="meeting-row__icon">
                  {transcript ? <DocumentIcon /> : <AudioFileIcon />}
                </span>
                {transcript ? (
                  <button
                    aria-label={`Open ${title}`}
                    className="meeting-row__open"
                    data-transcript-id={transcript.id}
                    onClick={() => onOpen(transcript.id)}
                    type="button"
                  >
                    <span className="meeting-row__body">
                      <strong>{title}</strong>
                      <span>{transcript.preview || 'No speech detected'}</span>
                      {transcript.tags.length ? (
                        <span className="tag-list" aria-label={`Tags: ${transcript.tags.join(', ')}`}>
                          {transcript.tags.map((transcriptTag) => (
                            <span className="tag" key={transcriptTag}>{transcriptTag}</span>
                          ))}
                        </span>
                      ) : null}
                    </span>
                  </button>
                ) : (
                  <div className="meeting-row__open meeting-row__open--static">
                    <span className="meeting-row__body">
                      <strong>{title}</strong>
                      <span>{recording?.message}</span>
                    </span>
                  </div>
                )}
                <div className="meeting-row__meta">
                  <span>{formatDate(date)}</span>
                  <span>{detail}</span>
                  <span className="meeting-row__capabilities">
                    {transcript ? <span>Transcript ready</span> : null}
                    {recording ? <span>Audio retained</span> : null}
                  </span>
                  {recording && recording.transcriptionState !== 'completed' ? (
                    <span className={`status-pill status-pill--${recording.transcriptionState}`}>
                      {savedRecordingLabel(recording)}
                    </span>
                  ) : null}
                </div>
                <details className="meeting-row__menu output-menu">
                  <summary aria-label={`More actions for ${title}`}>More</summary>
                  <div className="output-menu__panel meeting-row__menu-panel">
                    {transcript ? (
                      <button
                        onClick={(event) => {
                          closeOutputMenu(event.currentTarget);
                          onOpen(transcript.id);
                        }}
                        type="button"
                      >
                        Open transcript
                      </button>
                    ) : null}
                    {recording && canRetry ? (
                      <button
                        disabled={busy}
                        onClick={(event) => {
                          closeOutputMenu(event.currentTarget);
                          onRetryRecording(recording);
                        }}
                        type="button"
                      >
                        Retry transcription
                      </button>
                    ) : null}
                    {recording ? (
                      <button
                        disabled={busy}
                        onClick={(event) => {
                          closeOutputMenu(event.currentTarget);
                          onExportRecording(recording);
                        }}
                        type="button"
                      >
                        Export original recording
                      </button>
                    ) : null}
                    {recording ? (
                      <button
                        className="meeting-row__danger"
                        disabled={busy || recording.transcriptionState === 'transcribing'}
                        onClick={(event) => {
                          closeOutputMenu(event.currentTarget);
                          onDeleteRecording(recording);
                        }}
                        type="button"
                      >
                        Delete saved recording
                      </button>
                    ) : null}
                    {transcript ? (
                      <button
                        className="meeting-row__danger"
                        onClick={(event) => {
                          closeOutputMenu(event.currentTarget);
                          onDeleteTranscript(transcript);
                        }}
                        type="button"
                      >
                        Delete transcript
                      </button>
                    ) : null}
                  </div>
                </details>
              </article>
            );
          })}
        </div>
      )}
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

const TranscriptMetadataEditor = ({
  onUpdate,
  tags,
  title,
}: {
  onUpdate: (metadata: {
    title?: string;
    tags?: string[];
  }) => Promise<string | null>;
  tags: string[];
  title: string;
}) => {
  const [titleDraft, setTitleDraft] = useState(title);
  const [tagDraft, setTagDraft] = useState(tags.join(', '));
  const [saving, setSaving] = useState<'title' | 'tags' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTitleDraft(title);
  }, [title]);

  useEffect(() => {
    setTagDraft(tags.join(', '));
  }, [tags]);

  return (
    <section
      className="transcript-metadata"
      aria-labelledby="transcript-information-title"
    >
      <div>
        <h2 id="transcript-information-title">Transcript information</h2>
        <p>Titles and tags stay with this local transcript.</p>
      </div>
      <div className="transcript-metadata__forms">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setSaving('title');
            setError(null);
            void onUpdate({ title: titleDraft })
              .then((reason) => {
                setSaving(null);
                setError(reason);
              })
              .catch(() => {
                setSaving(null);
                setError('Sotto could not save that transcript title.');
              });
          }}
        >
          <label htmlFor="transcript-title">Title</label>
          <div>
            <input
              id="transcript-title"
              maxLength={300}
              onChange={(event) => setTitleDraft(event.target.value)}
              value={titleDraft}
            />
            <button
              disabled={
                saving !== null ||
                !titleDraft.trim() ||
                titleDraft.trim() === title
              }
              type="submit"
            >
              {saving === 'title' ? 'Saving…' : 'Save title'}
            </button>
          </div>
        </form>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = parseTranscriptTagDraft(tagDraft);
            if (!parsed.ok) {
              setError(parsed.reason);
              return;
            }
            setSaving('tags');
            setError(null);
            void onUpdate({ tags: parsed.tags })
              .then((reason) => {
                setSaving(null);
                setError(reason);
              })
              .catch(() => {
                setSaving(null);
                setError('Sotto could not save those transcript tags.');
              });
          }}
        >
          <label htmlFor="transcript-tags">Tags</label>
          <div>
            <input
              aria-describedby="transcript-tags-help"
              id="transcript-tags"
              onChange={(event) => setTagDraft(event.target.value)}
              placeholder="Client, planning, follow up"
              value={tagDraft}
            />
            <button disabled={saving !== null} type="submit">
              {saving === 'tags' ? 'Saving…' : 'Save tags'}
            </button>
          </div>
          <p id="transcript-tags-help">
            Separate tags with commas. Use tags to filter the library.
          </p>
        </form>
        {error ? (
          <p className="transcript-metadata__error" role="alert">{error}</p>
        ) : null}
      </div>
    </section>
  );
};

const MeetingSummaryView = ({
  connection,
  error,
  generating,
  localAiSummary,
  onGenerate,
  onOpenLocalAi,
  onSeek,
  playbackAvailable,
  speakers,
  summary,
}: {
  connection: LocalAiConnectionSummary | null;
  error: string | null;
  generating: boolean;
  localAiSummary: LocalAiMeetingSummary | null;
  onGenerate: () => void;
  onOpenLocalAi: () => void;
  onSeek: (milliseconds: number) => void;
  playbackAvailable: boolean;
  speakers: TranscriptSpeaker[];
  summary: MeetingSummary;
}) => {
  const [source, setSource] = useState<'sotto' | 'local-ai'>(
    localAiSummary ? 'local-ai' : 'sotto',
  );
  useEffect(() => {
    if (localAiSummary) setSource('local-ai');
  }, [localAiSummary?.generatedAt]);
  const showingLocalAi = source === 'local-ai' && localAiSummary !== null;
  const selectedSummary = showingLocalAi ? localAiSummary.summary : summary;
  const speakerLabels = new Map(speakers.map((speaker) => [speaker.id, speaker.label]));
  const renderItems = (
    title: string,
    items: MeetingSummary['keyPoints'],
    emptyText: string,
  ) => (
    <section className="meeting-summary__group">
      <h3>{title}</h3>
      {items.length ? (
        <ul>
          {items.map((item, index) => (
            <li key={`${item.startMs}-${index}-${item.text}`}>
              <div>
                {playbackAvailable ? (
                  <button onClick={() => onSeek(item.startMs)} type="button">
                    {formatDuration(item.startMs)}
                  </button>
                ) : (
                  <time>{formatDuration(item.startMs)}</time>
                )}
                {item.speakerId && speakerLabels.get(item.speakerId) ? (
                  <span>{speakerLabels.get(item.speakerId)}</span>
                ) : null}
              </div>
              <p>{item.text}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="meeting-summary__empty">{emptyText}</p>
      )}
    </section>
  );

  return (
    <section className="meeting-summary" aria-labelledby="meeting-summary-title">
      <header>
        <div>
          <p className="eyebrow">
            {showingLocalAi ? 'Local AI draft' : 'Sotto draft'}
          </p>
          <h2 id="meeting-summary-title">Meeting summary</h2>
        </div>
        <p>
          {showingLocalAi
            ? `Generated on this device with ${localAiSummary.model}. Review against the linked timestamps.`
            : 'Generated by Sotto from explicit transcript language. Review against the linked timestamps.'}
        </p>
      </header>
      <div className={`meeting-summary__upgrade${showingLocalAi ? ' meeting-summary__upgrade--active' : ''}`}>
        <div>
          <strong>
            {showingLocalAi
              ? 'Higher-quality Local AI summary'
              : 'Sotto summary is always available'}
          </strong>
          <p>
            {showingLocalAi
              ? 'The model considered the meeting in context. Sotto still anchors every item to the original transcript.'
              : 'Sotto can find Key Points, Decisions, and Action Items on its own. For stronger context and more natural results, connect a local model.'}
          </p>
          {error ? <p className="meeting-summary__error" role="alert">{error}</p> : null}
        </div>
        <div className="meeting-summary__upgrade-actions">
          {localAiSummary ? (
            <div className="meeting-summary__source" aria-label="Summary source">
              <button
                aria-pressed={!showingLocalAi}
                onClick={() => setSource('sotto')}
                type="button"
              >
                Sotto
              </button>
              <button
                aria-pressed={showingLocalAi}
                onClick={() => setSource('local-ai')}
                type="button"
              >
                Local AI
              </button>
            </div>
          ) : null}
          {connection?.configured ? (
            <button
              className="meeting-summary__generate"
              disabled={generating}
              onClick={onGenerate}
              type="button"
            >
              {generating ? (
                <><SpinnerIcon className="spinner" /> Improving summary…</>
              ) : localAiSummary ? (
                'Regenerate with Local AI'
              ) : (
                'Improve with Local AI'
              )}
            </button>
          ) : (
            <button
              className="meeting-summary__generate"
              disabled={connection === null}
              onClick={onOpenLocalAi}
              type="button"
            >
              {connection === null ? 'Checking Local AI…' : 'Connect a local model'}
            </button>
          )}
        </div>
      </div>
      <p className="meeting-summary__overview">{selectedSummary.overview}</p>
      <div className="meeting-summary__groups">
        {renderItems('Key points', selectedSummary.keyPoints, 'No key points were found.')}
        {renderItems('Decisions', selectedSummary.decisions, 'No clear decision language was found.')}
        {renderItems('Action items', selectedSummary.actionItems, 'No clear action-item language was found.')}
      </div>
    </section>
  );
};

const closeOutputMenu = (target: HTMLElement): void => {
  target.closest('details')?.removeAttribute('open');
};

export const TranscriptOutputMenus = ({
  hasRecording,
  onCopy,
  onExport,
  onExportRecording,
}: {
  hasRecording: boolean;
  onCopy: (kind: TranscriptCopyKind) => void;
  onExport: (format: TranscriptExportFormat) => void;
  onExportRecording: () => void;
}) => (
  <>
    <details className="output-menu">
      <summary className="icon-button" aria-label="Open transcript export options">
        <DownloadIcon />
        <span>Export</span>
      </summary>
      <div className="output-menu__panel" aria-label="Transcript export options">
        {hasRecording ? (
          <button
            onClick={(event) => {
              closeOutputMenu(event.currentTarget);
              onExportRecording();
            }}
            type="button"
          >
            Original recording
          </button>
        ) : null}
        {TRANSCRIPT_EXPORT_OPTIONS.map((option) => (
          <button
            key={option.format}
            onClick={(event) => {
              closeOutputMenu(event.currentTarget);
              onExport(option.format);
            }}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
    </details>
    <details className="output-menu">
      <summary className="icon-button" aria-label="Open meeting copy options">
        <CopyIcon />
        <span>Copy</span>
      </summary>
      <div className="output-menu__panel" aria-label="Meeting copy options">
        {TRANSCRIPT_COPY_OPTIONS.map((option) => (
          <button
            key={option.kind}
            onClick={(event) => {
              closeOutputMenu(event.currentTarget);
              onCopy(option.kind);
            }}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
    </details>
  </>
);

const TranscriptView = ({
  localAiConnection,
  localAiError,
  localAiGenerating,
  transcript,
  loading,
  message,
  onBack,
  onDelete,
  onDeletePlayback,
  onCopy,
  onExport,
  onExportRecording,
  onGenerateLocalAiSummary,
  onOpenLocalAi,
  onRenameSpeaker,
  onUpdateMetadata,
  onUpdateSegment,
}: {
  localAiConnection: LocalAiConnectionSummary | null;
  localAiError: string | null;
  localAiGenerating: boolean;
  transcript: TranscriptDetail | null;
  loading: boolean;
  message: string | null;
  onBack: () => void;
  onDelete: () => void;
  onDeletePlayback: () => void;
  onCopy: (kind: TranscriptCopyKind) => void;
  onExport: (format: TranscriptExportFormat) => void;
  onExportRecording: () => void;
  onGenerateLocalAiSummary: () => void;
  onOpenLocalAi: () => void;
  onRenameSpeaker: (speakerId: string, label: string) => Promise<string | null>;
  onUpdateMetadata: (metadata: {
    title?: string;
    tags?: string[];
  }) => Promise<string | null>;
  onUpdateSegment: (segmentIndex: number, text: string) => Promise<string | null>;
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const segmentRefs = useRef(new Map<number, HTMLDivElement>());
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResultIndex, setSearchResultIndex] = useState(-1);
  const [editingSegmentIndex, setEditingSegmentIndex] = useState<number | null>(null);
  const [segmentDraft, setSegmentDraft] = useState('');
  const [savingSegmentIndex, setSavingSegmentIndex] = useState<number | null>(null);
  const [segmentEditError, setSegmentEditError] = useState<string | null>(null);
  const [detailMode, setDetailMode] = useState<'summary' | 'transcript'>('summary');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const playbackAvailable = transcript?.playback.state === 'available';
  const activeSegmentIndex = transcript
    ? activeSegmentIndexAt(transcript.segments, currentTimeMs)
    : -1;
  const searchMatches = useMemo(
    () => matchingTranscriptSegmentIndexes(
      transcript?.segments ?? [],
      deferredSearchQuery,
    ),
    [deferredSearchQuery, transcript?.segments],
  );
  const searchMatchSet = useMemo(() => new Set(searchMatches), [searchMatches]);
  const selectedSearchSegmentIndex =
    searchResultIndex >= 0 ? (searchMatches[searchResultIndex] ?? -1) : -1;

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
    setSearchQuery('');
    setSearchResultIndex(-1);
    setEditingSegmentIndex(null);
    setSegmentDraft('');
    setSegmentEditError(null);
    setDetailMode('summary');
  }, [transcript?.id]);

  useEffect(() => {
    setSearchResultIndex(-1);
  }, [deferredSearchQuery, searchQuery, transcript?.segments]);

  const moveToSearchResult = useCallback((direction: 1 | -1) => {
    const nextResultIndex = adjacentSearchResult(
      searchResultIndex,
      searchMatches.length,
      direction,
    );
    if (nextResultIndex < 0) return;
    const segmentIndex = searchMatches[nextResultIndex];
    setSearchResultIndex(nextResultIndex);
    segmentRefs.current.get(segmentIndex)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
    const segment = transcript?.segments[segmentIndex];
    if (segment && playbackAvailable) seekTo(segment.startMs);
  }, [playbackAvailable, searchMatches, searchResultIndex, seekTo, transcript?.segments]);

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
          <TranscriptOutputMenus
            hasRecording={Boolean(transcript.recordingId)}
            onCopy={onCopy}
            onExport={onExport}
            onExportRecording={onExportRecording}
          />
          <button className="icon-button icon-button--danger" onClick={onDelete} type="button">
            <TrashIcon />
            <span>Delete transcript</span>
          </button>
        </div>
      ) : null}
    </header>
    {message ? (
      <p className="transcript-message" role="status" aria-live="polite">{message}</p>
    ) : null}
    {loading ? (
      <div className="detail-loading"><SpinnerIcon className="spinner" /> Loading transcript…</div>
    ) : transcript ? (
      <article className="transcript-detail">
        <header className="transcript-detail__header">
          <p className="eyebrow">Local transcript</p>
          <h1>{transcript.title}</h1>
          {transcript.tags.length ? (
            <div className="tag-list tag-list--detail" aria-label={`Tags: ${transcript.tags.join(', ')}`}>
              {transcript.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}
            </div>
          ) : null}
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
        <details className="transcript-secondary">
          <summary>
            <span>Meeting details</span>
            <span>Edit title and tags</span>
          </summary>
          <TranscriptMetadataEditor
            key={transcript.id}
            onUpdate={onUpdateMetadata}
            tags={transcript.tags}
            title={transcript.title}
          />
        </details>
        <div className="transcript-mode-tabs" aria-label="Meeting view">
          <button
            aria-pressed={detailMode === 'summary'}
            onClick={() => setDetailMode('summary')}
            type="button"
          >
            Summary
          </button>
          <button
            aria-pressed={detailMode === 'transcript'}
            onClick={() => setDetailMode('transcript')}
            type="button"
          >
            Transcript
          </button>
        </div>
        {detailMode === 'summary' && transcript.meetingSummary ? (
          <MeetingSummaryView
            connection={localAiConnection}
            error={localAiError}
            generating={localAiGenerating}
            localAiSummary={transcript.localAiMeetingSummary}
            onGenerate={onGenerateLocalAiSummary}
            onOpenLocalAi={onOpenLocalAi}
            onSeek={seekTo}
            playbackAvailable={playbackAvailable}
            speakers={transcript.speakerAnalysis?.speakers ?? []}
            summary={transcript.meetingSummary}
          />
        ) : detailMode === 'summary' ? (
          <section className="summary-unavailable">
            <h2>Summary unavailable</h2>
            <p>This transcript does not contain enough speech to create a meeting summary.</p>
          </section>
        ) : null}
        {detailMode === 'transcript' ? (
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
        ) : null}
        {detailMode === 'transcript' ? (
          <>
        {transcript.speakerAnalysis?.speakers.length ? (
          <details className="transcript-secondary transcript-secondary--speakers">
            <summary>
              <span>Speakers</span>
              <span>{transcript.speakerAnalysis.speakers.length} identified</span>
            </summary>
          <SpeakerEditor
            key={transcript.id}
            onRename={onRenameSpeaker}
            speakers={transcript.speakerAnalysis.speakers}
          />
          </details>
        ) : null}
        <section className="transcript-find" aria-labelledby="transcript-find-title">
          <div>
            <h2 id="transcript-find-title">Find in transcript</h2>
            <p>Search this transcript and jump between matching segments.</p>
          </div>
          <form
            className="transcript-find__form"
            onSubmit={(event) => {
              event.preventDefault();
              moveToSearchResult(1);
            }}
          >
            <label className="visually-hidden" htmlFor="transcript-search">
              Find text in this transcript
            </label>
            <input
              autoComplete="off"
              aria-controls="transcript-segments"
              id="transcript-search"
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search transcript"
              type="search"
              value={searchQuery}
            />
            <span aria-live="polite" className="transcript-find__status">
              {searchQuery.trim().length === 0
                ? 'Enter a word or phrase'
                : searchMatches.length === 0
                  ? 'No matching segments'
                  : searchResultIndex >= 0
                    ? `${searchResultIndex + 1} of ${searchMatches.length}`
                    : `${searchMatches.length} matching ${searchMatches.length === 1 ? 'segment' : 'segments'}`}
            </span>
            <button
              aria-label="Previous match"
              disabled={searchMatches.length === 0}
              onClick={() => moveToSearchResult(-1)}
              type="button"
            >
              Previous
            </button>
            <button
              aria-label="Next match"
              disabled={searchMatches.length === 0}
              onClick={() => moveToSearchResult(1)}
              type="button"
            >
              Next
            </button>
          </form>
        </section>
        <div className="segments" id="transcript-segments" aria-label="Transcript text">
          {transcript.segments.length === 0 ? (
            <p className="no-speech">No speech was detected in this recording.</p>
          ) : (
            transcript.segments.map((segment, index) => {
              const speaker = transcript.speakerAnalysis?.speakers.find(
                (candidate) => candidate.id === segment.speakerId,
              );
              const isSearchMatch = searchMatchSet.has(index);
              const isEditing = editingSegmentIndex === index;
              return (
              <div
                aria-current={selectedSearchSegmentIndex === index ? 'true' : undefined}
                className={`segment${transcript.speakerAnalysis ? ' segment--with-speaker' : ''}${activeSegmentIndex === index ? ' segment--active' : ''}${playbackAvailable && !isEditing ? ' segment--seekable' : ''}${isSearchMatch ? ' segment--search-match' : ''}${selectedSearchSegmentIndex === index ? ' segment--search-current' : ''}${isEditing ? ' segment--editing' : ''}`}
                key={`${segment.startMs}-${index}`}
                onClick={(event) => {
                  if (
                    !playbackAvailable ||
                    isEditing ||
                    (event.target as HTMLElement).closest('button, input, textarea, select, a')
                  ) return;
                  seekTo(segment.startMs);
                }}
                ref={(element) => {
                  if (element) segmentRefs.current.set(index, element);
                  else segmentRefs.current.delete(index);
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
                <div className="segment__content">
                  {isEditing ? (
                    <form
                      className="segment-editor"
                      onSubmit={(event) => {
                        event.preventDefault();
                        setSavingSegmentIndex(index);
                        setSegmentEditError(null);
                        void onUpdateSegment(index, segmentDraft)
                          .then((reason) => {
                            setSavingSegmentIndex(null);
                            setSegmentEditError(reason);
                            if (!reason) {
                              setEditingSegmentIndex(null);
                              setSegmentDraft('');
                            }
                          })
                          .catch(() => {
                            setSavingSegmentIndex(null);
                            setSegmentEditError(
                              'Sotto could not save that transcript correction.',
                            );
                          });
                      }}
                    >
                      <label htmlFor={`segment-text-${index}`}>
                        Correct transcript text at {formatDuration(segment.startMs)}
                      </label>
                      <textarea
                        autoFocus
                        disabled={savingSegmentIndex === index}
                        id={`segment-text-${index}`}
                        maxLength={100_000}
                        onChange={(event) => setSegmentDraft(event.target.value)}
                        rows={Math.max(3, Math.min(8, Math.ceil(segmentDraft.length / 72)))}
                        value={segmentDraft}
                      />
                      <p>
                        Timing and speaker stay attached. Correcting text removes old
                        word-level links for this segment.
                      </p>
                      <div className="segment-editor__actions">
                        <button
                          disabled={
                            savingSegmentIndex === index ||
                            segmentDraft.trim().length === 0 ||
                            segmentDraft.trim() === segment.text
                          }
                          type="submit"
                        >
                          {savingSegmentIndex === index ? 'Saving…' : 'Save correction'}
                        </button>
                        <button
                          disabled={savingSegmentIndex === index}
                          onClick={() => {
                            setEditingSegmentIndex(null);
                            setSegmentDraft('');
                            setSegmentEditError(null);
                          }}
                          type="button"
                        >
                          Cancel
                        </button>
                      </div>
                      {segmentEditError ? (
                        <p className="segment-editor__error" role="alert">
                          {segmentEditError}
                        </p>
                      ) : null}
                    </form>
                  ) : (
                    <>
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
                      <button
                        className="segment__edit"
                        onClick={() => {
                          setEditingSegmentIndex(index);
                          setSegmentDraft(segment.text);
                          setSegmentEditError(null);
                          if (playbackAvailable) seekTo(segment.startMs);
                        }}
                        type="button"
                      >
                        Edit segment
                      </button>
                    </>
                  )}
                </div>
              </div>
              );
            })
          )}
        </div>
          </>
        ) : null}
      </article>
    ) : (
      <div className="detail-loading">That transcript is no longer available.</div>
    )}
  </main>
  );
};

export const App = () => {
  const [currentPage, setCurrentPage] = useState<AppPage>('transcripts');
  const [appState, setAppState] = useState<AppState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptDetail | null>(null);
  const [isLoadingTranscript, setIsLoadingTranscript] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const [isStoppingRecording, setIsStoppingRecording] = useState(false);
  const [isRepairingPermissions, setIsRepairingPermissions] = useState(false);
  const [localAiConnection, setLocalAiConnection] =
    useState<LocalAiConnectionSummary | null>(null);
  const [localAiGenerating, setLocalAiGenerating] = useState(false);
  const [localAiError, setLocalAiError] = useState<string | null>(null);
  const [expectedSpeakerCount, setExpectedSpeakerCount] =
    useState<ExpectedSpeakerCount>(null);
  const [recordingActionId, setRecordingActionId] = useState<string | null>(null);
  const [recordingTick, setRecordingTick] = useState(() => Date.now());
  const [libraryViewState, setLibraryViewState] =
    useState<TranscriptLibraryViewState>({
      query: '',
      dateRange: 'all',
      speaker: '',
      tag: '',
    });
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingStopPromiseRef = useRef<Promise<void> | null>(null);
  const recordingChunkQueueRef = useRef<Promise<void>>(Promise.resolve());
  const recordingChunkErrorRef = useRef<string | null>(null);
  const recordingIdRef = useRef<string | null>(null);
  const recordingExpectedSpeakerCountRef =
    useRef<ExpectedSpeakerCount>(null);
  const pendingDictationInsertionRef = useRef<string | null>(null);
  const returnFocusTranscriptIdRef = useRef<string | null>(null);
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
    const job = appState?.activeJob;
    const pendingRecordingId = pendingDictationInsertionRef.current;
    if (
      !window.sotto ||
      !job ||
      !pendingRecordingId ||
      job.recordingId !== pendingRecordingId ||
      !['completed', 'failed', 'cancelled'].includes(job.stage)
    ) {
      return;
    }

    pendingDictationInsertionRef.current = null;
    if (job.stage !== 'completed' || !job.transcriptId) return;

    void window.sotto
      .insertDictationText(job.transcriptId)
      .then((result) => {
        if (result.outcome === 'inserted') {
          setMessage('Dictation inserted at the cursor.');
        } else if (result.outcome === 'copied' || result.outcome === 'failed') {
          setMessage(result.reason);
        } else {
          setMessage('The dictation transcript could not be found for insertion.');
        }
      })
      .catch(() => {
        setMessage('Sotto could not insert the dictation. Open Sotto to copy the saved transcript.');
      });
  }, [
    appState?.activeJob?.recordingId,
    appState?.activeJob?.stage,
    appState?.activeJob?.transcriptId,
  ]);

  useEffect(() => {
    if (!selectedId || !window.sotto) {
      setTranscript(null);
      setLocalAiConnection(null);
      setLocalAiError(null);
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

  useEffect(() => {
    if (!selectedId || currentPage !== 'transcripts' || !window.sotto) {
      return undefined;
    }
    let cancelled = false;
    setLocalAiConnection(null);
    window.sotto
      .getLocalAiConnection()
      .then((connection) => {
        if (!cancelled) setLocalAiConnection(connection);
      })
      .catch(() => {
        if (!cancelled) {
          setLocalAiConnection({
            configured: false,
            baseUrl: '',
            selectedModel: null,
            hasApiKey: false,
            verifiedAt: null,
          });
          setLocalAiError('Sotto could not check the Local AI connection.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [currentPage, selectedId]);

  useEffect(() => {
    const transcriptId = returnFocusTranscriptIdRef.current;
    if (selectedId || !transcriptId) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLButtonElement>(
        `[data-transcript-id="${transcriptId}"]`,
      );
      if (target) {
        target.focus();
        returnFocusTranscriptIdRef.current = null;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [appState?.transcripts, selectedId]);

  const openTranscript = useCallback((transcriptId: string) => {
    returnFocusTranscriptIdRef.current = transcriptId;
    setSelectedId(transcriptId);
  }, []);

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
  const canDictate =
    appState?.engine.state === 'ready' &&
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
        window.sotto.finishLiveRecording(
          recordingId,
          recordingExpectedSpeakerCountRef.current,
        ),
        25_000,
        'Sotto timed out while finalizing the recording. Restart Sotto to check for a recovered saved recording.',
      );
      if (result.outcome !== 'started' && pendingDictationInsertionRef.current === recordingId) {
        pendingDictationInsertionRef.current = null;
      }
      if (result.outcome === 'rejected') setMessage(result.reason);
      if (result.outcome === 'not-found') {
        setMessage('That live recording was already closed.');
      }
    } catch (error) {
      if (pendingDictationInsertionRef.current === recordingId) {
        pendingDictationInsertionRef.current = null;
      }
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
      recordingExpectedSpeakerCountRef.current = null;
      recordingStopPromiseRef.current = null;
      recordingChunkQueueRef.current = Promise.resolve();
      recordingChunkErrorRef.current = null;
      stoppingRecordingRef.current = false;
      setIsStoppingRecording(false);
    }
  };

  const handleStartRecording = async (kind: RecordingKind) => {
    if (
      !window.sotto ||
      (kind === 'meeting' ? !canRecord : !canDictate)
    ) return;
    setMessage(null);
    setIsStartingRecording(true);

    let recordingId: string | null = null;
    let desktopCapture: Promise<MediaStream> | null = null;
    let desktopStreamClaimed = false;
    let startRecording: Promise<StartLiveRecordingResult> | null = null;
    let startResultHandled = false;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('This build cannot request microphone capture.');
      }

      if (kind === 'meeting') {
        if (!navigator.mediaDevices.getDisplayMedia) {
          throw new Error('This build cannot request desktop audio capture.');
        }
        // Start the display request synchronously from the button gesture. An
        // IPC round-trip before getDisplayMedia can consume the browser's
        // transient user activation and make the OS prompt fail.
        desktopCapture = navigator.mediaDevices.getDisplayMedia({
          audio: true,
          video: { frameRate: 1, height: 240, width: 320 },
        });
      }
      startRecording = window.sotto.startLiveRecording(kind);
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
      recordingExpectedSpeakerCountRef.current =
        kind === 'dictation' ? 1 : expectedSpeakerCount;
      if (kind === 'dictation') {
        pendingDictationInsertionRef.current = recordingId;
      }

      let desktopStream: MediaStream | null = null;
      if (desktopCapture) {
        desktopStream = await desktopCapture;
        desktopStreamRef.current = desktopStream;
        desktopStreamClaimed = true;
        if (desktopStream.getAudioTracks().length === 0) {
          throw new Error(
            'Sotto did not receive Teams audio. Allow screen and system-audio capture, then try again.',
          );
        }
      }

      let microphoneStream: MediaStream | null = null;
      try {
        microphoneStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
        microphoneStreamRef.current = microphoneStream;
      } catch {
        if (kind === 'dictation') {
          throw new Error(
            'Microphone access is required for dictation. Allow it in system settings, then try again.',
          );
        }
        setMessage('Microphone access was not granted. Sotto will record Teams audio only for this meeting.');
      }

      const context = new AudioContext();
      audioContextRef.current = context;
      await context.resume();
      const destination = context.createMediaStreamDestination();
      if (desktopStream?.getAudioTracks().length) {
        context.createMediaStreamSource(desktopStream).connect(destination);
      }
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

      desktopStream?.getTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          if (mediaRecorderRef.current?.state === 'recording') {
            void handleStopLiveRecording();
          }
        });
      });
      mediaRecorderRef.current = recorder;
      recorder.start(1_000);
      if (kind === 'dictation') {
        await window.sotto.hideForDictation().catch(() => undefined);
      }
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
      recordingExpectedSpeakerCountRef.current = null;
      if (pendingDictationInsertionRef.current === recordingId) {
        pendingDictationInsertionRef.current = null;
      }
      setMessage(
        kind === 'dictation' && error instanceof Error
          ? error.message
          : liveRecordingStartErrorMessage(error, navigator.platform),
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

  useEffect(() => {
    if (!window.sotto) return undefined;
    return window.sotto.onDictationShortcut(() => {
      if (activeRecording?.kind === 'dictation') {
        void handleStopLiveRecording();
      } else if (activeRecording) {
        setMessage('Finish the live meeting recording before starting dictation.');
      } else if (canDictate) {
        void handleStartRecording('dictation');
      } else if (running) {
        setMessage('Wait for the current transcription to finish before starting dictation.');
      } else if (appState?.engine.state !== 'ready') {
        setMessage(
          appState?.engine.message ??
          'The local transcription engine must be ready before starting dictation.',
        );
      } else {
        setMessage('Sotto is busy. Finish the current action before starting dictation.');
      }
    });
  }, [activeRecording, appState?.engine.message, appState?.engine.state, canDictate, running]);

  const handleOpenRecordingSettings = async () => {
    if (!window.sotto) return;
    setMessage(null);
    const result = await window.sotto.openRecordingSettings();
    if (result.outcome === 'failed') setMessage(result.reason);
  };

  const handleRepairRecordingPermissions = async () => {
    if (!window.sotto || isRepairingPermissions) return;
    setMessage(null);
    setIsRepairingPermissions(true);
    try {
      const result = await window.sotto.requestRecordingPermissions();
      if (result.outcome === 'failed') {
        setMessage(result.reason);
        setIsRepairingPermissions(false);
      } else if (result.outcome === 'settings-opened') {
        setMessage('macOS did not show its approval prompt. Your existing entry was left untouched; System Settings is open as a fallback.');
        setIsRepairingPermissions(false);
      } else {
        setMessage('Access was approved. Sotto is reopening…');
      }
    } catch {
      setMessage('Sotto could not request macOS recording permission.');
      setIsRepairingPermissions(false);
    }
  };

  const handleImport = async () => {
    if (!window.sotto || !canImport) return;
    setMessage(null);
    setIsSelecting(true);

    try {
      const result = await window.sotto.importMedia(expectedSpeakerCount);
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
      if (result.outcome === 'saved') {
        setMessage(`${result.fileName} was saved.`);
      }
    } catch {
      setMessage(
        `Sotto could not export ${transcriptExportFailureLabel(format)}.`,
      );
    }
  };

  const handleCopyOutput = async (kind: TranscriptCopyKind) => {
    if (!window.sotto || !selectedId) return;
    setMessage(null);
    try {
      const result = await window.sotto.copyTranscriptOutput(selectedId, kind);
      if (result.outcome === 'copied') {
        setMessage(transcriptCopySuccessMessage(kind));
      } else if (result.outcome === 'not-found') {
        setMessage('That transcript is no longer available.');
      } else {
        setMessage(result.reason);
      }
    } catch {
      setMessage('Sotto could not copy that meeting output.');
    }
  };

  const handleGenerateLocalAiSummary = async () => {
    if (!window.sotto || !selectedId || localAiGenerating) return;
    setLocalAiError(null);
    setLocalAiGenerating(true);
    try {
      const result = await window.sotto.generateLocalAiMeetingSummary(selectedId);
      if (result.outcome === 'generated') {
        setTranscript((current) => current
          ? {
              ...current,
              localAiMeetingSummary: result.localAiMeetingSummary,
            }
          : current);
      } else if (result.outcome === 'not-found') {
        setLocalAiError('That transcript is no longer available.');
      } else {
        setLocalAiError(result.reason);
      }
    } catch {
      setLocalAiError('Sotto could not improve this summary with Local AI.');
    } finally {
      setLocalAiGenerating(false);
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
            localAiMeetingSummary: null,
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

  const handleUpdateMetadata = async (metadata: {
    title?: string;
    tags?: string[];
  }): Promise<string | null> => {
    if (!window.sotto || !selectedId) {
      return 'Sotto could not save that transcript information.';
    }
    const result = await window.sotto.updateTranscriptMetadata(
      selectedId,
      metadata,
    );
    if (result.outcome === 'rejected') return result.reason;
    if (result.outcome === 'not-found') {
      return 'That transcript is no longer available.';
    }
    setTranscript((current) =>
      current
        ? {
            ...current,
            title: result.title,
            tags: result.tags,
          }
        : current,
    );
    return null;
  };

  const handleUpdateSegment = async (
    segmentIndex: number,
    text: string,
  ): Promise<string | null> => {
    if (!window.sotto || !selectedId) {
      return 'Sotto could not save that transcript correction.';
    }
    const result = await window.sotto.updateTranscriptSegment(
      selectedId,
      segmentIndex,
      text,
    );
    if (result.outcome === 'rejected') return result.reason;
    if (result.outcome === 'not-found') {
      return 'That transcript segment is no longer available.';
    }

    setTranscript((current) => current
      ? {
          ...current,
          meetingSummary: result.meetingSummary,
          localAiMeetingSummary: result.localAiMeetingSummary,
          preview: result.preview,
          text: result.text,
          segments: current.segments.map((segment, index) =>
            index === segmentIndex ? result.segment : segment,
          ),
        }
      : current);
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
      returnFocusTranscriptIdRef.current = null;
      setSelectedId(null);
      setTranscript(null);
    }
  };

  const deleteTranscriptFromLibrary = async (
    transcriptSummary: TranscriptSummary,
  ) => {
    if (!window.sotto) return;
    const linkedRecording = appState?.recordings.some(
      (recording) => recording.transcriptId === transcriptSummary.id,
    );
    const recordingNote = linkedRecording
      ? ' The original recording will stay saved and can be transcribed again.'
      : '';
    if (
      !window.confirm(
        `Delete “${transcriptSummary.title}”?${recordingNote} This cannot be undone.`,
      )
    ) {
      return;
    }

    setMessage(null);
    try {
      const result = await window.sotto.deleteTranscript(transcriptSummary.id);
      if (result.outcome === 'not-found') {
        setMessage('That transcript is no longer available.');
      }
    } catch {
      setMessage('Sotto could not delete that transcript.');
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
      const result = await window.sotto.retryRecording(
        recordingId,
        expectedSpeakerCount,
      );
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

  if (currentPage === 'local-ai') {
    return (
      <div className="app-shell">
        <Sidebar currentPage={currentPage} onNavigate={setCurrentPage} />
        <LocalAiSettings />
      </div>
    );
  }

  if (selectedId) {
    return (
      <div className="app-shell">
        <Sidebar currentPage={currentPage} onNavigate={setCurrentPage} />
        <TranscriptView
          localAiConnection={localAiConnection}
          localAiError={localAiError}
          localAiGenerating={localAiGenerating}
          loading={isLoadingTranscript}
          message={message}
          onBack={() => {
            setMessage(null);
            setSelectedId(null);
          }}
          onDelete={() => void handleDelete()}
          onDeletePlayback={() => void handleDeletePlayback()}
          onCopy={(kind) => void handleCopyOutput(kind)}
          onExport={(format) => void handleExport(format)}
          onExportRecording={() => {
            if (transcript?.recordingId) void exportRecording(transcript.recordingId);
          }}
          onGenerateLocalAiSummary={() => void handleGenerateLocalAiSummary()}
          onOpenLocalAi={() => setCurrentPage('local-ai')}
          onRenameSpeaker={handleRenameSpeaker}
          onUpdateMetadata={handleUpdateMetadata}
          onUpdateSegment={handleUpdateSegment}
          transcript={transcript}
        />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar currentPage={currentPage} onNavigate={setCurrentPage} />
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
                <p>
                  {activeRecording.kind === 'dictation'
                    ? 'Microphone audio is kept on this device and transcribed when you stop.'
                    : 'Teams/system audio and microphone are kept on this device.'}
                </p>
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

            {!activeRecording && !running ? (
              <label className="speaker-count-control">
                <span>
                  <strong>Expected speakers</strong>
                  <small>A known count prevents extra speaker labels.</small>
                </span>
                <select
                  disabled={isSelecting || isStartingRecording || isStoppingRecording}
                  onChange={(event) => {
                    const nextValue =
                      event.target.value === 'auto'
                        ? null
                        : Number(event.target.value);
                    if (isExpectedSpeakerCount(nextValue)) {
                      setExpectedSpeakerCount(nextValue);
                    }
                  }}
                  value={expectedSpeakerCount ?? 'auto'}
                >
                  <option value="auto">Auto</option>
                  {EXPECTED_SPEAKER_OPTIONS.map((count) => (
                    <option key={count} value={count}>
                      {count}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <button className="button button--primary" disabled={!canImport} onClick={() => void handleImport()} type="button">
              {isSelecting ? <SpinnerIcon className="spinner" /> : <FolderIcon />}
              <span>{isSelecting ? 'Opening…' : running ? 'Transcription in progress' : 'Import Recording'}</span>
            </button>
            <button
              className={`button button--record${activeRecording?.kind === 'meeting' ? ' button--recording' : ''}`}
              disabled={activeRecording?.kind === 'meeting' ? isStoppingRecording : !canRecord}
              onClick={() => void (activeRecording?.kind === 'meeting' ? handleStopLiveRecording() : handleStartRecording('meeting'))}
              type="button"
            >
              {isStartingRecording || isStoppingRecording ? <SpinnerIcon className="spinner" /> : <MicrophoneIcon />}
              <span>{isStartingRecording ? 'Opening capture…' : activeRecording?.kind === 'meeting' ? 'Stop recording' : needsRecordingSetup ? 'Set up live recording' : 'Record live meeting'}</span>
              <span className="button__status">{activeRecording?.kind === 'meeting' ? formatDuration(recordingElapsed) : needsRecordingSetup ? 'One-time macOS approval' : 'System + mic'}</span>
            </button>
            <button
              className={`button button--dictation${activeRecording?.kind === 'dictation' ? ' button--recording' : ''}`}
              disabled={activeRecording?.kind === 'dictation' ? isStoppingRecording : !canDictate}
              onClick={() => void (activeRecording?.kind === 'dictation' ? handleStopLiveRecording() : handleStartRecording('dictation'))}
              type="button"
            >
              {isStartingRecording || isStoppingRecording ? <SpinnerIcon className="spinner" /> : <MicrophoneIcon />}
              <span>{isStartingRecording ? 'Opening microphone…' : activeRecording?.kind === 'dictation' ? 'Stop dictation' : 'Dictate'}</span>
              <span className="button__status">{activeRecording?.kind === 'dictation' ? formatDuration(recordingElapsed) : dictationShortcutLabel()}</span>
            </button>

            <div className="import-status-stack">
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
                    <div className="recording-permission__actions">
                      <button
                        className="recording-permission__button recording-permission__button--primary"
                        disabled={isRepairingPermissions}
                        onClick={() => void handleRepairRecordingPermissions()}
                        type="button"
                      >
                        {isRepairingPermissions ? 'Requesting access…' : 'Request access for this Sotto'}
                      </button>
                      <button
                        className="recording-permission__button"
                        disabled={isRepairingPermissions}
                        onClick={() => void handleOpenRecordingSettings()}
                        type="button"
                      >
                        Open System Settings
                      </button>
                    </div>
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
          </div>
        </section>
        <MeetingLibrary
          busyId={recordingActionId}
          onDeleteRecording={(recording) => void deleteRecording(recording.id)}
          onDeleteTranscript={(transcriptSummary) =>
            void deleteTranscriptFromLibrary(transcriptSummary)
          }
          onExportRecording={(recording) => void exportRecording(recording.id)}
          onOpen={openTranscript}
          onRetryRecording={(recording) => void retryRecording(recording.id)}
          recordings={appState?.recordings ?? []}
          onViewStateChange={setLibraryViewState}
          transcripts={appState?.transcripts ?? []}
          viewState={libraryViewState}
        />
      </main>
    </div>
  );
};

const Sidebar = ({
  currentPage,
  onNavigate,
}: {
  currentPage: AppPage;
  onNavigate: (page: AppPage) => void;
}) => (
  <aside className="sidebar" aria-label="Sotto navigation">
    <div className="brand"><BrandIcon className="brand__mark" /><span>Sotto</span></div>
    <nav className="navigation" aria-label="Primary">
      <button
        className={`navigation__item${currentPage === 'transcripts' ? ' navigation__item--active' : ''}`}
        onClick={() => onNavigate('transcripts')}
        type="button"
      >
        <DocumentIcon /><span>Transcripts</span>
      </button>
      <button
        className={`navigation__item${currentPage === 'local-ai' ? ' navigation__item--active' : ''}`}
        onClick={() => onNavigate('local-ai')}
        type="button"
      >
        <ModelIcon /><span>Local AI</span>
      </button>
    </nav>
    <div className="privacy-note"><LockIcon /><span>Media and transcripts stay on this device.</span></div>
  </aside>
);
