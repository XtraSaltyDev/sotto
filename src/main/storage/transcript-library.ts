import type {
  TranscriptLibraryMatch,
  TranscriptLibraryMatchField,
  TranscriptLibraryQuery,
} from '../../shared/contracts';
import { fingerprintTranscriptForLocalAi } from '../local-ai/local-ai-meeting-summary';
import { buildMeetingSummary } from '../summarization/meeting-summary';
import { MAX_RELIABLE_AUTOMATIC_SPEAKERS } from '../transcription/speaker-alignment';
import type { TranscriptRecord } from '../transcription/transcript-types';

export interface TranscriptLibrarySelection {
  records: TranscriptRecord[];
  availableSpeakers: string[];
  availableTags: string[];
  matches: TranscriptLibraryMatch[];
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
  const summary =
    record.localAiMeetingSummary?.inputFingerprint ===
    fingerprintTranscriptForLocalAi(record)
      ? record.localAiMeetingSummary.summary
      : buildMeetingSummary(record);
  if (!summary) return [];
  return [
    summary.overview,
    ...summary.keyPoints.map((item) => item.text),
    ...summary.decisions.map((item) => item.text),
    ...summary.actionItems.map((item) => item.text),
  ];
};

interface SearchSource {
  field: TranscriptLibraryMatchField;
  text: string;
}

const searchSourcesByRecord = new WeakMap<TranscriptRecord, SearchSource[]>();

const searchSources = (record: TranscriptRecord): SearchSource[] => {
  const cached = searchSourcesByRecord.get(record);
  if (cached) return cached;

  const sources: SearchSource[] = [
    { field: 'title', text: record.title },
    { field: 'transcript', text: record.text },
    ...record.segments.map((segment) => ({
      field: 'transcript' as const,
      text: segment.text,
    })),
    ...searchableSpeakerLabels(record).map((text) => ({
      field: 'speaker' as const,
      text,
    })),
    ...record.tags.map((text) => ({ field: 'tag' as const, text })),
    ...searchableMeetingSummaryText(record).map((text) => ({
      field: 'summary' as const,
      text,
    })),
  ];
  searchSourcesByRecord.set(record, sources);
  return sources;
};

/**
 * The normalized haystack (which includes a derived meeting summary) is
 * expensive to build, so it is cached per record object. Records are
 * replaced immutably on every mutation, which makes object identity a
 * correct cache key, and the WeakMap lets dropped records be collected.
 */
const haystackByRecord = new WeakMap<TranscriptRecord, string>();

const searchHaystack = (record: TranscriptRecord): string => {
  const cached = haystackByRecord.get(record);
  if (cached !== undefined) return cached;
  const haystack = normalizeSearchValue(
    searchSources(record).map((source) => source.text).join('\n'),
  );
  haystackByRecord.set(record, haystack);
  return haystack;
};

const matchesText = (record: TranscriptRecord, query: string): boolean => {
  const terms = normalizeSearchValue(query).split(' ').filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = searchHaystack(record);
  return terms.every((term) => haystack.includes(term));
};

const matchPreview = (text: string): string => {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
};

const matchesForRecord = (
  record: TranscriptRecord,
  query: string,
): TranscriptLibraryMatch[] => {
  const terms = normalizeSearchValue(query).split(' ').filter(Boolean);
  if (terms.length === 0) return [];

  const seen = new Set<string>();
  return searchSources(record)
    .filter((source) => {
      const value = normalizeSearchValue(source.text);
      return terms.some((term) => value.includes(term));
    })
    .filter((source) => source.text.trim().length > 0)
    .filter((source) => {
      const key = normalizeSearchValue(source.text);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3)
    .map((source) => ({
      transcriptId: record.id,
      field: source.field,
      text: matchPreview(source.text),
    }));
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
    matches: selected.flatMap((record) => matchesForRecord(record, query.text)),
  };
};
