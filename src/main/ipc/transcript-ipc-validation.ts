import {
  MAX_TRANSCRIPT_LIBRARY_QUERY_CHARACTERS,
  type TranscriptCopyKind,
  type TranscriptExportFormat,
  type TranscriptLibraryQuery,
} from '../../shared/contracts';
import {
  MAX_SPEAKER_LABEL_CHARACTERS,
  MAX_TRANSCRIPT_TAG_CHARACTERS,
  MAX_TRANSCRIPT_TAGS,
  MAX_TRANSCRIPT_TITLE_CHARACTERS,
  normalizeSpeakerLabel,
  normalizeTranscriptTags,
  TranscriptValidationError,
} from '../transcription/transcript-types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const TRANSCRIPT_EXPORT_FORMATS = new Set<TranscriptExportFormat>([
  'txt',
  'docx',
  'srt',
  'vtt',
  'json',
  'minutes-docx',
]);

const TRANSCRIPT_COPY_KINDS = new Set<TranscriptCopyKind>([
  'overview',
  'key-points',
  'decisions',
  'action-items',
  'meeting-minutes',
]);

export const isTranscriptExportFormat = (
  value: unknown,
): value is TranscriptExportFormat =>
  typeof value === 'string' &&
  TRANSCRIPT_EXPORT_FORMATS.has(value as TranscriptExportFormat);

export const isTranscriptCopyKind = (
  value: unknown,
): value is TranscriptCopyKind =>
  typeof value === 'string' &&
  TRANSCRIPT_COPY_KINDS.has(value as TranscriptCopyKind);

export const parseTranscriptLibraryQuery = (
  value: unknown,
): TranscriptLibraryQuery => {
  if (!isRecord(value)) {
    throw new TranscriptValidationError(
      'Transcript library search must be an object.',
    );
  }
  if (
    typeof value.text !== 'string' ||
    value.text.length > MAX_TRANSCRIPT_LIBRARY_QUERY_CHARACTERS
  ) {
    throw new TranscriptValidationError(
      `Transcript library searches cannot exceed ${MAX_TRANSCRIPT_LIBRARY_QUERY_CHARACTERS} characters.`,
    );
  }

  let createdFrom: string | null = null;
  if (value.createdFrom !== null) {
    if (
      typeof value.createdFrom !== 'string' ||
      !Number.isFinite(Date.parse(value.createdFrom))
    ) {
      throw new TranscriptValidationError(
        'Transcript library date filter is invalid.',
      );
    }
    createdFrom = new Date(value.createdFrom).toISOString();
  }

  const speaker =
    value.speaker === null
      ? null
      : normalizeSpeakerLabel(value.speaker);
  const tag =
    value.tag === null
      ? null
      : normalizeTranscriptTags([value.tag])[0];

  if (
    speaker !== null &&
    speaker.length > MAX_SPEAKER_LABEL_CHARACTERS
  ) {
    throw new TranscriptValidationError('Speaker filter is too long.');
  }

  return { text: value.text.trim(), createdFrom, speaker, tag };
};

export const parseTranscriptMetadataUpdate = (
  value: unknown,
): { title?: string; tags?: string[] } => {
  if (!isRecord(value)) {
    throw new TranscriptValidationError(
      'Transcript information must be an object.',
    );
  }
  const keys = Object.keys(value);
  if (
    keys.length === 0 ||
    keys.some((key) => key !== 'title' && key !== 'tags')
  ) {
    throw new TranscriptValidationError(
      'Only transcript title and tags can be updated.',
    );
  }

  if (
    value.title !== undefined &&
    (typeof value.title !== 'string' ||
      value.title.length === 0 ||
      value.title.length > MAX_TRANSCRIPT_TITLE_CHARACTERS)
  ) {
    throw new TranscriptValidationError(
      `Transcript titles must be 1–${MAX_TRANSCRIPT_TITLE_CHARACTERS} characters.`,
    );
  }
  if (
    value.tags !== undefined &&
    (!Array.isArray(value.tags) ||
      value.tags.length > MAX_TRANSCRIPT_TAGS ||
      value.tags.some(
        (tag) =>
          typeof tag !== 'string' ||
          tag.length === 0 ||
          tag.length > MAX_TRANSCRIPT_TAG_CHARACTERS,
      ))
  ) {
    throw new TranscriptValidationError(
      `Use up to ${MAX_TRANSCRIPT_TAGS} tags of ${MAX_TRANSCRIPT_TAG_CHARACTERS} characters each.`,
    );
  }

  return {
    ...(value.title !== undefined ? { title: value.title } : {}),
    ...(value.tags !== undefined ? { tags: value.tags as string[] } : {}),
  };
};
