import path from 'node:path';

import type {
  RecordingTranscriptionState,
  SavedRecordingSummary,
  TranscriptionErrorCode,
} from '../../shared/contracts';
import { MAX_MEDIA_FILE_BYTES } from '../media/media-import';
import { isTranscriptId, MAX_SOURCE_NAME_CHARACTERS } from '../transcription/transcript-types';

export const RECORDING_METADATA_SCHEMA_VERSION = 1 as const;
export const MAX_RECORDING_METADATA_BYTES = 64 * 1_024;
export const MAX_RECORDING_STATUS_MESSAGE_CHARACTERS = 2_000;

export type RecordingStorageState = 'partial' | 'complete';

export interface RecordingTranscriptionMetadata {
  state: RecordingTranscriptionState;
  updatedAt: string;
  message: string;
  errorCode?: TranscriptionErrorCode;
  jobId?: string;
  transcriptId?: string;
}

export interface RecordingMetadata {
  schemaVersion: typeof RECORDING_METADATA_SCHEMA_VERSION;
  id: string;
  sourceName: string;
  startedAt: string;
  completedAt: string | null;
  sizeBytes: number;
  storageState: RecordingStorageState;
  transcription: RecordingTranscriptionMetadata;
  // A future explicit consent decision can be added as a new optional,
  // validated field. This schema deliberately records no consent today.
}

export class RecordingMetadataValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordingMetadataValidationError';
  }
}

const TRANSCRIPTION_ERROR_CODES = new Set<TranscriptionErrorCode>([
  'engine-unavailable',
  'busy',
  'invalid-media',
  'no-audio',
  'normalization-failed',
  'transcription-failed',
  'invalid-output',
  'storage-failed',
]);

const TRANSCRIPTION_STATES = new Set<RecordingTranscriptionState>([
  'ready',
  'transcribing',
  'completed',
  'failed',
  'cancelled',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const fail = (message: string): never => {
  throw new RecordingMetadataValidationError(message);
};

const readDateTime = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length > 64) {
    return fail(`${field} must be a date-time string.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return fail(`${field} must be a valid date-time.`);
  }
  return new Date(timestamp).toISOString();
};

const readOptionalId = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  return isTranscriptId(value)
    ? value.toLowerCase()
    : fail(`${field} must be a UUID.`);
};

const readSourceName = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_SOURCE_NAME_CHARACTERS ||
    value.includes('\0') ||
    path.basename(value) !== value ||
    value === '.' ||
    value === '..'
  ) {
    return fail('sourceName must be a display-only file name.');
  }
  return value;
};

const readTranscription = (value: unknown): RecordingTranscriptionMetadata => {
  if (!isRecord(value) || !TRANSCRIPTION_STATES.has(value.state as RecordingTranscriptionState)) {
    return fail('transcription state is not supported.');
  }
  if (
    typeof value.message !== 'string' ||
    value.message.length === 0 ||
    value.message.length > MAX_RECORDING_STATUS_MESSAGE_CHARACTERS ||
    value.message.includes('\0')
  ) {
    return fail('transcription.message has an invalid length.');
  }

  const state = value.state as RecordingTranscriptionState;
  const jobId = readOptionalId(value.jobId, 'transcription.jobId');
  const transcriptId = readOptionalId(
    value.transcriptId,
    'transcription.transcriptId',
  );
  const errorCode =
    value.errorCode === undefined
      ? undefined
      : TRANSCRIPTION_ERROR_CODES.has(value.errorCode as TranscriptionErrorCode)
        ? (value.errorCode as TranscriptionErrorCode)
        : fail('transcription.errorCode is not supported.');

  if (state === 'transcribing' && !jobId) {
    return fail('A transcribing recording must include its job id.');
  }
  if (state === 'completed' && (!jobId || !transcriptId)) {
    return fail('A completed recording must include its job and transcript ids.');
  }

  return {
    state,
    updatedAt: readDateTime(value.updatedAt, 'transcription.updatedAt'),
    message: value.message,
    ...(errorCode ? { errorCode } : {}),
    ...(jobId ? { jobId } : {}),
    ...(transcriptId ? { transcriptId } : {}),
  };
};

export const parseRecordingMetadata = (value: unknown): RecordingMetadata => {
  if (!isRecord(value)) {
    return fail('Recording metadata must be an object.');
  }
  if (value.schemaVersion !== RECORDING_METADATA_SCHEMA_VERSION) {
    return fail('Unsupported recording metadata schema version.');
  }
  if (!isTranscriptId(value.id)) {
    return fail('Recording id must be a UUID.');
  }
  if (value.storageState !== 'partial' && value.storageState !== 'complete') {
    return fail('Recording storage state is not supported.');
  }
  if (
    !Number.isSafeInteger(value.sizeBytes) ||
    (value.sizeBytes as number) < 0 ||
    (value.sizeBytes as number) > MAX_MEDIA_FILE_BYTES
  ) {
    return fail('Recording size is outside the supported range.');
  }

  const startedAt = readDateTime(value.startedAt, 'startedAt');
  const completedAt =
    value.completedAt === null
      ? null
      : readDateTime(value.completedAt, 'completedAt');
  if (completedAt && Date.parse(completedAt) < Date.parse(startedAt)) {
    return fail('completedAt cannot be earlier than startedAt.');
  }
  if (value.storageState === 'complete' && completedAt === null) {
    return fail('A complete recording must include completedAt.');
  }

  return {
    schemaVersion: RECORDING_METADATA_SCHEMA_VERSION,
    id: value.id.toLowerCase(),
    sourceName: readSourceName(value.sourceName),
    startedAt,
    completedAt,
    sizeBytes: value.sizeBytes as number,
    storageState: value.storageState,
    transcription: readTranscription(value.transcription),
  };
};

export const toSavedRecordingSummary = (
  metadata: RecordingMetadata,
): SavedRecordingSummary => {
  if (metadata.storageState !== 'complete' || metadata.completedAt === null) {
    throw new RecordingMetadataValidationError(
      'Only complete recordings can be shown as saved recordings.',
    );
  }

  return {
    id: metadata.id,
    sourceName: metadata.sourceName,
    startedAt: metadata.startedAt,
    completedAt: metadata.completedAt,
    sizeBytes: metadata.sizeBytes,
    transcriptionState: metadata.transcription.state,
    message: metadata.transcription.message,
    ...(metadata.transcription.errorCode
      ? { errorCode: metadata.transcription.errorCode }
      : {}),
    ...(metadata.transcription.jobId
      ? { jobId: metadata.transcription.jobId }
      : {}),
    ...(metadata.transcription.transcriptId
      ? { transcriptId: metadata.transcription.transcriptId }
      : {}),
  };
};
