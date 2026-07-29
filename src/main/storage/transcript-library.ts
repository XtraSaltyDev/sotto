import type { TranscriptLibraryQuery } from '../../shared/contracts';
import { buildMeetingSummary } from '../summarization/meeting-summary';
import { MAX_RELIABLE_AUTOMATIC_SPEAKERS } from '../transcription/speaker-alignment';
import type { TranscriptRecord } from '../transcription/transcript-types';

export interface TranscriptLibrarySelection {
  records: TranscriptRecord[];
  availableSpeakers: string[];
  availableTags: string[];
}

const normalizeSearchValue = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();

const sortedUnique = (values: readonly string[]): string[] => {
  const byNormalizedValue = new Map<string, string>();
  for (const value of values) {
    const key = normalizeSearchValue(value);
    if (key && !byNormalizedValue.has(key)) byNormalizedValue.set(key, value);
  }
  return [...byNormalizedValue.values()].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: 'base' }),
  );
};

const searchableSpeakerLabels = (record: TranscriptRecord): string[] =>
  (record.speakerAnalysis?.speakers.length ?? 0) <=
  MAX_RELIABLE_AUTOMATIC_SPEAKERS
    ? record.speakerAnalysis?.speakers.map((speaker) => speaker.label) ?? []
    : [];

const searchableMeetingSummaryText = (record: TranscriptRecord): string[] => {
  const summary = buildMeetingSummary(record);
  if (!summary) return [];
  return [
    summary.overview,
    ...summary.keyPoints.map((item) => item.text),
    ...summary.decisions.map((item) => item.text),
    ...summary.actionItems.map((item) => item.text),
  ];
};

const matchesText = (record: TranscriptRecord, query: string): boolean => {
  const terms = normalizeSearchValue(query).split(' ').filter(Boolean);
  if (terms.length === 0) return true;

  const haystack = normalizeSearchValue(
    [
      record.title,
      record.text,
      ...record.segments.map((segment) => segment.text),
      ...searchableSpeakerLabels(record),
      ...record.tags,
      ...searchableMeetingSummaryText(record),
    ].join('\n'),
  );
  return terms.every((term) => haystack.includes(term));
};

export const searchTranscriptRecords = (
  records: readonly TranscriptRecord[],
  query: TranscriptLibraryQuery,
): TranscriptLibrarySelection => {
  const availableSpeakers = sortedUnique(
    records.flatMap(searchableSpeakerLabels),
  );
  const availableTags = sortedUnique(records.flatMap((record) => record.tags));
  const speakerFilter = query.speaker
    ? normalizeSearchValue(query.speaker)
    : null;
  const tagFilter = query.tag ? normalizeSearchValue(query.tag) : null;
  const createdFrom = query.createdFrom
    ? Date.parse(query.createdFrom)
    : Number.NEGATIVE_INFINITY;

  const selected = records.filter((record) => {
    if (Date.parse(record.createdAt) < createdFrom) return false;
    if (
      speakerFilter &&
      !searchableSpeakerLabels(record).some(
        (label) => normalizeSearchValue(label) === speakerFilter,
      )
    ) {
      return false;
    }
    if (
      tagFilter &&
      !record.tags.some((tag) => normalizeSearchValue(tag) === tagFilter)
    ) {
      return false;
    }
    return matchesText(record, query.text);
  });

  return {
    records: selected,
    availableSpeakers,
    availableTags,
  };
};
