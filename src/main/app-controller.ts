import path from 'node:path';

import type {
  AppState,
  AppendLiveRecordingChunkResult,
  LiveRecordingCapability,
  LiveRecordingSnapshot,
  SavedRecordingSummary,
  EngineStatus as RendererEngineStatus,
  TranscriptDetail,
  TranscriptSegment as RendererTranscriptSegment,
  TranscriptSummary,
  TranscriptionJobSnapshot,
} from '../shared/contracts';
import type { SelectedMedia } from './media/media-import';
import {
  LiveRecordingError,
  LiveRecordingService,
} from './recording/live-recording-service';
import type { EngineStatus as RuntimeStatus } from './runtime/engine-runtime';
import { TranscriptRepository } from './storage/transcript-repository';
import {
  LocalTranscriptionService,
  TranscriptionStartError,
} from './transcription/transcription-service';
import type { TranscriptRecord } from './transcription/transcript-types';

type StateListener = (state: AppState) => void;

const isRunningTranscriptionStage = (
  stage: TranscriptionJobSnapshot['stage'],
): boolean =>
  ['preparing', 'normalizing', 'transcribing', 'saving'].includes(stage);

const toRendererEngineStatus = (runtime: RuntimeStatus): RendererEngineStatus => {
  if (runtime.ready) {
    return {
      state: 'ready',
      engineVersion: '1.9.1',
      modelName: 'small.en',
      message: 'The private local transcription engine is ready.',
    };
  }

  return {
    state: 'unavailable',
    engineVersion: null,
    modelName: null,
    message:
      runtime.reason === 'unsupported-platform'
        ? 'This Sotto build does not include a transcription engine for this computer yet.'
        : 'The local transcription runtime is incomplete. Run the platform runtime setup before starting Sotto.',
  };
};

const previewFor = (text: string): string => {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  return normalized.length > 150 ? `${normalized.slice(0, 147)}…` : normalized;
};

export const toTranscriptSummary = (record: TranscriptRecord): TranscriptSummary => ({
  id: record.id,
  title: record.title,
  sourceName: record.source.name,
  createdAt: record.createdAt,
  durationMs: record.durationMs,
  language: record.language ?? 'unknown',
  preview: previewFor(record.text),
});

export const toTranscriptDetail = (record: TranscriptRecord): TranscriptDetail => ({
  ...toTranscriptSummary(record),
  completedAt: record.completedAt,
  text: record.text,
  segments: record.segments.map(
    (segment): RendererTranscriptSegment => ({ ...segment }),
  ),
  engine: { ...record.engine },
});

const formatTimestamp = (milliseconds: number): string => {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
};

export const formatTranscriptForExport = (record: TranscriptRecord): string => {
  const lines = [
    record.title,
    `Completed: ${record.completedAt}`,
    `Duration: ${formatTimestamp(record.durationMs)}`,
    `Language: ${record.language ?? 'unknown'}`,
    '',
  ];

  if (record.segments.length === 0) {
    lines.push(record.text || 'No speech was detected.');
  } else {
    for (const segment of record.segments) {
      lines.push(`[${formatTimestamp(segment.startMs)}] ${segment.text}`);
    }
  }

  return `${lines.join('\n')}\n`;
};

export class AppController {
  private readonly listeners = new Set<StateListener>();
  private readonly service: LocalTranscriptionService | null;
  private readonly recordingService: LiveRecordingService;
  private readonly recordingCapability: LiveRecordingCapability;
  private activeJob: TranscriptionJobSnapshot | null = null;
  private activeRecording: LiveRecordingSnapshot | null = null;
  private recordings: SavedRecordingSummary[] = [];
  private recordingStorageMessage: string | null = null;
  private recordingUpdateChain: Promise<void> = Promise.resolve();
  private transcripts: TranscriptRecord[] = [];

  constructor(
    private readonly repository: TranscriptRepository,
    runtimeStatus: RuntimeStatus,
    jobsRoot: string,
    recordingCapability: LiveRecordingCapability = {
      state: 'unsupported',
      message: 'Live meeting capture is not available in this build.',
    },
  ) {
    this.engineStatus = toRendererEngineStatus(runtimeStatus);
    this.recordingCapability = { ...recordingCapability };
    this.recordingService = new LiveRecordingService({
      recordingsRoot: path.join(path.dirname(jobsRoot), 'recordings'),
      onRecordingChanged: (recording) => this.handleRecordingChanged(recording),
    });
    this.service = runtimeStatus.ready
      ? new LocalTranscriptionService({
          runtime: runtimeStatus.runtime,
          jobsRoot,
          repository,
          onJobChanged: (job) => this.handleJobChanged(job),
        })
      : null;
  }

  private readonly engineStatus: RendererEngineStatus;

  async initialize(): Promise<void> {
    await this.repository.cleanupTemporaryFiles();
    await this.service?.initialize();
    await this.recordingService.initialize();
    await this.reloadTranscripts();
    try {
      await this.recordingService.reconcileTranscripts(
        new Set(
          this.transcripts
            .filter((record) => record.source.type === 'recording')
            .map((record) => record.recordingId ?? record.id),
        ),
      );
    } catch (error) {
      this.recordingStorageMessage =
        error instanceof Error
          ? error.message
          : 'Sotto could not recover a saved recording status.';
    }
    await this.reloadRecordings();
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): AppState {
    return {
      engine: { ...this.engineStatus },
      recording: {
        capability: { ...this.recordingCapability },
        active: this.activeRecording ? { ...this.activeRecording } : null,
        storageMessage: this.recordingStorageMessage,
      },
      activeJob: this.activeJob ? { ...this.activeJob } : null,
      recordings: this.recordings.map((recording) => ({ ...recording })),
      transcripts: this.transcripts.map(toTranscriptSummary),
    };
  }

  async startTranscription(media: SelectedMedia): Promise<TranscriptionJobSnapshot> {
    if (!this.service) {
      throw new TranscriptionStartError(
        'engine-unavailable',
        this.engineStatus.message,
      );
    }

    return this.service.start(media);
  }

  async startLiveRecording(): Promise<LiveRecordingSnapshot> {
    if (this.recordingCapability.state !== 'ready') {
      throw new LiveRecordingError(
        'unsupported-platform',
        this.recordingCapability.message,
      );
    }
    if (!this.service) {
      throw new LiveRecordingError(
        'engine-unavailable',
        this.engineStatus.message,
      );
    }
    if (this.activeJob && isRunningTranscriptionStage(this.activeJob.stage)) {
      throw new LiveRecordingError(
        'busy',
        'Wait for the current transcription to finish before recording another meeting.',
      );
    }
    return this.recordingService.start();
  }

  appendLiveRecordingChunk(
    recordingId: string,
    chunk: Uint8Array,
  ): Promise<AppendLiveRecordingChunkResult> {
    return this.recordingService.append(recordingId, chunk);
  }

  async finishLiveRecording(recordingId: string): Promise<TranscriptionJobSnapshot> {
    const media = await this.recordingService.finish(recordingId);
    await this.reloadRecordings();
    this.emit();
    return this.startRecordingTranscription(recordingId, media);
  }

  cancelLiveRecording(recordingId: string): Promise<boolean> {
    return this.recordingService.cancel(recordingId);
  }

  async retryRecording(
    recordingId: string,
  ): Promise<TranscriptionJobSnapshot | null> {
    await this.recordingUpdateChain;
    const saved = (await this.recordingService.listSavedRecordings())
      .find((recording) => recording.id === recordingId.toLowerCase());
    if (!saved) return null;
    if (
      saved.transcriptionState === 'completed' &&
      saved.transcriptId
    ) {
      throw new TranscriptionStartError(
        'busy',
        'This recording already has a transcript. Delete the transcript before transcribing it again.',
      );
    }

    const media = await this.recordingService.getMediaForTranscription(recordingId);
    return media
      ? this.startRecordingTranscription(recordingId, media)
      : null;
  }

  cancelTranscription(jobId: string): boolean {
    return this.service?.cancel(jobId) ?? false;
  }

  async getTranscript(id: string): Promise<TranscriptDetail | null> {
    const record = await this.repository.get(id);
    if (!record) return null;
    const detail = toTranscriptDetail(record);
    const recordingId = record.recordingId ?? record.id;
    return record.source.type === 'recording' &&
      (await this.recordingService.has(recordingId))
      ? { ...detail, recordingId }
      : detail;
  }

  async getTranscriptExport(id: string): Promise<{ title: string; text: string } | null> {
    const record = await this.repository.get(id);
    return record
      ? { title: record.title, text: formatTranscriptForExport(record) }
      : null;
  }

  async deleteTranscript(id: string): Promise<boolean> {
    const record = await this.repository.get(id);
    const deleted = await this.repository.delete(id);
    if (deleted) {
      const recordingId =
        record?.source.type === 'recording'
          ? record.recordingId ?? record.id
          : null;
      if (recordingId && (await this.recordingService.has(recordingId))) {
        try {
          await this.recordingService.markReady(
            recordingId,
            'The transcript was deleted. The original recording is ready to transcribe again.',
          );
          this.recordingStorageMessage = null;
        } catch (error) {
          this.recordingStorageMessage =
            error instanceof Error ? error.message : 'Sotto could not update the recording status.';
        }
        await this.reloadRecordings();
      }
      await this.reloadTranscripts();
      this.emit();
    }
    return deleted;
  }

  getRecordingExport(
    recordingId: string,
  ): Promise<{ fileName: string; path: string } | null> {
    return this.recordingService.getExportDescriptor(recordingId);
  }

  async deleteRecording(recordingId: string): Promise<boolean> {
    const saved = await this.recordingService.getSavedRecording(recordingId);
    if (
      saved?.transcription.state === 'transcribing' ||
      (
        this.activeJob?.recordingId === recordingId.toLowerCase() &&
        isRunningTranscriptionStage(this.activeJob.stage)
      )
    ) {
      throw new LiveRecordingError(
        'busy',
        'Cancel transcription before deleting its original recording.',
      );
    }
    const deleted = await this.recordingService.delete(recordingId);
    if (deleted) {
      await this.reloadRecordings();
      this.emit();
    }
    return deleted;
  }

  async dispose(): Promise<void> {
    await this.recordingService.dispose();
    await this.service?.dispose();
    await this.recordingUpdateChain;
    this.listeners.clear();
  }

  private handleJobChanged(job: TranscriptionJobSnapshot): void {
    this.activeJob = { ...job };
    this.emit();

    if (
      job.recordingId &&
      ['completed', 'failed', 'cancelled'].includes(job.stage)
    ) {
      this.queueRecordingUpdate(async () => {
        if (job.stage === 'completed' && job.transcriptId) {
          await this.recordingService.markTranscriptionCompleted(
            job.recordingId as string,
            job.id,
            job.transcriptId,
          );
        } else if (job.stage === 'failed') {
          await this.recordingService.markTranscriptionFailed(
            job.recordingId as string,
            job.id,
            job.errorCode ?? 'transcription-failed',
            job.message,
          );
        } else if (job.stage === 'cancelled') {
          await this.recordingService.markTranscriptionCancelled(
            job.recordingId as string,
            job.id,
          );
        }
        this.recordingStorageMessage = null;
        await this.reloadRecordings();
        this.emit();
      });
    }

    if (job.stage === 'completed') {
      void this.reloadTranscripts()
        .then(() => this.emit())
        .catch(() => undefined);
    }
  }

  private handleRecordingChanged(recording: LiveRecordingSnapshot | null): void {
    this.activeRecording = recording ? { ...recording } : null;
    this.emit();
  }

  private async reloadTranscripts(): Promise<void> {
    this.transcripts = await this.repository.list();
  }

  private async reloadRecordings(): Promise<void> {
    this.recordings = await this.recordingService.listSavedRecordings();
  }

  private async startRecordingTranscription(
    recordingId: string,
    media: SelectedMedia,
  ): Promise<TranscriptionJobSnapshot> {
    if (!this.service) {
      throw new TranscriptionStartError(
        'engine-unavailable',
        this.engineStatus.message,
      );
    }
    if (this.activeJob && isRunningTranscriptionStage(this.activeJob.stage)) {
      throw new TranscriptionStartError(
        'busy',
        'Another recording is already being transcribed.',
      );
    }

    await this.recordingService.markTranscribing(recordingId, recordingId);
    await this.reloadRecordings();
    this.emit();
    try {
      return await this.service.start(media);
    } catch (error) {
      const code =
        error instanceof TranscriptionStartError
          ? error.code
          : 'transcription-failed';
      const message =
        error instanceof Error
          ? error.message
          : 'Sotto could not start transcription.';
      await this.recordingService.markTranscriptionFailed(
        recordingId,
        recordingId,
        code,
        message,
      );
      await this.reloadRecordings();
      this.emit();
      throw error;
    }
  }

  private queueRecordingUpdate(update: () => Promise<void>): void {
    const next = this.recordingUpdateChain.then(update, update);
    this.recordingUpdateChain = next.catch((error: unknown) => {
      this.recordingStorageMessage =
        error instanceof Error
          ? error.message
          : 'Sotto could not save the recording status.';
      this.reloadRecordings()
        .then(() => this.emit())
        .catch(() => undefined);
    });
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}
