import path from 'node:path';

import { DEFAULT_TRANSCRIPTION_MODEL } from '../shared/default-transcription-model';
import type {
  AppState,
  AppendLiveRecordingChunkResult,
  ExpectedSpeakerCount,
  AddTranscriptSpeakerResult,
  AssignTranscriptSegmentSpeakerResult,
  AssignTranscriptSegmentSpeakersResult,
  GenerateLocalAiMeetingSummaryResult,
  PreviewLocalAiMeetingSummaryResult,
  LiveRecordingCapability,
  LiveCaptureHealth,
  LiveRecordingSnapshot,
  RecordingKind,
  SavedRecordingSummary,
  EngineStatus as RendererEngineStatus,
  TranscriptDetail,
  TranscriptCopyKind,
  TranscriptLibraryQuery,
  TranscriptLibraryResult,
  TranscriptSegment as RendererTranscriptSegment,
  TranscriptSummary,
  RenameTranscriptSpeakerResult,
  UpdateTranscriptMetadataResult,
  UpdateTranscriptSegmentResult,
  TranscriptExportFormat,
  TranscriptionJobSnapshot,
  LocalAiMeetingSummary,
  LiveRecordingMarker,
  DeleteMeetingResult,
} from '../shared/contracts';
import type { SelectedMedia } from './media/media-import';
import {
  LiveRecordingError,
  LiveRecordingService,
} from './recording/live-recording-service';
import type { EngineStatus as RuntimeStatus } from './runtime/engine-runtime';
import { TranscriptRepository } from './storage/transcript-repository';
import { searchTranscriptRecords } from './storage/transcript-library';
import { PlaybackRepository } from './storage/playback-repository';
import {
  LocalTranscriptionService,
  TranscriptionStartError,
} from './transcription/transcription-service';
import type { TranscriptRecord } from './transcription/transcript-types';
import { TranscriptValidationError } from './transcription/transcript-types';
import {
  createMeetingMinutesDocx,
  createTranscriptDocx,
} from './export/transcript-docx';
import {
  formatTranscriptAsSrt,
  formatTranscriptAsWebVtt,
  formatTranscriptCopyText,
  serializePortableTranscript,
} from './export/transcript-useful-output';
import { buildMeetingSummary } from './summarization/meeting-summary';
import { MAX_RELIABLE_AUTOMATIC_SPEAKERS } from './transcription/speaker-alignment';
import type { LocalAiConnectionService } from './local-ai/local-ai-connection';
import { formatSpeakerAnnotation } from './export/speaker-annotation';
import {
  fingerprintTranscriptForLocalAi,
  LocalAiSummaryCancelledError,
} from './local-ai/local-ai-meeting-summary';

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
      modelName: DEFAULT_TRANSCRIPTION_MODEL.id,
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
  tags: [...record.tags],
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
  const localAiMeetingSummary =
    presented.localAiMeetingSummary &&
    presented.localAiMeetingSummary.inputFingerprint ===
      fingerprintTranscriptForLocalAi(record)
      ? {
          summary: {
            ...presented.localAiMeetingSummary.summary,
            keyPoints: presented.localAiMeetingSummary.summary.keyPoints.map(
              (item) => ({ ...item }),
            ),
            decisions: presented.localAiMeetingSummary.summary.decisions.map(
              (item) => ({ ...item }),
            ),
            actionItems: presented.localAiMeetingSummary.summary.actionItems.map(
              (item) => ({ ...item }),
            ),
          },
          model: presented.localAiMeetingSummary.model,
          generatedAt: presented.localAiMeetingSummary.generatedAt,
        }
      : null;
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
    localAiMeetingSummary,
    playback: { state: 'unavailable', reason: 'not-retained' },
    speakerAnalysis: presented.speakerAnalysis
      ? {
          engine: { ...presented.speakerAnalysis.engine },
          speakers: presented.speakerAnalysis.speakers.map((speaker) => ({
            ...speaker,
          })),
        }
      : null,
    ...(presented.speakerDiagnostics
      ? { speakerDiagnostics: { ...presented.speakerDiagnostics } }
      : {}),
    markers: (presented.markers ?? []).map((marker) => ({ ...marker })),
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

export const formatTranscriptForExport = (
  record: TranscriptRecord,
  selectedSummary?: TranscriptDetail['meetingSummary'],
): string => {
  const presented = withReliableSpeakerPresentation(record);
  const meetingSummary = selectedSummary ?? buildMeetingSummary(presented);
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

  if (presented.markers?.length) {
    lines.push('BOOKMARKS');
    for (const marker of presented.markers) {
      lines.push(`- [${formatTimestamp(marker.offsetMs)}] ${marker.label}`);
    }
    lines.push('', 'TRANSCRIPT', '');
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
  /**
   * Hand annotation of speakers. Defaults off so a build that forgets to
   * enable it exposes nothing; only an unpackaged build turns it on.
   */
  private annotationEnabled = false;

  /** Enables development-only speaker annotation. Never called when packaged. */
  enableAnnotation(): void {
    this.annotationEnabled = true;
  }

  get isAnnotationEnabled(): boolean {
    return this.annotationEnabled;
  }

  private activeLocalAiSummary: {
    id: string;
    controller: AbortController;
  } | null = null;
  private queuedLocalAiSummaries: Array<{
    id: string;
    approvalFingerprint: string;
    service: LocalAiConnectionService;
  }> = [];
  private localAiNotices: string[] = [];
  private activeRecording: LiveRecordingSnapshot | null = null;
  private finalizingRecordingId: string | null = null;
  private recordings: SavedRecordingSummary[] = [];
  private recordingStorageMessage: string | null = null;
  private liveCaptureHealth: LiveCaptureHealth | null = null;
  private recordingUpdateChain: Promise<void> = Promise.resolve();
  private transcriptionStartPending = false;
  private transcriptReloadChain: Promise<void> = Promise.resolve();
  private transcriptSummaries: TranscriptSummary[] = [];
  private transcriptLibraryRecords: TranscriptRecord[] = [];
  private recordingTranscriptIds = new Set<string>();

  constructor(
    private readonly repository: TranscriptRepository,
    runtimeStatus: RuntimeStatus,
    jobsRoot: string,
    recordingCapability: LiveRecordingCapabilitySource =
      DEFAULT_RECORDING_CAPABILITY,
    transcriptionOptions?: () =>
      | Promise<{ modelPath: string; language: string }>
      | { modelPath: string; language: string },
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
          ...(transcriptionOptions ? { transcriptionOptions } : {}),
        })
      : null;
  }

  private readonly engineStatus: RendererEngineStatus;

  private readonly startupNotices: string[] = [];

  private readonly pendingImportQueue: Array<{
    media: SelectedMedia;
    expectedSpeakerCount: ExpectedSpeakerCount;
  }> = [];

  async initialize(): Promise<void> {
    await this.repository.cleanupTemporaryFiles();
    await this.playbackRepository.initialize();
    const interruptedImports = (await this.service?.initialize()) ?? [];
    for (const sourceName of interruptedImports.slice(0, 3)) {
      this.startupNotices.push(
        `The import of “${sourceName}” was interrupted when Sotto closed. Import the file again to transcribe it.`,
      );
    }
    if (interruptedImports.length > 3) {
      this.startupNotices.push(
        `${interruptedImports.length - 3} more imports were interrupted when Sotto closed.`,
      );
    }
    await this.recordingService.initialize();
    await this.reloadTranscripts();
    if (this.repository.lastSkippedRecordCount > 0) {
      const count = this.repository.lastSkippedRecordCount;
      this.startupNotices.push(
        count === 1
          ? 'One saved transcript could not be read and is hidden. It may have been created by a newer version of Sotto.'
          : `${count} saved transcripts could not be read and are hidden. They may have been created by a newer version of Sotto.`,
      );
    }
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
        captureHealth: this.liveCaptureHealth
          ? {
              ...this.liveCaptureHealth,
              desktop: { ...this.liveCaptureHealth.desktop },
              microphone: { ...this.liveCaptureHealth.microphone },
            }
          : null,
      },
      activeJob: this.activeJob ? { ...this.activeJob } : null,
      annotationEnabled: this.annotationEnabled,
      activeLocalAiSummary: this.activeLocalAiSummary
        ? { transcriptId: this.activeLocalAiSummary.id }
        : null,
      queuedLocalAiSummaries: this.queuedLocalAiSummaries.map(
        (entry) => entry.id,
      ),
      recordings: this.recordings.map((recording) => ({ ...recording })),
      transcripts: this.transcriptSummaries.map((transcript) => ({
        ...transcript,
        tags: [...transcript.tags],
      })),
      ...(this.startupNotices.length
        ? { startupNotices: [...this.startupNotices] }
        : {}),
      ...(this.localAiNotices.length
        ? { localAiNotices: [...this.localAiNotices] }
        : {}),
      ...(this.pendingImportQueue.length
        ? {
            pendingImports: this.pendingImportQueue.map(
              (entry) => entry.media.name,
            ),
          }
        : {}),
    };
  }

  async startTranscription(
    media: SelectedMedia,
    expectedSpeakerCount: ExpectedSpeakerCount = null,
  ): Promise<TranscriptionJobSnapshot> {
    const service = this.service;
    if (!service) {
      throw new TranscriptionStartError(
        'engine-unavailable',
        this.engineStatus.message,
      );
    }

    return this.runTranscriptionStart(() =>
      service.start(media, expectedSpeakerCount),
    );
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

  setLiveRecordingPaused(recordingId: string, paused: boolean): Promise<boolean> {
    return this.recordingService.setPaused(recordingId, paused);
  }

  addLiveRecordingMarker(
    recordingId: string,
    offsetMs: number,
    label?: string,
  ): Promise<LiveRecordingMarker | null> {
    return this.recordingService.addMarker(recordingId, offsetMs, label);
  }

  async finishLiveRecording(
    recordingId: string,
    expectedSpeakerCount: ExpectedSpeakerCount = null,
  ): Promise<TranscriptionJobSnapshot> {
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
        expectedSpeakerCount,
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
    expectedSpeakerCount: ExpectedSpeakerCount = null,
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
      ? this.startRecordingTranscription(recordingId, media, expectedSpeakerCount)
      : null;
  }

  /**
   * Regenerates a transcript in place from its retained audio using the
   * transcription settings in effect now (model and language resolve per
   * job). Recording-sourced transcripts re-run from the durable recording;
   * imported ones from the retained playback WAV. Title, tags, and the
   * creation date survive; text, speakers, and summaries are replaced.
   */
  async retranscribeTranscript(
    transcriptId: string,
    expectedSpeakerCount: ExpectedSpeakerCount = null,
  ): Promise<
    | { outcome: 'started'; job: TranscriptionJobSnapshot }
    | { outcome: 'not-found' }
    | { outcome: 'rejected'; reason: string }
  > {
    const record = await this.repository.get(transcriptId);
    if (!record) return { outcome: 'not-found' };
    try {
      this.assertNoLiveRecordingForTranscription();
      if (record.source.type === 'recording') {
        const recordingId = record.recordingId ?? record.id;
        await this.recordingUpdateChain;
        const media =
          await this.recordingService.getMediaForTranscription(recordingId);
        if (!media) {
          return {
            outcome: 'rejected',
            reason:
              'The original recording is no longer saved, so this meeting cannot be transcribed again.',
          };
        }
        const job = await this.startRecordingTranscription(
          recordingId,
          media,
          expectedSpeakerCount,
        );
        return { outcome: 'started', job };
      }

      const playback = await this.playbackRepository.get(record.id);
      if (!playback) {
        return {
          outcome: 'rejected',
          reason:
            'The retained audio copy was deleted, so this meeting cannot be transcribed again.',
        };
      }
      const job = await this.startTranscription(
        {
          extension: '.wav',
          mediaKind: 'audio',
          name: record.source.name,
          path: playback.path,
          sizeBytes: playback.sizeBytes,
          sourceType: 'imported-file',
          transcriptId: record.id,
          cleanupAfterTranscription: false,
        },
        expectedSpeakerCount,
      );
      return { outcome: 'started', job };
    } catch (error) {
      return {
        outcome: 'rejected',
        reason:
          error instanceof TranscriptionStartError ||
          error instanceof LiveRecordingError
            ? error.message
            : 'Sotto could not start transcribing this meeting again.',
      };
    }
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

  searchTranscriptLibrary(
    query: TranscriptLibraryQuery,
  ): TranscriptLibraryResult {
    const selection = searchTranscriptRecords(
      this.transcriptLibraryRecords,
      query,
    );
    return {
      transcripts: selection.records.map(toTranscriptSummary),
      availableSpeakers: selection.availableSpeakers,
      availableTags: selection.availableTags,
    };
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
    const summary =
      toTranscriptDetail(presented).localAiMeetingSummary?.summary ??
      buildMeetingSummary(presented);
    let content: string | Buffer;
    switch (format) {
      case 'docx':
        content = await createTranscriptDocx(presented, summary);
        break;
      case 'srt':
        content = formatTranscriptAsSrt(presented);
        break;
      case 'vtt':
        content = formatTranscriptAsWebVtt(presented);
        break;
      case 'json':
        content = serializePortableTranscript(presented, summary);
        break;
      case 'minutes-docx':
        content = await createMeetingMinutesDocx(presented, summary);
        break;
      case 'txt':
        content = formatTranscriptForExport(presented, summary);
        break;
    }
    return {
      title: presented.title,
      content,
    };
  }

  async getTranscriptCopyText(
    id: string,
    kind: TranscriptCopyKind,
  ): Promise<string | null> {
    const record = await this.repository.getAfterPendingMutations(id);
    if (!record) return null;
    const presented = withReliableSpeakerPresentation(record);
    return formatTranscriptCopyText(
      presented,
      toTranscriptDetail(presented).localAiMeetingSummary?.summary ??
        buildMeetingSummary(presented),
      kind,
    );
  }

  async previewLocalAiMeetingSummary(
    id: string,
    localAiService: LocalAiConnectionService,
  ): Promise<PreviewLocalAiMeetingSummaryResult> {
    const record = await this.repository.getAfterPendingMutations(id);
    if (!record) return { outcome: 'not-found' };
    try {
      const preview = await localAiService.planMeetingSummary(
        withReliableSpeakerPresentation(record),
      );
      return {
        outcome: 'ready',
        preview: {
          ...preview,
          transcriptId: record.id,
          approvalFingerprint: fingerprintTranscriptForLocalAi(record),
        },
      };
    } catch (error) {
      return {
        outcome: 'rejected',
        reason:
          error instanceof Error
            ? error.message
            : 'Sotto could not prepare this transcript for the local model.',
      };
    }
  }

  /**
   * Stops this transcript's summary whether it is running or still waiting.
   * A queued entry is dropped outright, since nothing has been sent for it.
   */
  cancelLocalAiMeetingSummary(id: string): void {
    if (this.activeLocalAiSummary?.id === id) {
      this.activeLocalAiSummary.controller.abort();
      return;
    }
    const waiting = this.queuedLocalAiSummaries.findIndex(
      (entry) => entry.id === id,
    );
    if (waiting >= 0) {
      this.queuedLocalAiSummaries.splice(waiting, 1);
      this.emit();
    }
  }

  /**
   * Runs approved sends one at a time. Each queued entry already carries the
   * fingerprint of the payload its user reviewed, so waiting its turn cannot
   * turn into sending something that was never shown — a transcript edited
   * while it waits fails the same check an immediate send would.
   */
  private startNextQueuedLocalAiSummary(): void {
    if (this.activeLocalAiSummary) return;
    const next = this.queuedLocalAiSummaries.shift();
    if (!next) return;
    void this.generateLocalAiMeetingSummary(
      next.id,
      next.service,
      next.approvalFingerprint,
    ).then((result) => {
      if (result.outcome !== 'rejected' && result.outcome !== 'not-found') return;
      this.localAiNotices.push(
        result.outcome === 'not-found'
          ? 'A queued Local AI summary was skipped because its transcript is no longer available.'
          : `A queued Local AI summary did not finish: ${result.reason}`,
      );
      this.emit();
    });
    // Each generation starts the next one from its own teardown, so the queue
    // advances without a loop that could run two sends at once.
  }

  async generateLocalAiMeetingSummary(
    id: string,
    localAiService: LocalAiConnectionService,
    approvalFingerprint: string,
  ): Promise<GenerateLocalAiMeetingSummaryResult> {
    const record = await this.repository.getAfterPendingMutations(id);
    if (!record) return { outcome: 'not-found' };
    const fingerprint = fingerprintTranscriptForLocalAi(record);
    // The preview the user approved described this exact content. If the
    // transcript changed in between, send nothing and ask for a fresh review
    // rather than transmitting text that was never shown.
    if (fingerprint !== approvalFingerprint) {
      return {
        outcome: 'rejected',
        reason:
          'The transcript changed after you reviewed what would be sent. Review it again before sending.',
      };
    }
    if (this.activeLocalAiSummary) {
      if (this.activeLocalAiSummary.id === id) {
        return {
          outcome: 'rejected',
          reason: 'This summary is already being generated.',
        };
      }
      const waiting = this.queuedLocalAiSummaries.findIndex(
        (entry) => entry.id === id,
      );
      if (waiting >= 0) {
        // Re-approving replaces the older approval rather than sending twice.
        this.queuedLocalAiSummaries[waiting] = {
          id,
          approvalFingerprint,
          service: localAiService,
        };
        return { outcome: 'queued', position: waiting + 1 };
      }
      this.queuedLocalAiSummaries.push({
        id,
        approvalFingerprint,
        service: localAiService,
      });
      this.emit();
      return { outcome: 'queued', position: this.queuedLocalAiSummaries.length };
    }
    const controller = new AbortController();
    this.activeLocalAiSummary = { id, controller };
    this.emit();
    try {
      const generated = await localAiService.generateMeetingSummary(
        withReliableSpeakerPresentation(record),
        controller.signal,
      );
      const saved = await this.repository.saveLocalAiMeetingSummary(
        id,
        generated,
        fingerprint,
      );
      if (saved.outcome === 'not-found') return { outcome: 'not-found' };
      if (saved.outcome === 'stale') {
        return {
          outcome: 'rejected',
          reason:
            'The transcript changed while Local AI was working. Generate the summary again.',
        };
      }
      await this.refreshTranscript(id);
      this.emit();
      const localAiMeetingSummary: LocalAiMeetingSummary = {
        summary: {
          ...generated.summary,
          keyPoints: generated.summary.keyPoints.map((item) => ({ ...item })),
          decisions: generated.summary.decisions.map((item) => ({ ...item })),
          actionItems: generated.summary.actionItems.map((item) => ({ ...item })),
        },
        model: generated.model,
        generatedAt: generated.generatedAt,
      };
      return { outcome: 'generated', localAiMeetingSummary };
    } catch (error) {
      if (error instanceof LocalAiSummaryCancelledError) {
        return { outcome: 'cancelled' };
      }
      return {
        outcome: 'rejected',
        reason:
          error instanceof Error
            ? error.message
            : 'Sotto could not improve this summary with the local model.',
      };
    } finally {
      this.activeLocalAiSummary = null;
      this.emit();
      this.startNextQueuedLocalAiSummary();
    }
  }

  async getDictationText(id: string): Promise<string | null> {
    const record = await this.repository.getAfterPendingMutations(id);
    return record?.text.trim() || null;
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
      await this.refreshTranscript(transcriptId);
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

  async updateTranscriptMetadata(
    transcriptId: string,
    metadata: { title?: string; tags?: string[] },
  ): Promise<UpdateTranscriptMetadataResult> {
    try {
      const result = await this.repository.updateMetadata(
        transcriptId,
        metadata,
      );
      if (result.outcome === 'not-found') return result;
      await this.refreshTranscript(transcriptId);
      this.emit();
      return {
        outcome: 'updated',
        title: result.record.title,
        tags: [...result.record.tags],
      };
    } catch (error) {
      return {
        outcome: 'rejected',
        reason:
          error instanceof TranscriptValidationError
            ? error.message
            : 'Sotto could not save that transcript information.',
      };
    }
  }

  /**
   * Reassigns one segment to a different speaker. Development-only: the IPC
   * layer refuses the channel in a packaged build, so reaching here already
   * means annotation is enabled.
   */
  async assignTranscriptSegmentSpeaker(
    transcriptId: string,
    segmentIndex: number,
    speakerId: string | null,
  ): Promise<AssignTranscriptSegmentSpeakerResult> {
    try {
      const result = await this.repository.assignSegmentSpeaker(
        transcriptId,
        segmentIndex,
        speakerId,
      );
      if (result.outcome === 'not-found') return result;
      await this.refreshTranscript(transcriptId);
      this.emit();
      return {
        outcome: 'updated',
        segment: {
          ...result.segment,
          words: result.segment.words.map((word) => ({ ...word })),
        },
        localAiMeetingSummary: null,
      };
    } catch (error) {
      return {
        outcome: 'rejected',
        reason:
          error instanceof Error
            ? error.message
            : 'Sotto could not reassign that segment.',
      };
    }
  }

  async assignTranscriptSegmentSpeakers(
    transcriptId: string,
    segmentIndexes: number[],
    speakerId: string | null,
  ): Promise<AssignTranscriptSegmentSpeakersResult> {
    try {
      const result = await this.repository.assignSegmentSpeakers(
        transcriptId,
        segmentIndexes,
        speakerId,
      );
      if (result.outcome === 'not-found') return result;
      await this.refreshTranscript(transcriptId);
      this.emit();
      return { outcome: 'updated', assignedCount: result.assignedCount };
    } catch (error) {
      return {
        outcome: 'rejected',
        reason:
          error instanceof Error
            ? error.message
            : 'Sotto could not reassign those segments.',
      };
    }
  }

  async addTranscriptSpeaker(
    transcriptId: string,
    label: string,
  ): Promise<AddTranscriptSpeakerResult> {
    try {
      const result = await this.repository.addSpeaker(transcriptId, label);
      if (result.outcome !== 'added') return result;
      await this.refreshTranscript(transcriptId);
      this.emit();
      return { outcome: 'added', speaker: { ...result.speaker } };
    } catch (error) {
      return {
        outcome: 'rejected',
        reason:
          error instanceof Error
            ? error.message
            : 'Sotto could not add that speaker.',
      };
    }
  }

  async getSpeakerAnnotation(id: string): Promise<string | null> {
    const record = await this.repository.getAfterPendingMutations(id);
    return record ? formatSpeakerAnnotation(record) : null;
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
      await this.refreshTranscript(transcriptId);
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
        localAiMeetingSummary: null,
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
      await this.refreshTranscript(id);
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

  async deleteMeeting(
    recordingId: string,
    transcriptId: string,
  ): Promise<DeleteMeetingResult> {
    const [record, saved] = await Promise.all([
      this.repository.get(transcriptId),
      this.recordingService.getSavedRecording(recordingId),
    ]);
    const normalizedRecordingId = recordingId.toLowerCase();
    if (
      !record ||
      !saved ||
      record.source.type !== 'recording' ||
      (record.recordingId ?? record.id) !== normalizedRecordingId
    ) {
      return { outcome: 'not-found' };
    }
    if (
      saved.transcription.state === 'transcribing' ||
      (
        this.activeJob?.recordingId === normalizedRecordingId &&
        isRunningTranscriptionStage(this.activeJob.stage)
      )
    ) {
      return {
        outcome: 'rejected',
        reason: 'Cancel transcription before deleting this meeting.',
      };
    }
    if (saved.transcription.transcriptId !== record.id) {
      return { outcome: 'not-found' };
    }

    if (!(await this.repository.delete(record.id))) {
      return { outcome: 'not-found' };
    }

    try {
      if (!(await this.recordingService.delete(saved.id))) {
        return await this.finishPartialMeetingDeletion(saved.id, record.id);
      }
    } catch {
      return this.finishPartialMeetingDeletion(saved.id, record.id);
    }

    await this.refreshTranscript(record.id);
    await this.reloadRecordings();
    this.emit();
    return { outcome: 'deleted' };
  }

  async dispose(): Promise<void> {
    // Otherwise a quit during generation leaves the endpoint request
    // outstanding until its own two-minute bound expires.
    this.activeLocalAiSummary?.controller.abort();
    this.queuedLocalAiSummaries = [];
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

    if (['completed', 'failed', 'cancelled'].includes(job.stage)) {
      this.drainImportQueue();
    }
  }

  private async finishPartialMeetingDeletion(
    recordingId: string,
    transcriptId: string,
  ): Promise<DeleteMeetingResult> {
    await this.recordingService
      .markReady(
        recordingId,
        'The transcript was deleted. The original recording is ready to transcribe again.',
      )
      .catch(() => undefined);
    await this.refreshTranscript(transcriptId);
    await this.reloadRecordings();
    this.emit();
    return {
      outcome: 'partial',
      reason: 'The transcript was deleted, but Sotto could not delete the saved recording.',
    };
  }

  /**
   * Imports beyond the single active job wait here and start one after
   * another as jobs finish. The queue is in-memory only; a crash reports
   * the active job through its marker, and queued files simply need
   * re-importing.
   */
  async enqueueImports(
    mediaList: SelectedMedia[],
    expectedSpeakerCount: ExpectedSpeakerCount,
  ): Promise<{ job: TranscriptionJobSnapshot | null; queuedCount: number }> {
    if (mediaList.length === 0) {
      throw new TypeError('At least one recording is required.');
    }
    const running =
      this.activeJob && isRunningTranscriptionStage(this.activeJob.stage);
    const [first, ...rest] = mediaList;
    let job: TranscriptionJobSnapshot | null = null;
    let queued = rest;
    if (running) {
      queued = mediaList;
    } else {
      job = await this.startTranscription(first, expectedSpeakerCount);
    }
    for (const media of queued) {
      this.pendingImportQueue.push({ media, expectedSpeakerCount });
    }
    if (queued.length > 0) this.emit();
    return { job, queuedCount: queued.length };
  }

  private drainImportQueue(): void {
    const next = this.pendingImportQueue.shift();
    if (!next) return;
    void this.startTranscription(next.media, next.expectedSpeakerCount)
      .then(() => this.emit())
      .catch((error: unknown) => {
        console.warn(
          `[sotto] A queued import could not start: ${next.media.name}.`,
          error,
        );
        // Keep the queue moving; the skipped file can be imported again.
        this.emit();
        this.drainImportQueue();
      });
  }

  private handleRecordingChanged(recording: LiveRecordingSnapshot | null): void {
    if (!recording && this.finalizingRecordingId !== null) return;
    this.activeRecording = recording ? { ...recording } : null;
    if (!recording || this.liveCaptureHealth?.recordingId !== recording.id) {
      this.liveCaptureHealth = null;
    }
    this.emit();
  }

  updateLiveRecordingHealth(health: LiveCaptureHealth | null): void {
    if (health === null) {
      this.liveCaptureHealth = null;
      this.emit();
      return;
    }
    if (this.activeRecording?.id !== health.recordingId) return;
    this.liveCaptureHealth = {
      ...health,
      desktop: { ...health.desktop },
      microphone: { ...health.microphone },
    };
    this.emit();
  }

  private reloadTranscripts(): Promise<void> {
    const reload = this.transcriptReloadChain.then(async () => {
      this.adoptTranscriptRecords(await this.repository.list());
    });
    this.transcriptReloadChain = reload.catch(() => undefined);
    return reload;
  }

  /**
   * Refreshes one record after a single-record mutation instead of
   * re-reading and re-parsing the entire library from disk. Unchanged
   * records keep their object identity, which also preserves their cached
   * search haystacks.
   */
  private refreshTranscript(id: string): Promise<void> {
    const reload = this.transcriptReloadChain.then(async () => {
      const record = await this.repository.get(id);
      const records = this.transcriptLibraryRecords.filter(
        (entry) => entry.id !== id,
      );
      if (record) records.push(record);
      records.sort((left, right) => {
        const byCompletedAt =
          Date.parse(right.completedAt) - Date.parse(left.completedAt);
        return byCompletedAt === 0
          ? right.id.localeCompare(left.id)
          : byCompletedAt;
      });
      this.adoptTranscriptRecords(records);
    });
    this.transcriptReloadChain = reload.catch(() => undefined);
    return reload;
  }

  private adoptTranscriptRecords(records: TranscriptRecord[]): void {
    this.transcriptSummaries = records.map(toTranscriptSummary);
    this.transcriptLibraryRecords = records;
    this.recordingTranscriptIds = new Set(
      records
        .filter((record) => record.source.type === 'recording')
        .map((record) => record.recordingId ?? record.id),
    );
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
    expectedSpeakerCount: ExpectedSpeakerCount = null,
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
        return await service.start(media, expectedSpeakerCount);
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
