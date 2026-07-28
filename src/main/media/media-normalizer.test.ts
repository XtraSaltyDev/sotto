import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ProcessResult,
  RunProcessOptions,
} from '../process/process-runner';
import {
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

    await normalizeMediaToWav({
      ffmpegPath: '/runtime/ffmpeg',
      inputPath: '/recordings/meeting.mp4',
      outputPath,
      durationSeconds: 10,
      onProgress: (value) => progress.push(value),
      processRunner,
    });

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
      '-progress',
      'pipe:1',
      '-nostats',
      outputPath,
    ]);
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
