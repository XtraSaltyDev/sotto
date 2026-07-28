import path from 'node:path';

import {
  runProcess,
  type ProcessResult,
  type RunProcessOptions,
} from '../process/process-runner';

export interface MediaAudioStream {
  readonly codec: string | null;
  readonly sampleRateHz: number | null;
  readonly channelLayout: string | null;
}

export interface MediaProbe {
  readonly durationSeconds: number | null;
  readonly audio: MediaAudioStream;
}

export type MediaProbeErrorCode = 'probe-failed' | 'no-audio-stream';

export class MediaProbeError extends Error {
  readonly code: MediaProbeErrorCode;
  readonly diagnostics: string;

  constructor(code: MediaProbeErrorCode, diagnostics: string) {
    super(
      code === 'no-audio-stream'
        ? 'The selected media does not contain an audio stream.'
        : 'FFmpeg could not inspect the selected media.',
    );
    this.name = 'MediaProbeError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export type MediaProcessRunner = (
  options: RunProcessOptions,
) => Promise<ProcessResult>;

export interface ProbeMediaOptions {
  readonly ffmpegPath: string;
  readonly inputPath: string;
  readonly signal?: AbortSignal;
  readonly processRunner?: MediaProcessRunner;
}

const parseDuration = (stderr: string): number | null => {
  const match = /^\s*Duration:\s*(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?),/m.exec(
    stderr,
  );
  if (!match) {
    return null;
  }

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseFloat(match[3]);
  const duration = hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(duration) && duration > 0 ? duration : null;
};

/** Parses the stable metadata lines emitted by `ffmpeg -i`. */
export const parseFfmpegMediaProbe = (stderr: string): MediaProbe | null => {
  const audioLine = stderr
    .split(/\r?\n/)
    .find((line) => /^\s*Stream #.+:\s*Audio:\s*/.test(line));
  if (!audioLine) {
    return null;
  }

  const description = audioLine.slice(audioLine.indexOf('Audio:') + 6).trim();
  const codec = /^([^,\s]+)/.exec(description)?.[1] ?? null;
  const sampleRateMatch = /(?:^|,\s*)(\d+)\s+Hz(?:,|$)/.exec(description);
  const sampleRateHz = sampleRateMatch
    ? Number.parseInt(sampleRateMatch[1], 10)
    : null;
  const afterSampleRate = sampleRateMatch
    ? description.slice(
        (sampleRateMatch.index ?? 0) + sampleRateMatch[0].length,
      )
    : '';
  const channelLayout =
    afterSampleRate
      .replace(/^\s*/, '')
      .split(',')[0]
      ?.trim() || null;

  return {
    durationSeconds: parseDuration(stderr),
    audio: {
      codec,
      sampleRateHz,
      channelLayout,
    },
  };
};

const reportsMissingAudioStream = (stderr: string): boolean =>
  /(?:stream map|stream specifier).*(?:matches no streams|does not match any streams)/i.test(
    stderr,
  );

/** Probes just the first audio frame so inspection does not decode the media. */
export const probeMedia = async (
  options: ProbeMediaOptions,
): Promise<MediaProbe> => {
  if (
    !path.isAbsolute(options.ffmpegPath) ||
    !path.isAbsolute(options.inputPath)
  ) {
    throw new TypeError('FFmpeg and media input paths must be absolute.');
  }

  const runner = options.processRunner ?? runProcess;
  const result = await runner({
    executable: options.ffmpegPath,
    args: [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'info',
      '-i',
      options.inputPath,
      '-map',
      '0:a:0',
      '-frames:a',
      '1',
      '-f',
      'wav',
      'pipe:1',
    ],
    maxDiagnosticBytes: 256 * 1024,
    signal: options.signal,
  });

  const probe = parseFfmpegMediaProbe(result.stderr);
  if (result.exitCode !== 0) {
    throw new MediaProbeError(
      !probe && reportsMissingAudioStream(result.stderr)
        ? 'no-audio-stream'
        : 'probe-failed',
      result.stderr,
    );
  }

  if (!probe) {
    throw new MediaProbeError('no-audio-stream', result.stderr);
  }

  return probe;
};
