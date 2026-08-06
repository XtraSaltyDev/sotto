import type {
  MeetingSummary,
  MeetingSummaryItem,
  TranscriptCopyKind,
} from '../../shared/contracts';
import type {
  TranscriptRecord,
  TranscriptSegment,
} from '../transcription/transcript-types';

export const PORTABLE_TRANSCRIPT_FORMAT_VERSION = 1 as const;
export const MAX_SUBTITLE_CUE_CHARACTERS = 240;

interface SubtitleCue {
  endMs: number;
  startMs: number;
  text: string;
}

const normalizeInlineText = (value: string): string =>
  value
    .replace(/\0/gu, '')
    .replace(/[\r\n\t\f\v\u0085\u2028\u2029]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

const boundedInteger = (value: number, fallback: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;

const splitCueText = (value: string): string[] => {
  if (value.length <= MAX_SUBTITLE_CUE_CHARACTERS) return [value];

  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > MAX_SUBTITLE_CUE_CHARACTERS) {
    const candidate = remaining.slice(0, MAX_SUBTITLE_CUE_CHARACTERS + 1);
    const boundary = Math.max(candidate.lastIndexOf(' '), candidate.lastIndexOf('—'));
    const splitAt = boundary >= MAX_SUBTITLE_CUE_CHARACTERS * 0.6
      ? boundary
      : MAX_SUBTITLE_CUE_CHARACTERS;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
};

const speakerLabels = (record: TranscriptRecord): ReadonlyMap<string, string> =>
  new Map(
    record.speakerAnalysis?.speakers.map((speaker) => [
      speaker.id,
      normalizeInlineText(speaker.label),
    ]) ?? [],
  );

const segmentSpeakerLabel = (
  segment: TranscriptSegment,
  record: TranscriptRecord,
  labels: ReadonlyMap<string, string>,
): string | null => {
  if (segment.speakerId) return labels.get(segment.speakerId) || null;
  return record.speakerAnalysis ? 'Unclear' : null;
};

/**
 * Makes ordered, non-overlapping cues from validated saved segments. The extra
 * guards keep export deterministic if a future compatibility reader supplies
 * a zero-length, overlapping, or otherwise malformed timing value.
 */
export const createSubtitleCues = (record: TranscriptRecord): SubtitleCue[] => {
  const labels = speakerLabels(record);
  const ordered = record.segments
    .map((segment, index) => ({ index, segment }))
    .sort((left, right) => {
      const leftStart = boundedInteger(left.segment.startMs, 0);
      const rightStart = boundedInteger(right.segment.startMs, 0);
      return leftStart - rightStart || left.index - right.index;
    });
  const cues: SubtitleCue[] = [];
  let previousEndMs = 0;

  for (const { segment } of ordered) {
    const normalized = normalizeInlineText(segment.text);
    if (!normalized) continue;

    const label = segmentSpeakerLabel(segment, record, labels);
    const parts = splitCueText(normalized);
    const rawStartMs = boundedInteger(segment.startMs, previousEndMs);
    const rawEndMs = boundedInteger(segment.endMs, rawStartMs);
    const startMs = Math.max(previousEndMs, rawStartMs);
    const durationMs = Math.max(parts.length, rawEndMs - rawStartMs, 1);

    for (const [index, part] of parts.entries()) {
      const cueStartMs = startMs + Math.floor((durationMs * index) / parts.length);
      const cueEndMs = Math.max(
        cueStartMs + 1,
        startMs + Math.floor((durationMs * (index + 1)) / parts.length),
      );
      cues.push({
        startMs: cueStartMs,
        endMs: cueEndMs,
        text: label ? `${label}: ${part}` : part,
      });
      previousEndMs = cueEndMs;
    }
  }

  return cues;
};

const formatSubtitleTimestamp = (
  milliseconds: number,
  separator: ',' | '.',
): string => {
  const value = Math.max(0, Math.trunc(milliseconds));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1_000);
  const remainder = value % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${separator}${String(remainder).padStart(3, '0')}`;
};

export const formatSrtTimestamp = (milliseconds: number): string =>
  formatSubtitleTimestamp(milliseconds, ',');

export const formatWebVttTimestamp = (milliseconds: number): string =>
  formatSubtitleTimestamp(milliseconds, '.');

const escapeWebVttText = (value: string): string =>
  value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

export const formatTranscriptAsSrt = (record: TranscriptRecord): string => {
  const cues = createSubtitleCues(record);
  if (cues.length === 0) return '';
  return `${cues.map((cue, index) => [
    String(index + 1),
    `${formatSrtTimestamp(cue.startMs)} --> ${formatSrtTimestamp(cue.endMs)}`,
    cue.text,
  ].join('\n')).join('\n\n')}\n`;
};

export const formatTranscriptAsWebVtt = (record: TranscriptRecord): string => {
  const cues = createSubtitleCues(record);
  const body = cues.map((cue, index) => [
    String(index + 1),
    `${formatWebVttTimestamp(cue.startMs)} --> ${formatWebVttTimestamp(cue.endMs)}`,
    escapeWebVttText(cue.text),
  ].join('\n')).join('\n\n');
  return body ? `WEBVTT\n\n${body}\n` : 'WEBVTT\n\n';
};

const portableSummary = (summary: MeetingSummary | null) => summary
  ? {
      overview: summary.overview,
      keyPoints: summary.keyPoints.map((item) => ({ ...item })),
      decisions: summary.decisions.map((item) => ({ ...item })),
      actionItems: summary.actionItems.map((item) => ({ ...item })),
    }
  : null;

/**
 * This is a public portability shape, deliberately separate from Sotto's
 * private persistence record. It has no filesystem path, playback URL,
 * recording state, temporary job data, or app storage metadata.
 */
export const createPortableTranscript = (
  record: TranscriptRecord,
  summary: MeetingSummary | null,
) => ({
  format: 'sotto-portable-transcript' as const,
  formatVersion: PORTABLE_TRANSCRIPT_FORMAT_VERSION,
  transcript: {
    id: record.id,
    title: record.title,
    tags: [...record.tags],
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    durationMs: record.durationMs,
    language: record.language,
    source: {
      type: record.source.type,
      name: record.source.name,
      mediaKind: record.source.mediaKind,
    },
    engine: { ...record.engine },
    speakers: record.speakerAnalysis?.speakers.map((speaker) => ({
      id: speaker.id,
      label: speaker.label,
    })) ?? [],
    text: record.text,
    segments: record.segments.map((segment) => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      speakerId: segment.speakerId,
      words: segment.words.map((word) => ({ ...word })),
    })),
    markers: (record.markers ?? []).map((marker) => ({ ...marker })),
    meetingSummary: portableSummary(summary),
  },
});

export const serializePortableTranscript = (
  record: TranscriptRecord,
  summary: MeetingSummary | null,
): string => `${JSON.stringify(createPortableTranscript(record, summary), null, 2)}\n`;

const formatReferenceTimestamp = (milliseconds: number): string => {
  const totalSeconds = Math.floor(Math.max(0, milliseconds) / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

const formatSummaryItem = (
  item: MeetingSummaryItem,
  labels: ReadonlyMap<string, string>,
): string => {
  const label = item.speakerId ? labels.get(item.speakerId) : null;
  return `- [${formatReferenceTimestamp(item.startMs)}] ${label ? `${label}: ` : ''}${normalizeInlineText(item.text)}`;
};

const formatSummaryItems = (
  items: readonly MeetingSummaryItem[],
  labels: ReadonlyMap<string, string>,
  emptyText: string,
): string => items.length > 0
  ? items.map((item) => formatSummaryItem(item, labels)).join('\n')
  : emptyText;

export const formatMeetingMinutesText = (
  record: TranscriptRecord,
  summary: MeetingSummary | null,
): string => {
  const labels = speakerLabels(record);
  const overview = normalizeInlineText(summary?.overview ?? '') ||
    'No overview was extracted from this transcript.';
  return [
    record.title,
    `Date: ${record.completedAt}`,
    '',
    'OVERVIEW',
    overview,
    '',
    'KEY POINTS',
    formatSummaryItems(summary?.keyPoints ?? [], labels, 'No key points were found.'),
    '',
    'DECISIONS',
    formatSummaryItems(summary?.decisions ?? [], labels, 'No decisions were found.'),
    '',
    'ACTION ITEMS',
    formatSummaryItems(summary?.actionItems ?? [], labels, 'No action items were found.'),
  ].join('\n');
};

export const formatTranscriptCopyText = (
  record: TranscriptRecord,
  summary: MeetingSummary | null,
  kind: TranscriptCopyKind,
): string => {
  const labels = speakerLabels(record);
  if (kind === 'meeting-minutes') return formatMeetingMinutesText(record, summary);
  if (kind === 'overview') {
    return normalizeInlineText(summary?.overview ?? '') ||
      'No overview was extracted from this transcript.';
  }
  if (kind === 'key-points') {
    return formatSummaryItems(summary?.keyPoints ?? [], labels, 'No key points were found.');
  }
  if (kind === 'decisions') {
    return formatSummaryItems(summary?.decisions ?? [], labels, 'No decisions were found.');
  }
  return formatSummaryItems(summary?.actionItems ?? [], labels, 'No action items were found.');
};
