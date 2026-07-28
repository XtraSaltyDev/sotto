import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { TranscriptionJobSnapshot } from '../../shared/contracts';
import type { SelectedMedia } from '../media/media-import';
import {
  ProcessAbortedError,
  type ProcessResult,
  type RunProcessOptions,
} from '../process/process-runner';
import { TranscriptRepository } from '../storage/transcript-repository';
import { LocalTranscriptionService } from './transcription-service';

const RECORDING_ID = '32ce6fee-8f3e-4f03-a266-46d6c00ef08c';

const result = (
  overrides: Partial<ProcessResult> = {},
): ProcessResult => ({
  exitCode: 0,
  signal: null,
  stdout: '',
  stderr: '',
  stdoutTruncated: false,
  stderrTruncated: false,
  ...overrides,
});

const whisperJson = JSON.stringify({
  result: { language: 'en' },
  transcription: [
    {
      offsets: { from: 0, to: 1_000 },
      text: 'Durable recording.',
    },
  ],
});

const makeRunner = (
  shouldFailWhisper: () => boolean,
): ((options: RunProcessOptions) => Promise<ProcessResult>) =>
  async (options) => {
    if (options.args?.includes('-frames:a')) {
      return result({
        stderr:
          '  Duration: 00:00:01.00, start: 0.000000\n' +
          '  Stream #0:0: Audio: opus, 48000 Hz, stereo\n',
      });
    }

    if (options.args?.includes('-progress')) {
      const outputPath = options.args.at(-1);
      if (!outputPath) throw new Error('Missing normalized output path.');
      await writeFile(outputPath, Buffer.alloc(64));
      options.onStdout?.(Buffer.from('out_time_us=1000000\nprogress=end\n'));
      return result();
    }

    if (shouldFailWhisper()) {
      return result({ exitCode: 1, stderr: 'synthetic whisper failure' });
    }

    const outputFlag = options.args?.indexOf('--output-file') ?? -1;
    const outputPrefix = outputFlag >= 0 ? options.args?.[outputFlag + 1] : null;
    if (!outputPrefix) throw new Error('Missing Whisper output prefix.');
    await writeFile(`${outputPrefix}.json`, whisperJson);
    return result();
  };

const waitForTerminal = (
  subscribe: (resolve: (job: TranscriptionJobSnapshot) => void) => void,
): Promise<TranscriptionJobSnapshot> =>
  new Promise((resolve) => subscribe(resolve));

describe('LocalTranscriptionService durable recording behavior', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  const setup = async (
    processRunner: (options: RunProcessOptions) => Promise<ProcessResult>,
  ) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-transcription-'));
    roots.push(root);
    const recordingPath = path.join(root, 'recording.webm');
    await writeFile(recordingPath, 'original durable webm');
    const media: SelectedMedia = {
      extension: 'WEBM',
      mediaKind: 'audio',
      name: 'Live meeting.webm',
      path: recordingPath,
      sizeBytes: (await readFile(recordingPath)).byteLength,
      sourceType: 'recording',
      recordingId: RECORDING_ID,
      cleanupAfterTranscription: false,
    };
    const repository = new TranscriptRepository(path.join(root, 'transcripts'));
    const jobsRoot = path.join(root, 'jobs');
    let terminalResolve: ((job: TranscriptionJobSnapshot) => void) | null = null;
    const service = new LocalTranscriptionService({
      runtime: {
        ffmpegPath: path.join(root, 'ffmpeg'),
        whisperPath: path.join(root, 'whisper-cli'),
        modelPath: path.join(root, 'model.bin'),
      },
      jobsRoot,
      repository,
      processRunner,
      onJobChanged: (job) => {
        if (['completed', 'failed', 'cancelled'].includes(job.stage)) {
          terminalResolve?.(job);
        }
      },
    });
    await service.initialize();
    const nextTerminal = () =>
      waitForTerminal((resolve) => {
        terminalResolve = resolve;
      });
    return {
      jobsRoot,
      media,
      nextTerminal,
      recordingPath,
      repository,
      service,
    };
  };

  it('retains the original on failure and can retry the same linked recording', async () => {
    let failWhisper = true;
    const context = await setup(makeRunner(() => failWhisper));

    let terminal = context.nextTerminal();
    await context.service.start(context.media);
    await expect(terminal).resolves.toMatchObject({
      id: RECORDING_ID,
      recordingId: RECORDING_ID,
      stage: 'failed',
    });
    await expect(readFile(context.recordingPath, 'utf8')).resolves.toBe(
      'original durable webm',
    );

    // Retry as soon as the failed state is visible. The service must wait for
    // the previous derived job directory to finish clearing.
    failWhisper = false;
    terminal = context.nextTerminal();
    await context.service.start(context.media);
    await expect(terminal).resolves.toMatchObject({
      id: RECORDING_ID,
      recordingId: RECORDING_ID,
      stage: 'completed',
      transcriptId: RECORDING_ID,
    });
    await expect(context.repository.get(RECORDING_ID)).resolves.toMatchObject({
      id: RECORDING_ID,
      recordingId: RECORDING_ID,
      text: 'Durable recording.',
    });
    await expect(readFile(context.recordingPath, 'utf8')).resolves.toBe(
      'original durable webm',
    );
    await expect.poll(() => readdir(context.jobsRoot)).toEqual([]);
  });

  it('retains the original and removes derived job files when cancelled', async () => {
    const pendingRunner = async (
      options: RunProcessOptions,
    ): Promise<ProcessResult> => {
      if (options.signal?.aborted) {
        throw new ProcessAbortedError(result());
      }
      return new Promise<ProcessResult>((_resolve, reject) => {
        options.signal?.addEventListener(
          'abort',
          () => reject(new ProcessAbortedError(result())),
          { once: true },
        );
      });
    };
    const context = await setup(pendingRunner);
    const terminal = context.nextTerminal();
    const job = await context.service.start(context.media);

    expect(context.service.cancel(job.id)).toBe(true);
    await expect(terminal).resolves.toMatchObject({
      id: RECORDING_ID,
      recordingId: RECORDING_ID,
      stage: 'cancelled',
    });
    await expect(readFile(context.recordingPath, 'utf8')).resolves.toBe(
      'original durable webm',
    );
    await expect.poll(() => readdir(context.jobsRoot)).toEqual([]);
    await expect(context.repository.get(RECORDING_ID)).resolves.toBeNull();
  });
});
