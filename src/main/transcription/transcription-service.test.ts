import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TranscriptionJobSnapshot } from '../../shared/contracts';
import type { SelectedMedia } from '../media/media-import';
import {
  ProcessAbortedError,
  type ProcessResult,
  type RunProcessOptions,
} from '../process/process-runner';
import { TranscriptRepository } from '../storage/transcript-repository';
import { PlaybackRepository } from '../storage/playback-repository';
import {
  LocalTranscriptionService,
  resolveWindowsWhisperThreads,
  type LocalTranscriptionServiceOptions,
} from './transcription-service';
import type { SpeakerDiarizationResult } from './speaker-diarization';
import { TRANSCRIPT_SCHEMA_VERSION } from './transcript-types';

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
      tokens: [
        { id: 20_191, text: ' Durable', offsets: { from: 100, to: 400 } },
        { id: 5_558, text: ' recording', offsets: { from: 400, to: 850 } },
        { id: 13, text: '.', offsets: { from: 850, to: 900 } },
      ],
    },
  ],
});

const delayedSpeakerWhisperJson = JSON.stringify({
  result: { language: 'en' },
  transcription: [
    {
      offsets: { from: 0, to: 5_270 },
      text: 'I am speaking first.',
      tokens: [
        { id: 40, text: ' I', offsets: { from: 2_070, to: 3_000 } },
        { id: 41, text: ' am', offsets: { from: 3_000, to: 3_500 } },
        { id: 42, text: ' speaking', offsets: { from: 3_500, to: 4_430 } },
        { id: 43, text: ' first', offsets: { from: 4_430, to: 5_000 } },
        { id: 13, text: '.', offsets: { from: 5_000, to: 5_270 } },
      ],
    },
    {
      offsets: { from: 5_560, to: 9_280 },
      text: 'This is me speaking second.',
      tokens: [
        { id: 44, text: ' This', offsets: { from: 5_950, to: 5_950 } },
        { id: 45, text: ' is', offsets: { from: 6_020, to: 6_140 } },
        { id: 46, text: ' me', offsets: { from: 6_140, to: 6_330 } },
        { id: 47, text: ' speaking', offsets: { from: 6_330, to: 8_300 } },
        { id: 48, text: ' second', offsets: { from: 8_370, to: 8_590 } },
        { id: 13, text: '.', offsets: { from: 9_220, to: 9_280 } },
      ],
    },
  ],
});

const untimedWhisperJson = JSON.stringify({
  result: { language: 'en' },
  transcription: [
    {
      offsets: { from: 0, to: 1_000 },
      text: 'Words without token timing.',
    },
  ],
});

const makeRunner = (
  shouldFailWhisper: () => boolean,
  outputJson = whisperJson,
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
    await writeFile(`${outputPrefix}.json`, outputJson);
    return result();
  };

const makeUnknownDurationRunner = (
  outputJson: string,
  observedDurationMicroseconds = 12_750_000,
): ((options: RunProcessOptions) => Promise<ProcessResult>) =>
  async (options) => {
    if (options.args?.includes('-frames:a')) {
      return result({
        stderr:
          '  Duration: N/A, start: 0.000000\n' +
          '  Stream #0:0: Audio: opus, 48000 Hz, stereo\n',
      });
    }

    if (options.args?.includes('-progress')) {
      const outputPath = options.args.at(-1);
      if (!outputPath) throw new Error('Missing normalized output path.');
      await writeFile(outputPath, Buffer.alloc(64));
      options.onStdout?.(
        Buffer.from(
          `out_time_us=${observedDurationMicroseconds}\nprogress=end\n`,
        ),
      );
      return result();
    }

    const outputFlag = options.args?.indexOf('--output-file') ?? -1;
    const outputPrefix = outputFlag >= 0 ? options.args?.[outputFlag + 1] : null;
    if (!outputPrefix) throw new Error('Missing Whisper output prefix.');
    await writeFile(`${outputPrefix}.json`, outputJson);
    return result();
  };

const waitForTerminal = (
  subscribe: (resolve: (job: TranscriptionJobSnapshot) => void) => void,
): Promise<TranscriptionJobSnapshot> =>
  new Promise((resolve) => subscribe(resolve));

describe('LocalTranscriptionService durable recording behavior', () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  const setup = async (
    processRunner: (options: RunProcessOptions) => Promise<ProcessResult>,
    speakerDiarizationRunner: () => Promise<SpeakerDiarizationResult> =
      async () => ({ segments: [], clusterConsistency: null }),
    withSpeakerRuntime = true,
    serviceOptions: Pick<
      LocalTranscriptionServiceOptions,
      'availableParallelism' | 'platform'
    > = {},
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
    const playbackRepository = new PlaybackRepository(path.join(root, 'playback'));
    const jobsRoot = path.join(root, 'jobs');
    let terminalResolve: ((job: TranscriptionJobSnapshot) => void) | null = null;
    const updates: TranscriptionJobSnapshot[] = [];
    const service = new LocalTranscriptionService({
      runtime: {
        ffmpegPath: path.join(root, 'ffmpeg'),
        whisperPath: path.join(root, 'whisper-cli'),
        modelPath: path.join(root, 'model.bin'),
        speakerDiarization: withSpeakerRuntime
          ? {
              childPath: path.join(root, 'speaker-child.cjs'),
              embeddingModelPath: path.join(root, 'embedding.onnx'),
              modulePath: path.join(root, 'sherpa-onnx.js'),
              segmentationModelPath: path.join(root, 'segmentation.onnx'),
            }
          : null,
      },
      jobsRoot,
      repository,
      playbackRepository,
      processRunner,
      speakerDiarizationRunner,
      ...serviceOptions,
      onJobChanged: (job) => {
        updates.push({ ...job });
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
      playbackRepository,
      service,
      updates,
    };
  };

  it.each([
    [Number.NaN, 1],
    [0, 1],
    [1, 1],
    [4, 4],
    [8, 8],
    [32, 8],
  ])('bounds %s available processors to %s Whisper threads', (parallelism, expected) => {
    expect(resolveWindowsWhisperThreads(parallelism)).toBe(expected);
  });

  it('passes bounded thread arguments to Whisper only on Windows', async () => {
    const windowsCalls: RunProcessOptions[] = [];
    const windowsDelegate = makeRunner(() => false);
    const windows = await setup(
      async (options) => {
        windowsCalls.push(options);
        return windowsDelegate(options);
      },
      async () => ({ segments: [], clusterConsistency: null }),
      false,
      { platform: 'win32', availableParallelism: 12 },
    );
    let terminal = windows.nextTerminal();
    await windows.service.start(windows.media);
    await expect(terminal).resolves.toMatchObject({ stage: 'completed' });
    const windowsWhisper = windowsCalls.find((call) =>
      call.args?.includes('--output-json-full'),
    );
    expect(windowsWhisper?.args).toEqual(
      expect.arrayContaining(['--threads', '8']),
    );
    expect(windowsWhisper?.args?.filter((argument) => argument === '--threads')).toHaveLength(1);

    const macCalls: RunProcessOptions[] = [];
    const macDelegate = makeRunner(() => false);
    const mac = await setup(
      async (options) => {
        macCalls.push(options);
        return macDelegate(options);
      },
      async () => ({ segments: [], clusterConsistency: null }),
      false,
      { platform: 'darwin', availableParallelism: 12 },
    );
    terminal = mac.nextTerminal();
    await mac.service.start(mac.media);
    await expect(terminal).resolves.toMatchObject({ stage: 'completed' });
    const macWhisper = macCalls.find((call) =>
      call.args?.includes('--output-json-full'),
    );
    expect(macWhisper?.args).not.toContain('--threads');
  });

  it('uses an indeterminate handoff until Whisper reports real progress', async () => {
    const delegate = makeRunner(() => false);
    const context = await setup(async (options) => {
      if (options.args?.includes('--output-json-full')) {
        options.onStderr?.(
          Buffer.from('whisper_print_progress_callback: progress =  25%\n'),
        );
      }
      return delegate(options);
    });
    const terminal = context.nextTerminal();
    await context.service.start(context.media);
    await expect(terminal).resolves.toMatchObject({ stage: 'completed' });

    expect(context.updates).toContainEqual(
      expect.objectContaining({
        stage: 'transcribing',
        progress: 0.2,
        message: 'Running the local speech model…',
      }),
    );
    expect(context.updates).toContainEqual(
      expect.objectContaining({
        stage: 'transcribing',
        progress: 0.38,
      }),
    );
  });

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

  it('retains an imported playback copy only after a successful transcript', async () => {
    const context = await setup(makeRunner(() => false), async () => ({ segments: [], clusterConsistency: null }), false);
    const imported: SelectedMedia = {
      ...context.media,
      name: 'Imported meeting.mp4',
      sourceType: 'imported-file',
      recordingId: undefined,
    };
    const terminal = context.nextTerminal();
    const job = await context.service.start(imported);
    await expect(terminal).resolves.toMatchObject({ stage: 'completed' });

    await expect(context.playbackRepository.get(job.id)).resolves.toMatchObject({
      sizeBytes: 64,
    });
    await expect(context.repository.get(job.id)).resolves.toMatchObject({
      source: { type: 'imported-file', name: 'Imported meeting.mp4' },
      segments: [
        expect.objectContaining({
          words: [
            expect.objectContaining({ text: ' Durable' }),
            expect.objectContaining({ text: ' recording' }),
            expect.objectContaining({ text: '.' }),
          ],
        }),
      ],
    });
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

  it('replaces a transcript in place while preserving title, tags, and creation date', async () => {
    const context = await setup(makeRunner(() => false));
    const firstTerminal = context.nextTerminal();
    await context.service.start(context.media);
    await expect(firstTerminal).resolves.toMatchObject({ stage: 'completed' });

    const original = await context.repository.get(RECORDING_ID);
    if (!original) throw new Error('The first transcript was not saved.');
    await context.repository.save({
      ...original,
      title: 'Quarterly sync',
      tags: ['finance', 'q3'],
    });

    // Re-transcription targets the transcript id directly, with no
    // recording bookkeeping involved.
    const secondTerminal = context.nextTerminal();
    await context.service.start({
      ...context.media,
      sourceType: 'imported-file',
      recordingId: undefined,
      transcriptId: RECORDING_ID,
    });
    await expect(secondTerminal).resolves.toMatchObject({
      stage: 'completed',
      id: RECORDING_ID,
    });

    const replaced = await context.repository.get(RECORDING_ID);
    expect(replaced).toMatchObject({
      id: RECORDING_ID,
      title: 'Quarterly sync',
      tags: ['finance', 'q3'],
      createdAt: original.createdAt,
    });
    expect(replaced?.localAiMeetingSummary ?? null).toBeNull();
  });

  it('saves stable speaker references when local clustering succeeds', async () => {
    const speakerDiarizationRunner = vi.fn(async () => ({
      segments: [{ startMs: 0, endMs: 1_000, cluster: 4 }],
      clusterConsistency: null,
    }));
    const context = await setup(makeRunner(() => false), speakerDiarizationRunner);
    const terminal = context.nextTerminal();
    await context.service.start(context.media, 3);
    await expect(terminal).resolves.toMatchObject({ stage: 'completed' });

    expect(speakerDiarizationRunner).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSpeakerCount: 3 }),
    );

    const saved = await context.repository.get(RECORDING_ID);
    expect(saved?.schemaVersion).toBe(TRANSCRIPT_SCHEMA_VERSION);
    expect(saved?.speakerAnalysis?.speakers).toEqual([
      expect.objectContaining({ label: 'Speaker 1' }),
    ]);
    expect(saved?.segments).toEqual([
      expect.objectContaining({
        text: 'Durable recording.',
        speakerId: saved?.speakerAnalysis?.speakers[0].id,
      }),
    ]);
  });

  it('rejects an invalid expected speaker count before starting work', async () => {
    const context = await setup(makeRunner(() => false));

    await expect(
      context.service.start(context.media, 0 as never),
    ).rejects.toThrow('integer from 1 to 12');
    expect(context.service.getActiveJob()).toBeNull();
  });

  it('uses normalized duration for silent media with an unknown container duration', async () => {
    const emptyWhisperJson = JSON.stringify({
      result: { language: 'en' },
      transcription: [],
    });
    const speakerDiarizationRunner = vi.fn(async () => ({
      segments: [
        { startMs: 0, endMs: 12_750, cluster: 0 },
      ],
      clusterConsistency: null,
    }));
    const context = await setup(
      makeUnknownDurationRunner(emptyWhisperJson),
      speakerDiarizationRunner,
    );
    const terminal = context.nextTerminal();
    await context.service.start(context.media);
    await expect(terminal).resolves.toMatchObject({ stage: 'completed' });

    expect(speakerDiarizationRunner).not.toHaveBeenCalled();
    await expect(context.repository.get(RECORDING_ID)).resolves.toMatchObject({
      durationMs: 12_750,
      text: '',
      segments: [],
      speakerAnalysis: null,
    });
  });

  it('preserves trailing silence when the container duration is unknown', async () => {
    const context = await setup(
      makeUnknownDurationRunner(whisperJson),
      async () => ({ segments: [], clusterConsistency: null }),
      false,
    );
    const terminal = context.nextTerminal();
    await context.service.start(context.media);
    await expect(terminal).resolves.toMatchObject({ stage: 'completed' });

    await expect(context.repository.get(RECORDING_ID)).resolves.toMatchObject({
      durationMs: 12_750,
      text: 'Durable recording.',
      segments: [expect.objectContaining({ endMs: 1_000 })],
    });
  });

  it('skips speaker separation when Whisper has no timed words', async () => {
    const speakerDiarizationRunner = vi.fn(async () => ({
      segments: [
        { startMs: 0, endMs: 1_000, cluster: 0 },
      ],
      clusterConsistency: null,
    }));
    const context = await setup(
      makeRunner(() => false, untimedWhisperJson),
      speakerDiarizationRunner,
    );
    const terminal = context.nextTerminal();
    await context.service.start(context.media);
    await expect(terminal).resolves.toMatchObject({ stage: 'completed' });

    expect(speakerDiarizationRunner).not.toHaveBeenCalled();
    await expect(context.repository.get(RECORDING_ID)).resolves.toMatchObject({
      text: 'Words without token timing.',
      speakerAnalysis: null,
      segments: [expect.objectContaining({ speakerId: null })],
    });
  });

  it('recovers a delayed new-speaker opening before the transcript is saved', async () => {
    const context = await setup(
      makeRunner(() => false, delayedSpeakerWhisperJson),
      async () => ({
        segments: [
          { startMs: 2_039, endMs: 5_296, cluster: 0 },
          { startMs: 6_376, endMs: 9_228, cluster: 1 },
        ],
        clusterConsistency: null,
      }),
    );
    const saveCandidates: Parameters<TranscriptRepository['save']>[0][] = [];
    const save = context.repository.save.bind(context.repository);
    vi.spyOn(context.repository, 'save').mockImplementation(async (record) => {
      saveCandidates.push(record);
      return save(record);
    });
    const terminal = context.nextTerminal();
    await context.service.start(context.media);
    await expect(terminal).resolves.toMatchObject({ stage: 'completed' });

    expect(saveCandidates).toHaveLength(1);
    const saveCandidate = saveCandidates[0];
    const candidateSecondSpeakerId =
      saveCandidate.speakerAnalysis?.speakers[1].id;
    expect(candidateSecondSpeakerId).toBeTruthy();
    expect(
      saveCandidate.segments.find((segment) => segment.text.startsWith('This'))
        ?.speakerId,
    ).toBe(candidateSecondSpeakerId);

    const saved = await context.repository.get(RECORDING_ID);
    const secondSpeakerId = saved?.speakerAnalysis?.speakers[1].id;
    expect(secondSpeakerId).toBeTruthy();
    expect(
      saved?.segments.find((segment) => segment.text.startsWith('This'))?.speakerId,
    ).toBe(secondSpeakerId);
    expect(saved?.segments.every((segment) => segment.speakerId !== null)).toBe(
      true,
    );
  });

  it('saves an unlabeled transcript without invoking an unavailable speaker runtime', async () => {
    let speakerRunnerCalled = false;
    const context = await setup(
      makeRunner(() => false),
      async () => {
        speakerRunnerCalled = true;
        return {
          segments: [{ startMs: 0, endMs: 1_000, cluster: 0 }],
          clusterConsistency: null,
        };
      },
      false,
    );
    const terminal = context.nextTerminal();
    await context.service.start(context.media);
    await expect(terminal).resolves.toMatchObject({ stage: 'completed' });

    expect(speakerRunnerCalled).toBe(false);
    await expect(context.repository.get(RECORDING_ID)).resolves.toMatchObject({
      text: 'Durable recording.',
      speakerAnalysis: null,
      segments: [expect.objectContaining({ speakerId: null })],
    });
  });

  it('keeps completed text when the optional speaker pass fails', async () => {
    const context = await setup(makeRunner(() => false), async () => {
      throw new Error('Speaker separation timed out.');
    });
    const terminal = context.nextTerminal();
    await context.service.start(context.media);

    await expect(terminal).resolves.toMatchObject({ stage: 'completed' });
    await expect(context.repository.get(RECORDING_ID)).resolves.toMatchObject({
      text: 'Durable recording.',
      speakerAnalysis: null,
      segments: [expect.objectContaining({ speakerId: null })],
    });
  });
});
