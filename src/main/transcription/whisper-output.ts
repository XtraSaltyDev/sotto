import {
  MAX_SEGMENT_TEXT_CHARACTERS,
  MAX_TRANSCRIPT_OFFSET_MS,
  MAX_TRANSCRIPT_SEGMENTS,
  MAX_TRANSCRIPT_TEXT_CHARACTERS,
  type TranscriptSegment,
} from './transcript-types';

export const MAX_WHISPER_JSON_BYTES = 64 * 1_024 * 1_024;

export interface NormalizedWhisperOutput {
  durationMs: number;
  language: string | null;
  text: string;
  segments: TranscriptSegment[];
}

export class WhisperOutputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhisperOutputValidationError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const fail = (message: string): never => {
  throw new WhisperOutputValidationError(message);
};

const normalizeSegmentText = (value: unknown, index: number): string => {
  if (typeof value !== 'string') {
    return fail(`transcription[${index}].text must be a string.`);
  }

  if (value.includes('\0')) {
    return fail(`transcription[${index}].text cannot contain a null byte.`);
  }

  if (value.length > MAX_SEGMENT_TEXT_CHARACTERS) {
    return fail(
      `transcription[${index}].text exceeds ${MAX_SEGMENT_TEXT_CHARACTERS} characters.`,
    );
  }

  return value.replace(/\s+/gu, ' ').trim();
};

const readOffset = (
  value: unknown,
  field: string,
  minimum: number,
): number => {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > MAX_TRANSCRIPT_OFFSET_MS
  ) {
    return fail(
      `${field} must be an integer between ${minimum} and ${MAX_TRANSCRIPT_OFFSET_MS}.`,
    );
  }

  return value as number;
};

const normalizeLanguage = (root: Record<string, unknown>): string | null => {
  const result = root.result;

  if (result === undefined) {
    return null;
  }

  if (!isRecord(result)) {
    return fail('result must be an object when present.');
  }

  const language = result.language;
  if (language === undefined || language === null || language === '') {
    return null;
  }

  if (
    typeof language !== 'string' ||
    language.length > 35 ||
    !/^[a-z][a-z0-9_-]{0,34}$/i.test(language)
  ) {
    return fail('result.language is not a valid language identifier.');
  }

  return language.toLowerCase();
};

/**
 * Normalizes the JSON shape emitted by whisper.cpp's `whisper-cli -oj`.
 * Segment offsets in that format are integer milliseconds.
 */
export const normalizeWhisperOutput = (value: unknown): NormalizedWhisperOutput => {
  if (!isRecord(value)) {
    return fail('Whisper output must be an object.');
  }

  const transcription = value.transcription;
  if (!Array.isArray(transcription)) {
    return fail('transcription must be an array.');
  }

  if (transcription.length > MAX_TRANSCRIPT_SEGMENTS) {
    return fail(
      `transcription cannot contain more than ${MAX_TRANSCRIPT_SEGMENTS} segments.`,
    );
  }

  const segments: TranscriptSegment[] = [];
  let previousEndMs = 0;
  let totalTextCharacters = 0;
  let nonEmptyTextSegments = 0;

  transcription.forEach((candidate, index) => {
    if (!isRecord(candidate)) {
      return fail(`transcription[${index}] must be an object.`);
    }

    if (!isRecord(candidate.offsets)) {
      return fail(`transcription[${index}].offsets must be an object.`);
    }

    const startMs = readOffset(
      candidate.offsets.from,
      `transcription[${index}].offsets.from`,
      0,
    );
    const endMs = readOffset(
      candidate.offsets.to,
      `transcription[${index}].offsets.to`,
      startMs,
    );

    if (startMs < previousEndMs) {
      return fail('Whisper segments must be ordered and cannot overlap.');
    }

    const text = normalizeSegmentText(candidate.text, index);
    totalTextCharacters += text.length;
    if (nonEmptyTextSegments > 0 && text.length > 0) {
      totalTextCharacters += 1;
    }

    if (totalTextCharacters > MAX_TRANSCRIPT_TEXT_CHARACTERS) {
      return fail(
        `Combined transcript text exceeds ${MAX_TRANSCRIPT_TEXT_CHARACTERS} characters.`,
      );
    }

    segments.push({ startMs, endMs, text });
    if (text.length > 0) {
      nonEmptyTextSegments += 1;
    }
    previousEndMs = endMs;
  });

  return {
    durationMs: segments.at(-1)?.endMs ?? 0,
    language: normalizeLanguage(value),
    text: segments
      .map((segment) => segment.text)
      .filter((text) => text.length > 0)
      .join(' '),
    segments,
  };
};

export const parseWhisperOutputJson = (json: string): NormalizedWhisperOutput => {
  if (typeof json !== 'string') {
    return fail('Whisper output JSON must be a string.');
  }

  if (Buffer.byteLength(json, 'utf8') > MAX_WHISPER_JSON_BYTES) {
    return fail(`Whisper output exceeds ${MAX_WHISPER_JSON_BYTES} bytes.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return fail('Whisper output is not valid JSON.');
  }

  return normalizeWhisperOutput(parsed);
};
