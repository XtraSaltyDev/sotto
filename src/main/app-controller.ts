import path from 'node:path';

import type {
  AppState,
  AppendLiveRecordingChunkResult,
  LiveRecordingCapability,
  LiveRecordingSnapshot,
  RecordingKind,
  SavedRecordingSummary,
  EngineStatus as RendererEngineStatus,
  TranscriptDetail,
  TranscriptSegment as RendererTranscriptSegment,
  TranscriptSummary,
  RenameTranscriptSpeakerResult,
  UpdateTranscriptSegmentResult,
  TranscriptExportFormat,
  TranscriptionJobSnapshot,
} from '../shared/contracts';
import type { SelectedMedia } from './media/media-import';
import {
  LiveRecordingError,
  LiveRecordingService,
} from './recording/live-recording-service';
import type { EngineStatus as RuntimeStatus } from './runtime/engine-runtime';
import { TranscriptRepository } from './storage/transcript-repository';
import { PlaybackRepository } from './storage/playback-repository';
import {
  LocalTranscriptionService,
  TranscriptionStartError,
} from './transcription/transcription-service';
import type { TranscriptRecord } from './transcription/transcript-types';
import { TranscriptValidationError } from './transcription/transcript-types';
import { createTranscriptDocx } from './export/transcript-docx';
import { buildMeetingSummary } from './summarization/meeting-summary';
import { MAX_RELIABLE_AUTOMATIC_SPEAKERS } from './transcription/speaker-alignment';

type StateListener = (state: AppState) => void;
export type LiveRecordingCapabilitySource =
  | LiveRecordingCapability
  | (() => LiveRecordingCapability);

const DEFAULT_RECORDING_CAPABILITY: LiveRecordingCapability = {
  state: 'unsupported',
  message: 'Live meeting capture is not available in this build.',
};

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

const withReliableSpeakerPresentation = (
  record: TranscriptRecord,
): TranscriptRecord =>
  (record.speakerAnalysis?.speakers.length ?? 0) >
  MAX_RELIABLE_AUTOMATIC_SPEAKERS
    ? {
        ...record,
        speakerAnalysis: null,
        segments: record.segments.map((segment) => ({
          ...segment,
          speakerId: null,
        })),
      }
    : record;

export const toTranscriptDetail = (record: TranscriptRecord): TranscriptDetail => {
  const presented = withReliableSpeakerPresentation(record);
  return {
    ...toTranscriptSummary(presented),
    completedAt: presented.completedAt,
    text: presented.text,
    segments: presented.segments.map(
      (segment): RendererTranscriptSegment => ({
        ...segment,
        words: segment.words.map((word) => ({ ...word })),
      }),
    ),
    meetingSummary: buildMeetingSummary(presented),
    playback: { state: 'unavailable', reason: 'not-retained' },
    speakerAnalysis: presented.speakerAnalysis
      ? {
          engine: { ...presented.speakerAnalysis.engine },
          speakers: presented.speakerAnalysis.speakers.map((speaker) => ({
            ...speaker,
          })),
        }
      : null,
    engine: { ...presented.engine },
  };
};

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
  const presented = withReliableSpeakerPresentation(record);
  const meetingSummary = buildMeetingSummary(presented);
  const speakerLabels = new Map(
    presented.speakerAnalysis?.speakers.map((speaker) => [speaker.id, speaker.label]) ?? [],
  );
  const lines = [
    presented.title,
    `Completed: ${presented.completedAt}`,
    `Duration: ${formatTimestamp(presented.durationMs)}`,
    `Language: ${presented.language ?? 'unknown'}`,
    '',
  ];

  if (meetingSummary) {
    const addSummaryItems = (
      title: string,
      items: typeof meetingSummary.keyPoints,
    ): void => {
      if (items.length === 0) return;
      lines.push(title);
      for (const item of items) {
        const speaker = item.speakerId ? speakerLabels.get(item.speakerId) : null;
        lines.push(
          `- [${formatTimestamp(item.startMs)}] ${speaker ? `${speaker}: ` : ''}${item.text}`,
        );
      }
      lines.push('');
    };
    lines.push('MEETING SUMMARY', meetingSummary.overview, '');
    addSummaryItems('Key points', meetingSummary.keyPoints);
    addSummaryItems('Decisions', meetingSummary.decisions);
    addSummaryItems('Action items', meetingSummary.actionItems);
    lines.push('TRANSCRIPT', '');
  }

  if (presented.segments.length === 0) {
    lines.push(presented.text || 'No speech was detected.');
  } else {
    const hasSpeakerAnalysis = presented.speakerAnalysis !== null;
    for (const segment of presented.segments) {
      const speakerLabel = segment.speakerId
        ? speakerLabels.get(segment.speakerId)
        : null;
      const speakerPrefix = hasSpeakerAnalysis
        ? `${speakerLabel ?? 'Unclear'}: `
        : '';
      lines.push(
        `[${formatTimestamp(segment.startMs)}] ${speakerPrefix}${segment.text}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
};

export class AppController {
  private readonly listeners = new Set<StateListener>();
  private readonly service: LocalTranscriptionService | null;
  private readonly recordingService: LiveRecordingService;
  private readonly playbackRepository: PlaybackRepository;
  private readonly recordingCapabilityProvider: () => LiveRecordingCapability;
  private recordingCapability: LiveRecordingCapability;
  private activeJob: TranscriptionJobSnapshot | null = null;
  private activeRecording: LiveRecordingSnapshot | null = null;
  private finalizingRecordingId: string | null = null;
  private recordings: SavedRecordingSummary[] = [];
  private recordingStorageMessage: string | null = null;
  private recordingUpdateChain: Promise<void> = Promise.resolve();
  private transcriptionStartPending = false;
  private transcriptReloadChain: Promise<void> = Promise.resolve();
  private transcriptSummaries: TranscriptSummary[] = [];
  private recordingTranscriptIds = new Set<string>();

  constructor(
    private readonly repository: TranscriptRepository,
    runtimeStatus: RuntimeStatus,
    jobsRoot: string,
    recordingCapability: LiveRecordingCapabilitySource =
      DEFAULT_RECORDING_CAPABILITY,
  ) {
    this.engineStatus = toRendererEngineStatus(runtimeStatus);
    if (typeof recordingCapability === 'function') {
      this.recordingCapabilityProvider = recordingCapability;
    } else {
      const fixedCapability = { ...recordingCapability };
      this.recordingCapabilityProvider = () => fixedCapability;
    }
    this.recordingCapability = this.readRecordingCapability();
    this.recordingService = new LiveRecordingService({
      recordingsRoot: path.join(path.dirname(jobsRoot), 'recordings'),
      onRecordingChanged: (recording) => this.handleRecordingChanged(recording),
    });
    this.playbackRepository = new PlaybackRepository(
      path.join(path.dirname(jobsRoot), 'playback'),
    );
    this.service = runtimeStatus.ready
      ? new LocalTranscriptionService({
          runtime: runtimeStatus.runtime,
          jobsRoot,
          repository,
          playbackRepository: this.playbackRepository,
          onJobChanged: (job) => this.handleJobChanged(job),
        })
      : null;
  }

  private readonly engineStatus: RendererEngineStatus;

  async initialize(): Promise<void> {
    await this.repository.cleanupTemporaryFiles();
    await this.playbackRepository.initialize();
    await this.service?.initialize();
    await this.recordingService.initialize();
    await this.reloadTranscripts();
    await this.playbackRepository.cleanupOrphans(
      new Set(this.transcriptSummaries.map((transcript) => transcript.id)),
    );
    try {
      await this.recordingService.reconcileTranscripts(
        this.recordingTranscriptIds,
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
    this.refreshRecordingCapability();
    return {
      engine: { ...this.engineStatus },
      recording: {
        capability: { ...this.recordingCapability },
        active: this.activeRecording ? { ...this.activeRecording } : null,
        storageMessage: this.recordingStorageMessage,
      },
      activeJob: this.activeJob ? { ...this.activeJob } : null,
      recordings: this.recordings.map((recording) => ({ ...recording })),
      transcripts: this.transcriptSummaries.map((transcript) => ({ ...transcript })),
    };
  }

  async startTranscription(media: SelectedMedia): Promise<TranscriptionJobSnapshot> {
    const service = this.service;
    if (!service) {
      throw new TranscriptionStartError(
        'engine-unavailable',
        this.engineStatus.message,
      );
    }

    return this.runTranscriptionStart(() => service.start(media));
  }

  async startLiveRecording(
    kind: RecordingKind = 'meeting',
  ): Promise<LiveRecordingSnapshot> {
    if (kind !== 'meeting' && kind !== 'dictation') {
      throw new TypeError('Recording kind is not supported.');
    }
    this.refreshRecordingCapability();
    if (
      kind === 'meeting' &&
      this.recordingCapability.state !== 'ready' &&
      this.recordingCapability.state !== 'setup-required'
    ) {
      throw new LiveRecordingError(
        this.recordingCapability.state === 'permission-required'
          ? 'permission-denied'
          : 'unsupported-platform',
        this.recordingCapability.message,
      );
    }
    if (!this.service) {
      throw new LiveRecordingError(
        'engine-unavailable',
        this.engineStatus.message,
      );
    }
    if (
      this.finalizingRecordingId !== null ||
      this.transcriptionStartPending ||
      (this.activeJob && isRunningTranscriptionStage(this.activeJob.stage))
    ) {
      throw new LiveRecordingError(
        'busy',
        'Wait for the current transcription to finish before recording another meeting.',
      );
    }
    return this.recordingService.start(kind);
  }

  appendLiveRecordingChunk(
    recordingId: string,
    chunk: Uint8Array,
  ): Promise<AppendLiveRecordingChunkResult> {
    return this.recordingService.append(recordingId, chunk);
  }

  async finishLiveRecording(recordingId: string): Promise<TranscriptionJobSnapshot> {
    if (this.finalizingRecordingId !== null) {
      throw new LiveRecordingError(
        'busy',
        'The live recording is already being finalized.',
      );
    }

    const normalizedRecordingId = recordingId.toLowerCase();
    this.finalizingRecordingId = normalizedRecordingId;
    try {
      const media = await this.recordingService.finish(recordingId);
      await this.reloadRecordings();
      if (this.activeRecording?.id === normalizedRecordingId) {
        this.activeRecording = null;
      }
      this.emit();
      return await this.startRecordingTranscription(
        normalizedRecordingId,
        media,
        true,
      );
    } finally {
      this.finalizingRecordingId = null;
      if (
        !this.recordingService.getActive() &&
        this.activeRecording?.id === normalizedRecordingId
      ) {
        this.activeRecording = null;
        this.emit();
      }
    }
  }

  cancelLiveRecording(recordingId: string): Promise<boolean> {
    return this.recordingService.cancel(recordingId);
  }

  async retryRecording(
    recordingId: string,
  ): Promise<TranscriptionJobSnapshot | null> {
    this.assertNoLiveRecordingForTranscription();
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
    if (record.source.type === 'recording') {
      const recording = await this.recordingService.getExportDescriptor(recordingId);
      return recording
        ? {
            ...detail,
            recordingId,
            playback: {
              state: 'available',
              kind: 'live-recording',
              sizeBytes: recording.sizeBytes,
              url: `sotto-media://playback/${record.id}`,
            },
          }
        : { ...detail, playback: { state: 'unavailable', reason: 'missing' } };
    }
    const playback = await this.playbackRepository.get(record.id);
    return playback
      ? {
          ...detail,
          playback: {
            state: 'available',
            kind: 'imported-audio-copy',
            sizeBytes: playback.sizeBytes,
            url: `sotto-media://playback/${record.id}`,
          },
        }
      : { ...detail, playback: { state: 'unavailable', reason: 'missing' } };
  }

  async getPlaybackDescriptor(
    transcriptId: string,
  ): Promise<{ path: string; mimeType: string; sizeBytes: number } | null> {
    const record = await this.repository.get(transcriptId);
    if (!record) return null;
    if (record.source.type === 'recording') {
      const recordingId = record.recordingId ?? record.id;
      const descriptor = await this.recordingService.getExportDescriptor(recordingId);
      if (!descriptor) return null;
      return {
        path: descriptor.path,
        mimeType: 'audio/webm; codecs=opus',
        sizeBytes: descriptor.sizeBytes,
      };
    }
    const descriptor = await this.playbackRepository.get(record.id);
    return descriptor
      ? { ...descriptor, mimeType: 'audio/wav' }
      : null;
  }

  async deletePlayback(transcriptId: string): Promise<boolean> {
    const record = await this.repository.get(transcriptId);
    if (!record) return false;
    if (record.source.type === 'recording') {
      return this.deleteRecording(record.recordingId ?? record.id);
    }
    return this.playbackRepository.delete(record.id);
  }

  async getTranscriptExport(
    id: string,
    format: TranscriptExportFormat,
  ): Promise<{ title: string; content: string | Buffer } | null> {
    const record = await this.repository.getAfterPendingMutations(id);
    if (!record) return null;
    const presented = withReliableSpeakerPresentation(record);
    return {
      title: presented.title,
      content:
        format === 'docx'
          ? await createTranscriptDocx(
              presented,
              buildMeetingSummary(presented),
            )
          : formatTranscriptForExport(presented),
    };
  }

  async renameTranscriptSpeaker(
    transcriptId: string,
    speakerId: string,
    label: string,
  ): Promise<RenameTranscriptSpeakerResult> {
    try {
      const result = await this.repository.renameSpeakerLabel(
        transcriptId,
        speakerId,
        label,
      );
      if (result.outcome === 'not-found') return result;
      await this.reloadTranscripts();
      this.emit();
      return { outcome: 'renamed', speaker: { ...result.speaker } };
    } catch (error) {
      return {
        outcome: 'rejected',
        reason:
          error instanceof TranscriptValidationError
            ? error.message
            : 'Sotto could not rename that speaker.',
      };
    }
  }

  async updateTranscriptSegment(
    transcriptId: string,
    segmentIndex: number,
    text: string,
  ): Promise<UpdateTranscriptSegmentResult> {
    try {
      const result = await this.repository.updateSegmentText(
        transcriptId,
        segmentIndex,
        text,
      );
      if (result.outcome === 'not-found') return result;
      await this.reloadTranscripts();
      this.emit();
      return {
        outcome: 'updated',
        segment: {
          ...result.segment,
          words: result.segment.words.map((word) => ({ ...word })),
        },
        text: result.record.text,
        preview: previewFor(result.record.text),
        meetingSummary: buildMeetingSummary(result.record),
      };
    } catch (error) {
      return {
        outcome: 'rejected',
        reason:
          error instanceof TranscriptValidationError
            ? error.message
            : 'Sotto could not save that transcript correction.',
      };
    }
  }

  async deleteTranscript(id: string): Promise<boolean> {
    const record = await this.repository.get(id);
    const deleted = await this.repository.delete(id);
    if (deleted) {
      if (record?.source.type === 'imported-file') {
        await this.playbackRepository.delete(record.id).catch(() => undefined);
      }
      const recordingId =
        record?.source.type === 'recording'
          ? record.recordingId ?? record.id
          : null;
      if (recordingId && (await this.recordingService.has(recordingId))) {
        await this.enqueueRecordingUpdate(async () => {
          await this.recordingService.markReady(
            recordingId,
            'The transcript was deleted. The original recording is ready to transcribe again.',
          );
          this.recordingStorageMessage = null;
          await this.reloadRecordings();
          this.emit();
        });
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
      void this.enqueueRecordingUpdate(async () => {
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
    if (!recording && this.finalizingRecordingId !== null) return;
    this.activeRecording = recording ? { ...recording } : null;
    this.emit();
  }

  private reloadTranscripts(): Promise<void> {
    const reload = this.transcriptReloadChain.then(async () => {
      const records = await this.repository.list();
      const transcriptSummaries = records.map(toTranscriptSummary);
      const recordingTranscriptIds = new Set(
        records
          .filter((record) => record.source.type === 'recording')
          .map((record) => record.recordingId ?? record.id),
      );
      this.transcriptSummaries = transcriptSummaries;
      this.recordingTranscriptIds = recordingTranscriptIds;
    });
    this.transcriptReloadChain = reload.catch(() => undefined);
    return reload;
  }

  private async reloadRecordings(): Promise<void> {
    this.recordings = await this.recordingService.listSavedRecordings();
  }

  private readRecordingCapability(): LiveRecordingCapability {
    return { ...this.recordingCapabilityProvider() };
  }

  private refreshRecordingCapability(): void {
    this.recordingCapability = this.readRecordingCapability();
  }

  private async startRecordingTranscription(
    recordingId: string,
    media: SelectedMedia,
    allowFinalizationHandoff = false,
  ): Promise<TranscriptionJobSnapshot> {
    const service = this.service;
    if (!service) {
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

    return this.runTranscriptionStart(async () => {
      await this.recordingService.markTranscribing(recordingId, recordingId);
      await this.reloadRecordings();
      this.emit();
      try {
        return await service.start(media);
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
    }, allowFinalizationHandoff);
  }

  private assertNoLiveRecordingForTranscription(
    allowFinalizationHandoff = false,
  ): void {
    if (
      this.recordingService.hasActiveOrPendingRecording() ||
      (!allowFinalizationHandoff && this.finalizingRecordingId !== null)
    ) {
      throw new TranscriptionStartError(
        'busy',
        'Finish or cancel the live recording before starting another transcription.',
      );
    }
  }

  private async runTranscriptionStart(
    start: () => Promise<TranscriptionJobSnapshot>,
    allowFinalizationHandoff = false,
  ): Promise<TranscriptionJobSnapshot> {
    this.assertNoLiveRecordingForTranscription(allowFinalizationHandoff);
    if (this.transcriptionStartPending) {
      throw new TranscriptionStartError(
        'busy',
        'Another recording is already being transcribed.',
      );
    }

    this.transcriptionStartPending = true;
    try {
      return await start();
    } finally {
      this.transcriptionStartPending = false;
    }
  }

  private enqueueRecordingUpdate(update: () => Promise<void>): Promise<void> {
    const next = this.recordingUpdateChain.then(update, update);
    const handled = next.catch(async (error: unknown) => {
      this.recordingStorageMessage =
        error instanceof Error
          ? error.message
          : 'Sotto could not save the recording status.';
      await this.reloadRecordings().catch(() => undefined);
      this.emit();
    });
    this.recordingUpdateChain = handled;
    return handled;
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}
