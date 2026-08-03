import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type {
  LocalAiConnectionSummary,
  LocalAiMeetingSummary,
  MeetingSummary,
  TranscriptDetail,
  TranscriptCopyKind,
  TranscriptExportFormat,
  TranscriptSpeaker,
} from '../shared/contracts';
import { clearSavedSpeakerDraft } from './speaker-drafts';
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
import { parseTranscriptTagDraft } from './transcript-library';
import {
  ArrowLeftIcon,
  ShareIcon,
  SpinnerIcon,
  TrashIcon,
} from './icons';
import {
  TRANSCRIPT_COPY_OPTIONS,
  TRANSCRIPT_EXPORT_OPTIONS,
} from './transcript-output-actions';
import {
  closeOutputMenu,
  formatDate,
  formatDuration,
  formatFileSize,
  meetingDetailModeForKey,
  type MeetingDetailMode,
} from './app-format';

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
    <section
      aria-labelledby="meeting-summary-tab"
      className="meeting-summary"
      id="meeting-summary-panel"
      role="tabpanel"
    >
      <header>
        <div>
          <h2 id="meeting-summary-title">Meeting summary</h2>
          <p>
            {showingLocalAi
              ? `Local AI · ${localAiSummary.model}`
              : 'Generated by Sotto'}
          </p>
        </div>
        <div className="meeting-summary__actions">
          {localAiSummary ? (
            <div className="meeting-summary__source" aria-label="Summary source" role="group">
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
      </header>
      <div className={`meeting-summary__quality${showingLocalAi ? ' meeting-summary__quality--active' : ''}`}>
        <p>
          {showingLocalAi
            ? 'This higher-quality draft considered the meeting in context. Every item still links back to the transcript.'
            : 'Sotto creates Key Points, Decisions, and Action Items on its own. Connect a local model for stronger context and more natural wording.'}
        </p>
        {error ? <p className="meeting-summary__error" role="alert">{error}</p> : null}
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
  <details
    className="output-menu"
    onKeyDown={(event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.currentTarget.removeAttribute('open');
      event.currentTarget.querySelector<HTMLElement>('summary')?.focus();
    }}
  >
    <summary className="icon-button" aria-label="Open sharing options">
      <ShareIcon />
      <span>Share</span>
    </summary>
    <div className="output-menu__panel" aria-label="Share meeting">
      <div className="output-menu__group" role="group" aria-label="Copy summary content">
        <p>Copy</p>
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
      <div className="output-menu__group" role="group" aria-label="Download meeting files">
        <p>Download</p>
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
      </div>
    </div>
  </details>
);

export const TranscriptView = ({
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
  const [detailMode, setDetailMode] = useState<MeetingDetailMode>('summary');
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
        <div
          aria-label="Meeting view"
          className="transcript-mode-tabs"
          onKeyDown={(event) => {
            const nextMode = meetingDetailModeForKey(detailMode, event.key);
            if (!nextMode) return;
            event.preventDefault();
            setDetailMode(nextMode);
            event.currentTarget
              .querySelector<HTMLButtonElement>(`[data-mode="${nextMode}"]`)
              ?.focus();
          }}
          role="tablist"
        >
          <button
            aria-controls="meeting-summary-panel"
            aria-selected={detailMode === 'summary'}
            data-mode="summary"
            id="meeting-summary-tab"
            onClick={() => setDetailMode('summary')}
            role="tab"
            tabIndex={detailMode === 'summary' ? 0 : -1}
            type="button"
          >
            Summary
          </button>
          <button
            aria-controls="meeting-transcript-panel"
            aria-selected={detailMode === 'transcript'}
            data-mode="transcript"
            id="meeting-transcript-tab"
            onClick={() => setDetailMode('transcript')}
            role="tab"
            tabIndex={detailMode === 'transcript' ? 0 : -1}
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
          <section
            aria-labelledby="meeting-summary-tab"
            className="summary-unavailable"
            id="meeting-summary-panel"
            role="tabpanel"
          >
            <h2>Summary unavailable</h2>
            <p>This transcript does not contain enough speech to create a meeting summary.</p>
          </section>
        ) : null}
        {detailMode === 'transcript' ? (
        <div
          aria-labelledby="meeting-transcript-tab"
          id="meeting-transcript-panel"
          role="tabpanel"
        >
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
        </div>
        ) : null}
      </article>
    ) : (
      <div className="detail-loading">That transcript is no longer available.</div>
    )}
  </main>
  );
};
