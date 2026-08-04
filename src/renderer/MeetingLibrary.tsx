import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type {
  SavedRecordingSummary,
  TranscriptLibraryResult,
  TranscriptSummary,
} from '../shared/contracts';
import { MAX_TRANSCRIPT_LIBRARY_QUERY_CHARACTERS } from '../shared/contracts';
import {
  createTranscriptLibraryQuery,
  type TranscriptLibraryDateRange,
} from './transcript-library';
import {
  displayedMeetingLibraryTranscripts,
  mergeMeetingLibraryItems,
} from './meeting-library';
import { AudioFileIcon, DocumentIcon, InboxIcon } from './icons';
import {
  closeOutputMenu,
  formatDate,
  formatDuration,
  formatFileSize,
  savedRecordingLabel,
} from './app-format';

export interface TranscriptLibraryViewState {
  query: string;
  dateRange: TranscriptLibraryDateRange;
  speaker: string;
  tag: string;
}

export const MeetingLibrary = ({
  busyId,
  recordings,
  transcripts,
  onDeleteRecording,
  onDeleteAll,
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
  onDeleteAll: (
    recording: SavedRecordingSummary,
    transcript: TranscriptSummary,
  ) => void;
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
  const displayedTranscripts = displayedMeetingLibraryTranscripts(
    transcripts,
    result.transcripts,
    hasFilters,
  );
  const meetings = useMemo(
    () => mergeMeetingLibraryItems(displayedTranscripts, visibleRecordings),
    [displayedTranscripts, visibleRecordings],
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
            const busy = busyId === recording?.id || busyId === transcript?.id;
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
                    <div className="output-menu__group">
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
                          disabled={busy}
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
                    {recording && transcript ? (
                      <div className="output-menu__group">
                        <button
                          className="meeting-row__danger"
                          disabled={busy || recording.transcriptionState === 'transcribing'}
                          onClick={(event) => {
                            closeOutputMenu(event.currentTarget);
                            onDeleteAll(recording, transcript);
                          }}
                          type="button"
                        >
                          Delete all
                        </button>
                      </div>
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
