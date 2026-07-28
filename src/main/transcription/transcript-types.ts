import { randomUUID } from 'node:crypto';

export const LEGACY_TRANSCRIPT_SCHEMA_VERSION = 1 as const;
export const TRANSCRIPT_SCHEMA_VERSION = 2 as const;

// These limits are deliberately generous enough for day-long recordings while
// still bounding data that originated in an external process or a local file.
export const MAX_TRANSCRIPT_SEGMENTS = 100_000;
export const MAX_TRANSCRIPT_TEXT_CHARACTERS = 10_000_000;
export const MAX_SEGMENT_TEXT_CHARACTERS = 100_000;
export const MAX_TRANSCRIPT_OFFSET_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_TRANSCRIPT_TITLE_CHARACTERS = 300;
export const MAX_SOURCE_NAME_CHARACTERS = 512;
export const MAX_ENGINE_FIELD_CHARACTERS = 512;
export const MAX_SOURCE_FILE_BYTES = 16 * 1_024 * 1_024 * 1_024 * 1_024;
export const MAX_TRANSCRIPT_SPEAKERS = 256;
export const MAX_SPEAKER_LABEL_CHARACTERS = 100;

export type TranscriptId = string;
export type TranscriptSpeakerId = string;
export type TranscriptSourceType = 'imported-file' | 'recording';
export type TranscriptMediaKind = 'audio' | 'video';

export interface TranscriptSourceMetadata {
  type: TranscriptSourceType;
  /** A display-only basename. Absolute source paths are never persisted. */
  name: string;
  mediaKind: TranscriptMediaKind;
  sizeBytes: number;
}

export interface TranscriptEngineMetadata {
  name: string;
  model: string;
  version: string;
}

export interface TranscriptSpeaker {
  id: TranscriptSpeakerId;
  label: string;
}

export interface TranscriptSpeakerAnalysis {
  engine: TranscriptEngineMetadata;
  speakers: TranscriptSpeaker[];
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  speakerId: TranscriptSpeakerId | null;
}

export interface TranscriptRecord {
  schemaVersion: typeof TRANSCRIPT_SCHEMA_VERSION;
  id: TranscriptId;
  title: string;
  createdAt: string;
  completedAt: string;
  /** Links a transcript to a retained live recording without persisting a path. */
  recordingId?: TranscriptId;
  source: TranscriptSourceMetadata;
  durationMs: number;
  language: string | null;
  engine: TranscriptEngineMetadata;
  speakerAnalysis: TranscriptSpeakerAnalysis | null;
  text: string;
  segments: TranscriptSegment[];
}

export class TranscriptValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptValidationError';
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LANGUAGE_PATTERN = /^[a-z][a-z0-9_-]{0,34}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const fail = (message: string): never => {
  throw new TranscriptValidationError(message);
};

const readBoundedString = (
  value: unknown,
  field: string,
  maximumLength: number,
  allowEmpty = false,
): string => {
  if (typeof value !== 'string') {
    return fail(`${field} must be a string.`);
  }

  if (value.includes('\0')) {
    return fail(`${field} cannot contain a null byte.`);
  }

  if ((!allowEmpty && value.trim().length === 0) || value.length > maximumLength) {
    return fail(`${field} has an invalid length.`);
  }

  return value;
};

const readInteger = (
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number => {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    return fail(`${field} must be an integer between ${minimum} and ${maximum}.`);
  }

  return value as number;
};

const looksLikeAbsolutePath = (value: string): boolean => {
  const trimmed = value.trim();

  return (
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\') ||
    /^[a-z]:[\\/]/i.test(trimmed) ||
    /^file:\/\//i.test(trimmed) ||
    /^~[\\/]/.test(trimmed)
  );
};

export const isTranscriptId = (value: unknown): value is TranscriptId =>
  typeof value === 'string' && UUID_PATTERN.test(value);

export const isTranscriptSpeakerId = (
  value: unknown,
): value is TranscriptSpeakerId =>
  typeof value === 'string' && UUID_PATTERN.test(value);

export const createTranscriptId = (): TranscriptId => randomUUID();
export const createTranscriptSpeakerId = (): TranscriptSpeakerId => randomUUID();

export const normalizeSpeakerLabel = (value: unknown): string => {
  const label = readBoundedString(
    value,
    'speaker label',
    MAX_SPEAKER_LABEL_CHARACTERS,
  );

  if (
    Array.from(label).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    return fail('speaker label cannot contain control characters.');
  }

  return label.trim();
};

const parseDateTime = (value: unknown, field: string): string => {
  const dateTime = readBoundedString(value, field, 64);
  const timestamp = Date.parse(dateTime);

  if (!Number.isFinite(timestamp)) {
    return fail(`${field} must be a valid date-time.`);
  }

  return new Date(timestamp).toISOString();
};

const parseSource = (value: unknown): TranscriptSourceMetadata => {
  if (!isRecord(value)) {
    return fail('source must be an object.');
  }

  const type = value.type;
  if (type !== 'imported-file' && type !== 'recording') {
    return fail('source.type is not supported.');
  }

  const mediaKind = value.mediaKind;
  if (mediaKind !== 'audio' && mediaKind !== 'video') {
    return fail('source.mediaKind is not supported.');
  }

  const name = readBoundedString(
    value.name,
    'source.name',
    MAX_SOURCE_NAME_CHARACTERS,
  );

  if (
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    looksLikeAbsolutePath(name)
  ) {
    return fail('source.name must be a display-only file name, not a path.');
  }

  return {
    type,
    name,
    mediaKind,
    sizeBytes: readInteger(
      value.sizeBytes,
      'source.sizeBytes',
      0,
      MAX_SOURCE_FILE_BYTES,
    ),
  };
};

const parseEngine = (
  value: unknown,
  field = 'engine',
): TranscriptEngineMetadata => {
  if (!isRecord(value)) {
    return fail(`${field} must be an object.`);
  }

  return {
    name: readBoundedString(
      value.name,
      `${field}.name`,
      MAX_ENGINE_FIELD_CHARACTERS,
    ),
    model: readBoundedString(
      value.model,
      `${field}.model`,
      MAX_ENGINE_FIELD_CHARACTERS,
    ),
    version: readBoundedString(
      value.version,
      `${field}.version`,
      MAX_ENGINE_FIELD_CHARACTERS,
    ),
  };
};

const parseSpeakerAnalysis = (
  value: unknown,
): TranscriptSpeakerAnalysis | null => {
  if (value === null) {
    return null;
  }

  if (!isRecord(value)) {
    return fail('speakerAnalysis must be an object or null.');
  }

  if (!Array.isArray(value.speakers)) {
    return fail('speakerAnalysis.speakers must be an array.');
  }

  if (value.speakers.length > MAX_TRANSCRIPT_SPEAKERS) {
    return fail(
      `speakerAnalysis.speakers cannot contain more than ${MAX_TRANSCRIPT_SPEAKERS} items.`,
    );
  }

  const seenIds = new Set<TranscriptSpeakerId>();
  const speakers = value.speakers.map((candidate, index): TranscriptSpeaker => {
    if (!isRecord(candidate)) {
      return fail(`speakerAnalysis.speakers[${index}] must be an object.`);
    }

    if (!isTranscriptSpeakerId(candidate.id)) {
      return fail(`speakerAnalysis.speakers[${index}].id must be a UUID.`);
    }

    const id = candidate.id.toLowerCase();
    if (seenIds.has(id)) {
      return fail('speakerAnalysis.speakers must have unique ids.');
    }
    seenIds.add(id);

    return {
      id,
      label: normalizeSpeakerLabel(candidate.label),
    };
  });

  return {
    engine: parseEngine(value.engine, 'speakerAnalysis.engine'),
    speakers,
  };
};

const parseSegments = (
  value: unknown,
  schemaVersion: 1 | typeof TRANSCRIPT_SCHEMA_VERSION,
  speakerIds: ReadonlySet<TranscriptSpeakerId>,
): TranscriptSegment[] => {
  if (!Array.isArray(value)) {
    return fail('segments must be an array.');
  }

  if (value.length > MAX_TRANSCRIPT_SEGMENTS) {
    return fail(`segments cannot contain more than ${MAX_TRANSCRIPT_SEGMENTS} items.`);
  }

  let previousEndMs = 0;
  let totalTextCharacters = 0;

  return value.map((candidate, index) => {
    if (!isRecord(candidate)) {
      return fail(`segments[${index}] must be an object.`);
    }

    const startMs = readInteger(
      candidate.startMs,
      `segments[${index}].startMs`,
      0,
      MAX_TRANSCRIPT_OFFSET_MS,
    );
    const endMs = readInteger(
      candidate.endMs,
      `segments[${index}].endMs`,
      startMs,
      MAX_TRANSCRIPT_OFFSET_MS,
    );

    if (startMs < previousEndMs) {
      return fail('segments must be ordered and cannot overlap.');
    }

    const text = readBoundedString(
      candidate.text,
      `segments[${index}].text`,
      MAX_SEGMENT_TEXT_CHARACTERS,
      true,
    );
    totalTextCharacters += text.length;
    if (totalTextCharacters > MAX_TRANSCRIPT_TEXT_CHARACTERS) {
      return fail('Combined segment text exceeds the transcript text limit.');
    }

    const speakerId =
      schemaVersion === LEGACY_TRANSCRIPT_SCHEMA_VERSION
        ? null
        : candidate.speakerId === null
          ? null
          : isTranscriptSpeakerId(candidate.speakerId)
            ? candidate.speakerId.toLowerCase()
            : fail(`segments[${index}].speakerId must be a UUID or null.`);

    if (speakerId !== null && !speakerIds.has(speakerId)) {
      return fail(`segments[${index}].speakerId must reference a declared speaker.`);
    }

    previousEndMs = endMs;

    return { startMs, endMs, text, speakerId };
  });
};

/**
 * Validates and returns a sanitized canonical record. Schema-v1 files are
 * migrated in memory without being rewritten merely because they were read.
 * Unknown properties are intentionally discarded so future or hostile input
 * cannot persist paths or other undeclared metadata.
 */
export const parseTranscriptRecord = (value: unknown): TranscriptRecord => {
  if (!isRecord(value)) {
    return fail('Transcript record must be an object.');
  }

  if (
    value.schemaVersion !== LEGACY_TRANSCRIPT_SCHEMA_VERSION &&
    value.schemaVersion !== TRANSCRIPT_SCHEMA_VERSION
  ) {
    return fail(`Unsupported transcript schema version: ${String(value.schemaVersion)}.`);
  }
  const sourceSchemaVersion = value.schemaVersion;

  if (!isTranscriptId(value.id)) {
    return fail('id must be a UUID.');
  }

  const title = readBoundedString(
    value.title,
    'title',
    MAX_TRANSCRIPT_TITLE_CHARACTERS,
  );
  if (looksLikeAbsolutePath(title)) {
    return fail('title cannot be an absolute path.');
  }

  const durationMs = readInteger(
    value.durationMs,
    'durationMs',
    0,
    MAX_TRANSCRIPT_OFFSET_MS,
  );
  const language =
    value.language === null
      ? null
      : readBoundedString(value.language, 'language', 35).toLowerCase();

  if (language !== null && !LANGUAGE_PATTERN.test(language)) {
    return fail('language is not a valid language identifier.');
  }

  const text = readBoundedString(
    value.text,
    'text',
    MAX_TRANSCRIPT_TEXT_CHARACTERS,
    true,
  );
  const recordingId =
    value.recordingId === undefined
      ? undefined
      : isTranscriptId(value.recordingId)
        ? value.recordingId.toLowerCase()
        : fail('recordingId must be a UUID.');
  const speakerAnalysis =
    sourceSchemaVersion === LEGACY_TRANSCRIPT_SCHEMA_VERSION
      ? null
      : parseSpeakerAnalysis(value.speakerAnalysis);
  const speakerIds = new Set(
    speakerAnalysis?.speakers.map((speaker) => speaker.id) ?? [],
  );
  const segments = parseSegments(
    value.segments,
    sourceSchemaVersion,
    speakerIds,
  );
  const createdAt = parseDateTime(value.createdAt, 'createdAt');
  const completedAt = parseDateTime(value.completedAt, 'completedAt');

  if (segments.length > 0 && segments[segments.length - 1].endMs > durationMs) {
    return fail('durationMs cannot be shorter than the final segment.');
  }

  if (Date.parse(completedAt) < Date.parse(createdAt)) {
    return fail('completedAt cannot be earlier than createdAt.');
  }

  return {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    id: value.id.toLowerCase(),
    title,
    createdAt,
    completedAt,
    ...(recordingId ? { recordingId } : {}),
    source: parseSource(value.source),
    durationMs,
    language,
    engine: parseEngine(value.engine),
    speakerAnalysis,
    text,
    segments,
  };
};
