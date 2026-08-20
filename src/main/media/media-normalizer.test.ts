import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ProcessResult,
  RunProcessOptions,
} from '../process/process-runner';
import {
  MAX_MEDIA_NORMALIZATION_WALL_TIME_MS,
  MAX_NORMALIZED_AUDIO_BYTES,
  MAX_NORMALIZED_MEDIA_DURATION_SECONDS,
  normalizeMediaToWav,
  readFfmpegProgressSeconds,
} from './media-normalizer';

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sotto-normalize-'));
  temporaryDirectories.push(directory);
  return directory;
};

const successfulResult: ProcessResult = {
  exitCode: 0,
  signal: null,
  stdout: '',
  stderr: '',
  stdoutTruncated: false,
  stderrTruncated: false,
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('readFfmpegProgressSeconds', () => {
  it('prefers the correctly named microsecond field', () => {
    expect(
      readFfmpegProgressSeconds({
        out_time_us: '2500000',
        out_time: '00:00:09.000000',
      }),
    ).toBe(2.5);
  });

  it('falls back to a formatted timestamp', () => {
    expect(readFfmpegProgressSeconds({ out_time: '01:02:03.500000' })).toBe(
      3723.5,
    );
  });

  it('rejects malformed progress values', () => {
    expect(readFfmpegProgressSeconds({ out_time_us: '2500000oops' })).toBeNull();
  });
});

describe('normalizeMediaToWav', () => {
  it('normalizes to mono 16 kHz PCM WAV and reports monotonic progress', async () => {
    const directory = await makeTemporaryDirectory();
    const outputPath = path.join(directory, 'normalized.wav');
    const progress: number[] = [];
    const processRunner = vi.fn(
      async (options: RunProcessOptions): Promise<ProcessResult> => {
        options.onStdout?.(Buffer.from('out_time_us=250'));
        options.onStdout?.(
          Buffer.from('0000\nprogress=continue\nout_time_us=10000000\nprogress=end\n'),
        );
        await writeFile(outputPath, Buffer.alloc(44));
        return successfulResult;
      },
    );

    const observedDurationSeconds = await normalizeMediaToWav({
      ffmpegPath: '/runtime/ffmpeg',
      inputPath: '/recordings/meeting.mp4',
      outputPath,
      durationSeconds: 10,
      onProgress: (value) => progress.push(value),
      processRunner,
    });

    expect(observedDurationSeconds).toBe(10);
    expect(progress).toEqual([0, 0.25, 0.99, 1]);
    expect(processRunner).toHaveBeenCalledOnce();
    expect(processRunner.mock.calls[0][0].args).toEqual([
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-n',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      '/recordings/meeting.mp4',
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
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      '-t',
      String(MAX_NORMALIZED_MEDIA_DURATION_SECONDS + 1),
      '-progress',
      'pipe:1',
      '-nostats',
      outputPath,
    ]);
  });

  it('returns FFmpeg output duration when the container duration is unknown', async () => {
    const directory = await makeTemporaryDirectory();
    const outputPath = path.join(directory, 'normalized.wav');
    const progress: number[] = [];
    const processRunner = vi.fn(
      async (options: RunProcessOptions): Promise<ProcessResult> => {
        options.onStdout?.(
          Buffer.from(
            'out_time_us=2500000\nprogress=continue\n' +
              'out_time_us=12750000\nprogress=end\n',
          ),
        );
        await writeFile(outputPath, Buffer.alloc(44));
        return successfulResult;
      },
    );

    const observedDurationSeconds = await normalizeMediaToWav({
      ffmpegPath: '/runtime/ffmpeg',
      inputPath: '/recordings/live-recording.webm',
      outputPath,
      durationSeconds: null,
      onProgress: (value) => progress.push(value),
      processRunner,
    });

    expect(observedDurationSeconds).toBe(12.75);
    expect(progress).toEqual([0, 1]);
  });

  it('does not claim completion when FFmpeg fails', async () => {
    const directory = await makeTemporaryDirectory();
    const progress: number[] = [];
    const processRunner = vi.fn().mockResolvedValue({
      ...successfulResult,
      exitCode: 1,
      stderr: 'Decoder failed',
    });

    await expect(
      normalizeMediaToWav({
        ffmpegPath: '/runtime/ffmpeg',
        inputPath: '/recordings/broken.mp4',
        outputPath: path.join(directory, 'normalized.wav'),
        durationSeconds: 10,
        onProgress: (value) => progress.push(value),
        processRunner,
      }),
    ).rejects.toMatchObject({
      diagnostics: 'Decoder failed',
    });
    expect(progress).toEqual([0]);
  });

  it('rejects a known overlong recording before launching FFmpeg', async () => {
    const processRunner = vi.fn();

    await expect(
      normalizeMediaToWav({
        ffmpegPath: '/runtime/ffmpeg',
        inputPath: '/recordings/all-day.mp4',
        outputPath: '/recordings/all-day.wav',
        durationSeconds: MAX_NORMALIZED_MEDIA_DURATION_SECONDS + 1,
        processRunner,
      }),
    ).rejects.toMatchObject({ diagnostics: expect.stringContaining('12-hour') });
    expect(processRunner).not.toHaveBeenCalled();
  });

  it('removes decoded output that exceeds the bounded PCM ceiling', async () => {
    const directory = await makeTemporaryDirectory();
    const outputPath = path.join(directory, 'oversized.wav');
    const processRunner = vi.fn(async () => {
      await writeFile(outputPath, Buffer.alloc(44));
      await truncate(outputPath, MAX_NORMALIZED_AUDIO_BYTES + 1);
      return successfulResult;
    });

    await expect(
      normalizeMediaToWav({
        ffmpegPath: '/runtime/ffmpeg',
        inputPath: '/recordings/unknown.webm',
        outputPath,
        durationSeconds: null,
        processRunner,
      }),
    ).rejects.toMatchObject({ diagnostics: expect.stringContaining('12-hour') });
    await expect(writeFile(outputPath, Buffer.alloc(44), { flag: 'wx' })).resolves.toBeUndefined();
  });

  it('aborts and removes partial output after the normalization deadline', async () => {
    vi.useFakeTimers();
    try {
      const directory = await makeTemporaryDirectory();
      const outputPath = path.join(directory, 'stalled.wav');
      const processRunner = vi.fn(async (options: RunProcessOptions) => {
        return new Promise<ProcessResult>((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        });
      });
      const assertion = expect(
        normalizeMediaToWav({
          ffmpegPath: '/runtime/ffmpeg',
          inputPath: '/recordings/stalled.webm',
          outputPath,
          durationSeconds: null,
          processRunner,
        }),
      ).rejects.toMatchObject({
        diagnostics: expect.stringContaining('30-minute'),
      });

      await vi.advanceTimersByTimeAsync(MAX_MEDIA_NORMALIZATION_WALL_TIME_MS);
      await assertion;
      await expect(writeFile(outputPath, Buffer.alloc(44), { flag: 'wx' })).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects normalization over the source path', async () => {
    await expect(
      normalizeMediaToWav({
        ffmpegPath: '/runtime/ffmpeg',
        inputPath: '/recordings/source.wav',
        outputPath: '/recordings/source.wav',
        durationSeconds: 1,
      }),
    ).rejects.toThrow('must differ');
  });
});
