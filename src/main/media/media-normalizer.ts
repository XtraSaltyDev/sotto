import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { createFfmpegProgressParser } from './ffmpeg-progress';
import {
  runProcess,
  type ProcessResult,
  type RunProcessOptions,
} from '../process/process-runner';

export const NORMALIZED_AUDIO_SAMPLE_RATE = 16_000;
export const NORMALIZED_AUDIO_CHANNELS = 1;

export class MediaNormalizationError extends Error {
  readonly diagnostics: string;

  constructor(diagnostics: string) {
    super('FFmpeg could not prepare this media for transcription.');
    this.name = 'MediaNormalizationError';
    this.diagnostics = diagnostics;
  }
}

type ProcessRunner = (
  options: RunProcessOptions,
) => Promise<ProcessResult>;

export interface NormalizeMediaOptions {
  readonly ffmpegPath: string;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly durationSeconds: number | null;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: number) => void;
  readonly processRunner?: ProcessRunner;
}

const parseTimestamp = (value: string): number | null => {
  const match = /^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/.exec(value);
  if (!match) {
    return null;
  }

  return (
    Number.parseInt(match[1], 10) * 3600 +
    Number.parseInt(match[2], 10) * 60 +
    Number.parseFloat(match[3])
  );
};

/** Reads FFmpeg's current output timestamp in seconds. */
export const readFfmpegProgressSeconds = (
  fields: Readonly<Record<string, string>>,
): number | null => {
  // out_time_us is the correctly named raw microsecond field. out_time_ms is
  // retained as a compatibility fallback and is also microseconds in FFmpeg.
  const rawMicroseconds = fields.out_time_us ?? fields.out_time_ms;
  if (rawMicroseconds && /^\d+$/.test(rawMicroseconds)) {
    const parsed = Number.parseInt(rawMicroseconds, 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed / 1_000_000;
    }
  }

  return fields.out_time && fields.out_time !== 'N/A'
    ? parseTimestamp(fields.out_time)
    : null;
};

const assertMediaPaths = (inputPath: string, outputPath: string): void => {
  if (!path.isAbsolute(inputPath) || !path.isAbsolute(outputPath)) {
    throw new TypeError('Media input and output paths must be absolute.');
  }

  if (path.resolve(inputPath) === path.resolve(outputPath)) {
    throw new TypeError('Normalized media output must differ from its input.');
  }

  if (path.extname(outputPath).toLowerCase() !== '.wav') {
    throw new TypeError('Normalized media output must use a .wav extension.');
  }
};

const verifyNormalizedOutput = async (outputPath: string): Promise<void> => {
  let stats;
  try {
    stats = await lstat(outputPath);
  } catch {
    throw new MediaNormalizationError('FFmpeg did not create an output file.');
  }

  // A canonical PCM WAV header is at least 44 bytes. lstat also rejects a
  // sidecar unexpectedly replacing the output with a link or directory.
  if (!stats.isFile() || stats.size < 44) {
    throw new MediaNormalizationError(
      'FFmpeg created an invalid or incomplete WAV output.',
    );
  }
};

/** Normalizes the first audio stream to whisper.cpp's canonical PCM input. */
export const normalizeMediaToWav = async (
  options: NormalizeMediaOptions,
): Promise<number | null> => {
  if (!path.isAbsolute(options.ffmpegPath)) {
    throw new TypeError('FFmpeg executable paths must be absolute.');
  }

  assertMediaPaths(options.inputPath, options.outputPath);
  if (
    options.durationSeconds !== null &&
    (!Number.isFinite(options.durationSeconds) || options.durationSeconds <= 0)
  ) {
    throw new TypeError('durationSeconds must be positive or null.');
  }

  let lastProgress = -1;
  const emitProgress = (progress: number): void => {
    const bounded = Math.max(0, Math.min(1, progress));
    if (bounded > lastProgress) {
      lastProgress = bounded;
      options.onProgress?.(bounded);
    }
  };

  let observedDurationSeconds: number | null = null;
  const progressParser = createFfmpegProgressParser((record) => {
    const processedSeconds = readFfmpegProgressSeconds(record.fields);
    if (processedSeconds === null) {
      return;
    }

    observedDurationSeconds = Math.max(
      observedDurationSeconds ?? 0,
      processedSeconds,
    );
    if (options.durationSeconds) {
      emitProgress(Math.min(0.99, processedSeconds / options.durationSeconds));
    }
  });

  emitProgress(0);
  const runner = options.processRunner ?? runProcess;
  const result = await runner({
    executable: options.ffmpegPath,
    args: [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-n',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      options.inputPath,
      '-map',
      '0:a:0',
      '-vn',
      '-sn',
      '-dn',
      '-map_metadata',
      '-1',
      '-map_chapters',
      '-1',
      '-ac',
      String(NORMALIZED_AUDIO_CHANNELS),
      '-ar',
      String(NORMALIZED_AUDIO_SAMPLE_RATE),
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      '-progress',
      'pipe:1',
      '-nostats',
      options.outputPath,
    ],
    signal: options.signal,
    onStdout: (chunk) => progressParser.push(chunk),
  });
  progressParser.end();

  if (result.exitCode !== 0) {
    throw new MediaNormalizationError(result.stderr);
  }

  await verifyNormalizedOutput(options.outputPath);
  emitProgress(1);
  return observedDurationSeconds;
};
