import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { availableParallelism as readAvailableParallelism } from 'node:os';
import path from 'node:path';

import {
  isExpectedSpeakerCount,
  type ExpectedSpeakerCount,
  type TranscriptionErrorCode,
  type TranscriptionJobSnapshot,
  type TranscriptionStage,
} from '../../shared/contracts';
import { DEFAULT_TRANSCRIPTION_MODEL } from '../../shared/default-transcription-model';
import { normalizeMediaToWav, MediaNormalizationError } from '../media/media-normalizer';
import { MediaProbeError, probeMedia } from '../media/media-probe';
import type { SelectedMedia } from '../media/media-import';
import {
  ProcessAbortedError,
  runProcess,
  type ProcessResult,
  type RunProcessOptions,
} from '../process/process-runner';
import type { EngineRuntime } from '../runtime/engine-runtime';
import { TranscriptRepository } from '../storage/transcript-repository';
import {
  createTranscriptId,
  isTranscriptId,
  MAX_TRANSCRIPT_TITLE_CHARACTERS,
  TRANSCRIPT_SCHEMA_VERSION,
  type TranscriptRecord,
} from './transcript-types';
import type { PlaybackRepository } from '../storage/playback-repository';
import {
  MAX_WHISPER_JSON_BYTES,
  parseWhisperOutputJson,
  type NormalizedWhisperOutput,
  WhisperOutputValidationError,
} from './whisper-output';
import { createWhisperProgressParser } from './whisper-progress';
import { alignTranscriptSpeakers } from './speaker-alignment';
import {
  runSpeakerDiarization,
  speakerDiarizationTimeoutMs,
  type RunSpeakerDiarizationOptions,
  type SpeakerDiarizationResult,
  type SpeakerDiarizationSegment,
} from './speaker-diarization';

const RUNNING_STAGES: ReadonlySet<TranscriptionStage> = new Set([
  'preparing',
  'normalizing',
  'transcribing',
  'saving',
]);
const WHISPER_VERSION = '1.9.1';
const MODEL_NAME = DEFAULT_TRANSCRIPTION_MODEL.id;

/** The saved engine record names the model actually used for the job. */
const transcriptionModelName = (modelPath: string): string =>
  /^ggml-(.+)\.bin$/u.exec(path.basename(modelPath))?.[1] ?? MODEL_NAME;
const MAX_WINDOWS_WHISPER_THREADS = 8;

export const resolveWindowsWhisperThreads = (parallelism: number): number => {
  const normalized = Number.isFinite(parallelism) ? Math.floor(parallelism) : 1;
  return Math.max(1, Math.min(MAX_WINDOWS_WHISPER_THREADS, normalized));
};

export class TranscriptionStartError extends Error {
  constructor(
    readonly code: Extract<TranscriptionErrorCode, 'busy' | 'engine-unavailable'>,
    message: string,
  ) {
    super(message);
    this.name = 'TranscriptionStartError';
  }
}

class PipelineError extends Error {
  constructor(
    readonly code: TranscriptionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}

export interface LocalTranscriptionServiceOptions {
  runtime: EngineRuntime;
  jobsRoot: string;
  repository: TranscriptRepository;
  onJobChanged: (job: TranscriptionJobSnapshot) => void;
  processRunner?: (options: RunProcessOptions) => Promise<ProcessResult>;
  speakerDiarizationRunner?: (
    options: RunSpeakerDiarizationOptions,
  ) => Promise<SpeakerDiarizationResult>;
  /** Test seams for the Windows-only thread policy. */
  platform?: NodeJS.Platform;
  availableParallelism?: number;
  playbackRepository?: PlaybackRepository;
  /**
   * Resolves the model and language for each new job, so settings changes
   * apply without restarting. Falls back to the bundled runtime model and
   * English when absent.
   */
  transcriptionOptions?: () =>
    | Promise<{ modelPath: string; language: string; customVocabulary?: string[] }>
    | { modelPath: string; language: string; customVocabulary?: string[] };
}

const snapshot = (job: TranscriptionJobSnapshot): TranscriptionJobSnapshot => ({
  ...job,
});

const titleFromMediaName = (name: string): string => {
  const title = path.parse(name).name.trim() || 'Untitled transcript';
  return title.slice(0, MAX_TRANSCRIPT_TITLE_CHARACTERS);
};

const isActiveStage = (stage: TranscriptionStage): boolean =>
  RUNNING_STAGES.has(stage);

const canRunSpeakerDiarization = (
  transcript: NormalizedWhisperOutput,
): boolean =>
  transcript.text.length > 0 &&
  transcript.segments.some((segment) => segment.text.length > 0) &&
  transcript.words.length > 0;

export class LocalTranscriptionService {
  private activeJob: TranscriptionJobSnapshot | null = null;
  private activeAbortController: AbortController | null = null;
  private activeTask: Promise<void> | null = null;

  constructor(private readonly options: LocalTranscriptionServiceOptions) {
    if (!path.isAbsolute(options.jobsRoot)) {
      throw new TypeError('The transcription jobs root must be absolute.');
    }
  }

  /**
   * Removes abandoned job directories and reports the source names of
   * imported-file jobs that were interrupted mid-run, so a crash never
   * discards an import invisibly. Interrupted live-recording jobs are
   * excluded — the recording repository already surfaces those with a
   * retry path.
   */
  async initialize(): Promise<string[]> {
    await mkdir(this.options.jobsRoot, { recursive: true, mode: 0o700 });
    await this.options.repository.cleanupTemporaryFiles();

    const entries = await readdir(this.options.jobsRoot, { withFileTypes: true });
    const interruptedImports: string[] = [];
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && isTranscriptId(entry.name))
        .map(async (entry) => {
          const directory = path.join(this.options.jobsRoot, entry.name);
          try {
            const marker = JSON.parse(
              await readFile(path.join(directory, 'job.json'), 'utf8'),
            ) as { kind?: unknown; sourceName?: unknown };
            if (
              marker.kind === 'import' &&
              typeof marker.sourceName === 'string' &&
              marker.sourceName.length > 0 &&
              marker.sourceName.length <= 300
            ) {
              interruptedImports.push(marker.sourceName);
            }
          } catch {
            // A job directory without a readable marker predates markers or
            // was corrupted; it is still removed below.
          }
          await rm(directory, { force: true, recursive: true });
        }),
    );
    return interruptedImports.sort();
  }

  getActiveJob(): TranscriptionJobSnapshot | null {
    return this.activeJob ? snapshot(this.activeJob) : null;
  }

  async start(
    media: SelectedMedia,
    expectedSpeakerCount: ExpectedSpeakerCount = null,
  ): Promise<TranscriptionJobSnapshot> {
    if (!isExpectedSpeakerCount(expectedSpeakerCount)) {
      throw new TypeError('Expected speaker count must be Auto or an integer from 1 to 12.');
    }
    if (this.activeJob && isActiveStage(this.activeJob.stage)) {
      throw new TranscriptionStartError('busy', 'Another recording is already being transcribed.');
    }

    // Terminal state is published before the job directory is removed. Wait
    // for that final cleanup so an immediate retry of the same durable
    // recording cannot collide with its previous derived files.
    await this.activeTask?.catch(() => undefined);
    if (this.activeJob && isActiveStage(this.activeJob.stage)) {
      throw new TranscriptionStartError('busy', 'Another recording is already being transcribed.');
    }

    if (media.recordingId && !isTranscriptId(media.recordingId)) {
      throw new TypeError('A linked recording id must be a UUID.');
    }
    if (media.transcriptId && !isTranscriptId(media.transcriptId)) {
      throw new TypeError('A re-transcription target id must be a UUID.');
    }
    const id =
      media.recordingId?.toLowerCase() ??
      media.transcriptId?.toLowerCase() ??
      createTranscriptId();
    const job: TranscriptionJobSnapshot = {
      id,
      sourceName: media.name,
      stage: 'preparing',
      progress: 0,
      startedAt: new Date().toISOString(),
      message: 'Inspecting the recording…',
      ...(media.recordingId ? { recordingId: media.recordingId.toLowerCase() } : {}),
    };
    const controller = new AbortController();
    this.activeJob = job;
    this.activeAbortController = controller;
    this.publish();

    this.activeTask = this.execute(
      job,
      media,
      expectedSpeakerCount,
      controller.signal,
    ).finally(() => {
      if (this.activeJob?.id === id) {
        this.activeAbortController = null;
      }
    });

    return snapshot(job);
  }

  cancel(jobId: string): boolean {
    if (
      this.activeJob?.id !== jobId ||
      !isActiveStage(this.activeJob.stage) ||
      !this.activeAbortController
    ) {
      return false;
    }

    this.update(this.activeJob.stage, this.activeJob.progress, 'Cancelling…');
    this.activeAbortController.abort();
    return true;
  }

  async dispose(): Promise<void> {
    this.activeAbortController?.abort();
    await this.activeTask?.catch(() => undefined);
  }

  private update(
    stage: TranscriptionStage,
    progress: number,
    message: string,
    extra: Partial<TranscriptionJobSnapshot> = {},
  ): void {
    if (!this.activeJob) return;
    this.activeJob = {
      ...this.activeJob,
      ...extra,
      stage,
      progress: Math.min(1, Math.max(0, progress)),
      message,
    };
    this.publish();
  }

  private publish(): void {
    if (this.activeJob) this.options.onJobChanged(snapshot(this.activeJob));
  }

  private async execute(
    job: TranscriptionJobSnapshot,
    media: SelectedMedia,
    expectedSpeakerCount: ExpectedSpeakerCount,
    signal: AbortSignal,
  ): Promise<void> {
    const jobDirectory = path.join(this.options.jobsRoot, job.id);
    const normalizedPath = path.join(jobDirectory, 'normalized.wav');
    const outputPrefix = path.join(jobDirectory, 'transcript');
    const outputJsonPath = `${outputPrefix}.json`;

    try {
      await mkdir(jobDirectory, { recursive: false, mode: 0o700 });
      // The marker lets the next launch tell the user which import a crash
      // interrupted; the file name is the only detail recorded. Live
      // recordings carry their own recovery metadata instead.
      await writeFile(
        path.join(jobDirectory, 'job.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          kind: media.recordingId ? 'recording' : 'import',
          sourceName: media.name,
        })}\n`,
        { mode: 0o600 },
      ).catch(() => undefined);
      const probe = await probeMedia({
        ffmpegPath: this.options.runtime.ffmpegPath,
        inputPath: media.path,
        signal,
        processRunner: this.options.processRunner,
      });

      this.update('normalizing', 0.05, 'Preparing a private audio copy…');
      const normalizedDurationSeconds = await normalizeMediaToWav({
        ffmpegPath: this.options.runtime.ffmpegPath,
        inputPath: media.path,
        outputPath: normalizedPath,
        durationSeconds: probe.durationSeconds,
        signal,
        processRunner: this.options.processRunner,
        onProgress: (progress) => {
          this.update(
            'normalizing',
            0.05 + progress * 0.15,
            'Preparing a private audio copy…',
          );
        },
      });

      this.update('transcribing', 0.2, 'Running the local speech model…');
      const transcription = (await this.options.transcriptionOptions?.()) ?? {
        modelPath: this.options.runtime.modelPath,
        language: 'en',
      };
      await this.runWhisper(
        normalizedPath,
        outputPrefix,
        outputJsonPath,
        signal,
        transcription,
      );

      const outputStats = await stat(outputJsonPath);
      if (!outputStats.isFile() || outputStats.size > MAX_WHISPER_JSON_BYTES) {
        throw new PipelineError('invalid-output', 'The transcription output was invalid.');
      }

      const normalized = parseWhisperOutputJson(await readFile(outputJsonPath, 'utf8'));
      let diarization: SpeakerDiarizationSegment[] = [];
      const speakerRuntime = this.options.runtime.speakerDiarization;
      if (speakerRuntime && canRunSpeakerDiarization(normalized)) {
        this.update('transcribing', 0.92, 'Separating speakers locally…');
        try {
          const diarizationResult = await (
            this.options.speakerDiarizationRunner ?? runSpeakerDiarization
          )({
            wavPath: normalizedPath,
            childPath: speakerRuntime.childPath,
            segmentationModelPath: speakerRuntime.segmentationModelPath,
            embeddingModelPath: speakerRuntime.embeddingModelPath,
            modulePath: speakerRuntime.modulePath,
            expectedSpeakerCount,
            timeoutMs: speakerDiarizationTimeoutMs(
              normalizedDurationSeconds ?? null,
            ),
            signal,
          });
          diarization = diarizationResult.segments;
          // Diagnostic only: an internally inconsistent cluster is the
          // known signature of mixed-voice audio (see the speaker-accuracy
          // experiments). Labels are unchanged today; this log builds the
          // evidence base for a future bounded recovery step.
          for (const consistency of diarizationResult.clusterConsistency ?? []) {
            if (
              consistency.pairCount > 0 &&
              consistency.medianSimilarity !== null &&
              consistency.medianSimilarity < 0.4
            ) {
              console.warn(
                `[sotto] Speaker cluster ${consistency.cluster} shows low internal consistency (median ${consistency.medianSimilarity.toFixed(3)} across ${consistency.pairCount} pairs). Labels are unchanged; diagnostic only.`,
              );
            }
          }
        } catch (error) {
          if (signal.aborted) throw error;
          console.warn(
            '[sotto] Speaker separation was unavailable:',
            error instanceof Error ? error.message : 'Unknown speaker engine error',
          );
          // Speaker separation is an enhancement. Preserve the useful text
          // transcript if an unusual recording defeats the clustering model.
          diarization = [];
        }
      }
      if (diarization.length > 0) {
        this.update('transcribing', 0.95, 'Finishing speaker labels locally…');
      }
      const aligned = alignTranscriptSpeakers(
        normalized.segments,
        normalized.words,
        diarization,
      );

      this.update('saving', 0.96, 'Saving the transcript on this device…');
      const durationMs = Math.max(
        normalized.durationMs,
        Math.round((probe.durationSeconds ?? 0) * 1_000),
        Math.round((normalizedDurationSeconds ?? 0) * 1_000),
      );
      const completedAt = new Date().toISOString();
      // A job that reuses an existing transcript id replaces its content in
      // place; the user's title, tags, and original creation date survive.
      const existingRecord = await this.options.repository.get(job.id);
      const record: TranscriptRecord = {
        schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
        id: job.id,
        title: existingRecord?.title ?? titleFromMediaName(media.name),
        tags: existingRecord ? [...existingRecord.tags] : [],
        createdAt: existingRecord?.createdAt ?? job.startedAt,
        completedAt,
        ...(media.recordingId ? { recordingId: media.recordingId } : {}),
        ...(media.markers?.length ? { markers: media.markers.map((marker) => ({ ...marker })) } : {}),
        source: {
          type: media.sourceType ?? 'imported-file',
          name: media.name,
          mediaKind: media.mediaKind,
          sizeBytes: media.sizeBytes,
        },
        durationMs,
        language: normalized.language ?? 'en',
        engine: {
          name: 'whisper.cpp',
          model: transcriptionModelName(transcription.modelPath),
          version: WHISPER_VERSION,
        },
        speakerAnalysis: aligned.speakerAnalysis,
        ...(aligned.diagnostics
          ? { speakerDiagnostics: aligned.diagnostics }
          : {}),
        text: normalized.text,
        segments: aligned.segments,
        localAiMeetingSummary: null,
      };
      let retainedPlayback = false;
      try {
        if (
          record.source.type === 'imported-file' &&
          this.options.playbackRepository
        ) {
          await this.options.playbackRepository.retain(record.id, normalizedPath);
          retainedPlayback = true;
        }
        await this.options.repository.save(record);
      } catch {
        if (retainedPlayback) {
          await this.options.playbackRepository?.delete(record.id).catch(() => undefined);
        }
        throw new PipelineError(
          'storage-failed',
          'The transcript was created, but Sotto could not save it locally.',
        );
      }

      this.update(
        'completed',
        1,
        media.recordingId
          ? 'Transcript saved. The original recording is still available.'
          : 'Saved locally and ready to read.',
        {
          transcriptId: record.id,
        },
      );
    } catch (error) {
      if (signal.aborted || error instanceof ProcessAbortedError) {
        this.update(
          'cancelled',
          0,
          media.recordingId
            ? 'No transcript was saved. The original recording is still available.'
            : 'No transcript was saved.',
        );
      } else {
        const failure = this.mapFailure(error);
        this.update('failed', 0, failure.message, { errorCode: failure.code });
      }
    } finally {
      await rm(jobDirectory, { force: true, recursive: true }).catch(() => undefined);
      if (media.cleanupAfterTranscription) {
        await rm(media.path, { force: true }).catch(() => undefined);
        await rm(path.dirname(media.path), { force: true, recursive: true }).catch(
          () => undefined,
        );
      }
    }
  }

  private async runWhisper(
    normalizedPath: string,
    outputPrefix: string,
    outputJsonPath: string,
    signal: AbortSignal,
    transcription: { modelPath: string; language: string; customVocabulary?: string[] },
  ): Promise<void> {
    const platform = this.options.platform ?? process.platform;
    const threadArgs =
      platform === 'win32'
        ? [
            '--threads',
            String(
              resolveWindowsWhisperThreads(
                this.options.availableParallelism ?? readAvailableParallelism(),
              ),
            ),
          ]
        : [];
    const baseArgs = [
      ...threadArgs,
      '--model',
      transcription.modelPath,
      '--file',
      normalizedPath,
      '--language',
      transcription.language,
      '--output-json-full',
      '--output-file',
      outputPrefix,
      '--print-progress',
      '--no-prints',
    ];
    const vocabulary = transcription.customVocabulary?.join(', ');
    if (vocabulary) {
      // whisper.cpp treats --prompt as a local initial vocabulary hint. It is
      // only an input to the on-device speech process and is never attached
      // to transcript exports or Local AI requests.
      baseArgs.push('--prompt', vocabulary);
    }

    const invoke = async (extraArgs: string[] = []) => {
      const progressParser = createWhisperProgressParser((progress) => {
        this.update(
          'transcribing',
          0.2 + (progress / 100) * 0.72,
          extraArgs.includes('--no-gpu')
            ? 'Transcribing locally with the CPU…'
            : 'Transcribing locally with whisper.cpp…',
        );
      });

      try {
        const result = await (this.options.processRunner ?? runProcess)({
          executable: this.options.runtime.whisperPath,
          args: [...baseArgs, ...extraArgs],
          maxDiagnosticBytes: 256 * 1_024,
          signal,
          onStderr: (chunk) => progressParser.push(chunk),
        });
        progressParser.end();
        return result;
      } catch (error) {
        progressParser.end();
        throw error;
      }
    };

    let result = await invoke();
    const metalFailure =
      result.exitCode === 139 ||
      result.signal === 'SIGSEGV' ||
      /ggml_metal|metal.*(?:failed|error)/iu.test(result.stderr);
    if (result.exitCode !== 0 && metalFailure && !signal.aborted) {
      await unlink(outputJsonPath).catch(() => undefined);
      this.update('transcribing', 0.2, 'Metal was unavailable; continuing on the CPU…');
      result = await invoke(['--no-gpu']);
    }

    if (result.exitCode !== 0) {
      throw new PipelineError(
        'transcription-failed',
        'The local transcription engine could not process this recording.',
      );
    }
  }

  private mapFailure(error: unknown): PipelineError {
    if (error instanceof PipelineError) return error;
    if (error instanceof MediaProbeError) {
      return new PipelineError(
        error.code === 'no-audio-stream' ? 'no-audio' : 'invalid-media',
        error.message,
      );
    }
    if (error instanceof MediaNormalizationError) {
      return new PipelineError('normalization-failed', error.message);
    }
    if (error instanceof WhisperOutputValidationError) {
      return new PipelineError(
        'invalid-output',
        'The local engine returned an unreadable transcript.',
      );
    }

    return new PipelineError(
      'transcription-failed',
      'Sotto could not finish this transcript. The original recording was not changed.',
    );
  }
}
