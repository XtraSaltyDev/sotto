export const IPC_CHANNELS = {
  getAppState: 'sotto:state:get',
  importMedia: 'sotto:media:import',
  startLiveRecording: 'sotto:recording:start',
  appendLiveRecordingChunk: 'sotto:recording:chunk',
  finishLiveRecording: 'sotto:recording:finish',
  cancelLiveRecording: 'sotto:recording:cancel',
  retryRecording: 'sotto:recording:retry',
  deleteRecording: 'sotto:recording:delete',
  exportRecording: 'sotto:recording:export',
  openRecordingSettings: 'sotto:recording:settings',
  requestRecordingPermissions: 'sotto:recording:permissions:request',
  cancelTranscription: 'sotto:transcription:cancel',
  searchTranscriptLibrary: 'sotto:transcript:library:search',
  getTranscript: 'sotto:transcript:get',
  updateTranscriptMetadata: 'sotto:transcript:metadata:update',
  updateTranscriptSegment: 'sotto:transcript:segment:update',
  renameTranscriptSpeaker: 'sotto:transcript:speaker:rename',
  deleteTranscript: 'sotto:transcript:delete',
  exportTranscript: 'sotto:transcript:export',
  copyTranscriptOutput: 'sotto:transcript:copy-output',
  insertDictationText: 'sotto:dictation:insert-text',
  collapseForActivity: 'sotto:activity:collapse',
  restoreMainWindow: 'sotto:activity:restore-main-window',
  requestActivityAction: 'sotto:activity:request-action',
  getAppSettings: 'sotto:settings:get',
  updateAppSettings: 'sotto:settings:update',
  revealTranscriptsFolder: 'sotto:settings:reveal-transcripts',
  revealModelsFolder: 'sotto:settings:reveal-models',
  getLocalAiConnection: 'sotto:local-ai:get',
  connectLocalAi: 'sotto:local-ai:connect',
  disconnectLocalAi: 'sotto:local-ai:disconnect',
  generateLocalAiMeetingSummary: 'sotto:local-ai:meeting-summary:generate',
  deletePlayback: 'sotto:playback:delete',
  checkForAppUpdate: 'sotto:updates:check',
  downloadAppUpdate: 'sotto:updates:download',
  cancelAppUpdate: 'sotto:updates:cancel',
  installAppUpdate: 'sotto:updates:install',
  manualUpdateCheck: 'sotto:updates:manual-check',
  appUpdateProgress: 'sotto:updates:progress',
  stateChanged: 'sotto:state:changed',
  dictationShortcut: 'sotto:dictation:shortcut',
  activityAction: 'sotto:activity:action',
} as const;

export type EngineState = 'checking' | 'ready' | 'unavailable';

export interface EngineStatus {
  state: EngineState;
  engineVersion: string | null;
  modelName: string | null;
  message: string;
}

export type TranscriptionStage =
  | 'preparing'
  | 'normalizing'
  | 'transcribing'
  | 'saving'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TranscriptionErrorCode =
  | 'engine-unavailable'
  | 'busy'
  | 'invalid-media'
  | 'no-audio'
  | 'normalization-failed'
  | 'transcription-failed'
  | 'invalid-output'
  | 'storage-failed';

export type LiveRecordingErrorCode =
  | 'unsupported-platform'
  | 'permission-denied'
  | 'busy'
  | 'recording-failed'
  | 'storage-full'
  | 'engine-unavailable';

export interface LiveRecordingCapability {
  state:
    | 'setup-required'
    | 'permission-required'
    | 'ready'
    | 'unsupported';
  message: string;
}

export interface LiveRecordingSnapshot {
  id: string;
  kind: RecordingKind;
  sourceName: string;
  startedAt: string;
  bytesWritten: number;
}

export type RecordingKind = 'meeting' | 'dictation';

export type ActivityMode =
  | 'meeting-recording'
  | 'dictation'
  | 'transcribing';

export type ActivityAction = 'stop-recording' | 'cancel-transcription';

export const MIN_EXPECTED_SPEAKER_COUNT = 1;
export const MAX_EXPECTED_SPEAKER_COUNT = 12;
export type ExpectedSpeakerCount = number | null;

export const isExpectedSpeakerCount = (
  value: unknown,
): value is ExpectedSpeakerCount =>
  value === null ||
  (Number.isSafeInteger(value) &&
    (value as number) >= MIN_EXPECTED_SPEAKER_COUNT &&
    (value as number) <= MAX_EXPECTED_SPEAKER_COUNT);

export interface LiveRecordingStatus {
  capability: LiveRecordingCapability;
  active: LiveRecordingSnapshot | null;
  storageMessage: string | null;
}

export type RecordingTranscriptionState =
  | 'ready'
  | 'transcribing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface SavedRecordingSummary {
  id: string;
  sourceName: string;
  startedAt: string;
  completedAt: string;
  sizeBytes: number;
  transcriptionState: RecordingTranscriptionState;
  message: string;
  errorCode?: TranscriptionErrorCode;
  jobId?: string;
  transcriptId?: string;
}

export interface TranscriptionJobSnapshot {
  id: string;
  sourceName: string;
  stage: TranscriptionStage;
  progress: number;
  startedAt: string;
  message: string;
  errorCode?: TranscriptionErrorCode;
  recordingId?: string;
  transcriptId?: string;
}

export interface TranscriptSummary {
  id: string;
  title: string;
  sourceName: string;
  createdAt: string;
  durationMs: number;
  language: string;
  preview: string;
  tags: string[];
}

export const MAX_TRANSCRIPT_LIBRARY_QUERY_CHARACTERS = 500;

export interface TranscriptLibraryQuery {
  text: string;
  createdFrom: string | null;
  speaker: string | null;
  tag: string | null;
}

export interface TranscriptLibraryResult {
  transcripts: TranscriptSummary[];
  availableSpeakers: string[];
  availableTags: string[];
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  speakerId: string | null;
  words: TranscriptWord[];
}

export interface TranscriptWord {
  startMs: number;
  endMs: number;
  text: string;
}

export type TranscriptPlayback =
  | {
      state: 'available';
      kind: 'imported-audio-copy' | 'live-recording';
      sizeBytes: number;
      url: string;
    }
  | { state: 'unavailable'; reason: 'not-retained' | 'missing' };

export interface TranscriptSpeaker {
  id: string;
  label: string;
}

export interface MeetingSummaryItem {
  text: string;
  startMs: number;
  speakerId: string | null;
}

export interface MeetingSummary {
  overview: string;
  keyPoints: MeetingSummaryItem[];
  decisions: MeetingSummaryItem[];
  actionItems: MeetingSummaryItem[];
}

export interface LocalAiMeetingSummary {
  summary: MeetingSummary;
  model: string;
  generatedAt: string;
}

export interface TranscriptDetail extends TranscriptSummary {
  completedAt: string;
  text: string;
  segments: TranscriptSegment[];
  meetingSummary: MeetingSummary | null;
  localAiMeetingSummary: LocalAiMeetingSummary | null;
  playback: TranscriptPlayback;
  speakerAnalysis: {
    engine: {
      name: string;
      version: string;
      model: string;
    };
    speakers: TranscriptSpeaker[];
  } | null;
  recordingId?: string;
  engine: {
    name: string;
    version: string;
    model: string;
  };
}

export interface AppState {
  engine: EngineStatus;
  recording: LiveRecordingStatus;
  activeJob: TranscriptionJobSnapshot | null;
  recordings: SavedRecordingSummary[];
  transcripts: TranscriptSummary[];
  /** One-time launch reports: interrupted imports, unreadable records. */
  startupNotices?: string[];
  /** Source names of imports waiting behind the active transcription. */
  pendingImports?: string[];
}

export const SUPPORTED_TRANSCRIPTION_LANGUAGES: ReadonlyArray<{
  id: string;
  label: string;
}> = [
  { id: 'auto', label: 'Auto-detect' },
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Spanish' },
  { id: 'fr', label: 'French' },
  { id: 'de', label: 'German' },
  { id: 'it', label: 'Italian' },
  { id: 'pt', label: 'Portuguese' },
  { id: 'nl', label: 'Dutch' },
  { id: 'sv', label: 'Swedish' },
  { id: 'pl', label: 'Polish' },
  { id: 'uk', label: 'Ukrainian' },
  { id: 'ru', label: 'Russian' },
  { id: 'tr', label: 'Turkish' },
  { id: 'ar', label: 'Arabic' },
  { id: 'hi', label: 'Hindi' },
  { id: 'zh', label: 'Chinese' },
  { id: 'ja', label: 'Japanese' },
  { id: 'ko', label: 'Korean' },
];

export interface TranscriptionModelSummary {
  id: string;
  multilingual: boolean;
  sizeBytes: number;
  source: 'bundled' | 'user';
}

export interface AppSettingsSummary {
  transcriptionModelId: string;
  transcriptionLanguage: string;
  availableModels: TranscriptionModelSummary[];
  userModelsDirectory: string;
  dictationShortcut: string;
}

export interface UpdateAppSettingsInput {
  transcriptionModelId?: string;
  transcriptionLanguage?: string;
}

export type UpdateAppSettingsResult =
  | { outcome: 'updated'; settings: AppSettingsSummary }
  | { outcome: 'rejected'; reason: string };

export const OLLAMA_OPENAI_BASE_URL = 'http://127.0.0.1:11434/v1';

export interface LocalAiModel {
  id: string;
  ownedBy: string | null;
}

export interface LocalAiConnectionSummary {
  configured: boolean;
  baseUrl: string;
  selectedModel: string | null;
  availableModels?: LocalAiModel[];
  hasApiKey: boolean;
  verifiedAt: string | null;
}

export interface ConnectLocalAiInput {
  baseUrl: string;
  apiKey?: string;
  selectedModel?: string | null;
}

export type ConnectLocalAiResult =
  | {
      outcome: 'connected';
      connection: LocalAiConnectionSummary;
      models: LocalAiModel[];
    }
  | { outcome: 'rejected'; reason: string };

export type DisconnectLocalAiResult = { outcome: 'disconnected' };

export type GenerateLocalAiMeetingSummaryResult =
  | {
      outcome: 'generated';
      localAiMeetingSummary: LocalAiMeetingSummary;
    }
  | { outcome: 'not-found' }
  | { outcome: 'rejected'; reason: string };

export type ImportMediaResult =
  | { outcome: 'cancelled' }
  | { outcome: 'rejected'; reason: string; code: TranscriptionErrorCode }
  | { outcome: 'started'; job: TranscriptionJobSnapshot; queuedCount?: number }
  | { outcome: 'queued'; queuedCount: number };

export type StartLiveRecordingResult =
  | { outcome: 'started'; recording: LiveRecordingSnapshot }
  | { outcome: 'rejected'; reason: string; code: LiveRecordingErrorCode };

export type AppendLiveRecordingChunkResult =
  | { outcome: 'accepted'; bytesWritten: number }
  | { outcome: 'rejected'; reason: string; code: LiveRecordingErrorCode };

export type FinishLiveRecordingResult =
  | { outcome: 'started'; job: TranscriptionJobSnapshot }
  | {
      outcome: 'rejected';
      reason: string;
      code: LiveRecordingErrorCode | TranscriptionErrorCode;
    }
  | { outcome: 'not-found' };

export type CancelLiveRecordingResult =
  | { outcome: 'cancelled' }
  | { outcome: 'not-found' };

export type RetryRecordingResult =
  | { outcome: 'started'; job: TranscriptionJobSnapshot }
  | {
      outcome: 'rejected';
      reason: string;
      code: LiveRecordingErrorCode | TranscriptionErrorCode;
    }
  | { outcome: 'not-found' };

export type DeleteRecordingResult =
  | { outcome: 'deleted' }
  | { outcome: 'not-found' }
  | { outcome: 'rejected'; reason: string };

export type ExportRecordingResult =
  | { outcome: 'cancelled' }
  | { outcome: 'saved'; fileName: string }
  | { outcome: 'not-found' }
  | { outcome: 'failed'; reason: string };

export type OpenRecordingSettingsResult =
  | { outcome: 'opened' }
  | { outcome: 'failed'; reason: string };

export type RequestRecordingPermissionsResult =
  | { outcome: 'requested' }
  | { outcome: 'settings-opened' }
  | { outcome: 'failed'; reason: string };

export type CancelTranscriptionResult =
  | { outcome: 'cancelled' }
  | { outcome: 'not-found' };

export type DeleteTranscriptResult =
  | { outcome: 'deleted' }
  | { outcome: 'not-found' };

export type DeletePlaybackResult =
  | { outcome: 'deleted' }
  | { outcome: 'not-found' }
  | { outcome: 'rejected'; reason: string };

export type ExportTranscriptResult =
  | { outcome: 'cancelled' }
  | { outcome: 'saved'; fileName: string }
  | { outcome: 'not-found' }
  | { outcome: 'failed'; reason: string };

export type TranscriptExportFormat =
  | 'txt'
  | 'docx'
  | 'srt'
  | 'vtt'
  | 'json'
  | 'minutes-docx';

export type TranscriptCopyKind =
  | 'overview'
  | 'key-points'
  | 'decisions'
  | 'action-items'
  | 'meeting-minutes';

export type CopyTranscriptOutputResult =
  | { outcome: 'copied' }
  | { outcome: 'not-found' }
  | { outcome: 'failed'; reason: string };

export type InsertDictationTextResult =
  | { outcome: 'inserted' }
  | { outcome: 'copied'; reason: string }
  | { outcome: 'not-found' }
  | { outcome: 'failed'; reason: string };

export type RenameTranscriptSpeakerResult =
  | { outcome: 'renamed'; speaker: TranscriptSpeaker }
  | { outcome: 'not-found' }
  | { outcome: 'rejected'; reason: string };

export type UpdateTranscriptMetadataResult =
  | { outcome: 'updated'; title: string; tags: string[] }
  | { outcome: 'not-found' }
  | { outcome: 'rejected'; reason: string };

export type UpdateTranscriptSegmentResult =
  | {
      outcome: 'updated';
      segment: TranscriptSegment;
      text: string;
      preview: string;
      meetingSummary: MeetingSummary | null;
      localAiMeetingSummary: null;
    }
  | { outcome: 'not-found' }
  | { outcome: 'rejected'; reason: string };

export interface AvailableAppUpdate {
  version: string;
  publishedAt: string | null;
  size: number;
}

export type CheckForAppUpdateResult =
  | { outcome: 'update-available'; update: AvailableAppUpdate }
  | { outcome: 'up-to-date'; version: string }
  | { outcome: 'unavailable'; reason: string };

export type AppUpdateProgress =
  | {
      phase: 'downloading';
      version: string;
      receivedBytes: number;
      totalBytes: number;
    }
  | { phase: 'preparing'; version: string };

export type DownloadAppUpdateResult =
  | {
      outcome: 'downloaded';
      fileName: string;
      filePath: string;
      version: string;
    }
  | { outcome: 'staged'; version: string }
  | { outcome: 'cancelled'; version: string }
  | { outcome: 'failed'; reason: string };

export type InstallAppUpdateResult =
  | { outcome: 'installed'; version: string }
  | { outcome: 'failed'; reason: string };

export interface SottoDesktopApi {
  getAppState(): Promise<AppState>;
  importMedia(
    expectedSpeakerCount?: ExpectedSpeakerCount,
  ): Promise<ImportMediaResult>;
  startLiveRecording(kind?: RecordingKind): Promise<StartLiveRecordingResult>;
  appendLiveRecordingChunk(
    recordingId: string,
    chunk: ArrayBuffer,
  ): Promise<AppendLiveRecordingChunkResult>;
  finishLiveRecording(
    recordingId: string,
    expectedSpeakerCount?: ExpectedSpeakerCount,
  ): Promise<FinishLiveRecordingResult>;
  cancelLiveRecording(recordingId: string): Promise<CancelLiveRecordingResult>;
  retryRecording(
    recordingId: string,
    expectedSpeakerCount?: ExpectedSpeakerCount,
  ): Promise<RetryRecordingResult>;
  deleteRecording(recordingId: string): Promise<DeleteRecordingResult>;
  exportRecording(recordingId: string): Promise<ExportRecordingResult>;
  openRecordingSettings(): Promise<OpenRecordingSettingsResult>;
  requestRecordingPermissions(): Promise<RequestRecordingPermissionsResult>;
  cancelTranscription(jobId: string): Promise<CancelTranscriptionResult>;
  searchTranscriptLibrary(
    query: TranscriptLibraryQuery,
  ): Promise<TranscriptLibraryResult>;
  getTranscript(transcriptId: string): Promise<TranscriptDetail | null>;
  updateTranscriptMetadata(
    transcriptId: string,
    metadata: { title?: string; tags?: string[] },
  ): Promise<UpdateTranscriptMetadataResult>;
  updateTranscriptSegment(
    transcriptId: string,
    segmentIndex: number,
    text: string,
  ): Promise<UpdateTranscriptSegmentResult>;
  renameTranscriptSpeaker(
    transcriptId: string,
    speakerId: string,
    label: string,
  ): Promise<RenameTranscriptSpeakerResult>;
  deleteTranscript(transcriptId: string): Promise<DeleteTranscriptResult>;
  deletePlayback(transcriptId: string): Promise<DeletePlaybackResult>;
  exportTranscript(
    transcriptId: string,
    format: TranscriptExportFormat,
  ): Promise<ExportTranscriptResult>;
  copyTranscriptOutput(
    transcriptId: string,
    kind: TranscriptCopyKind,
  ): Promise<CopyTranscriptOutputResult>;
  insertDictationText(
    transcriptId: string,
  ): Promise<InsertDictationTextResult>;
  collapseForActivity(mode: ActivityMode): Promise<void>;
  restoreMainWindow(): Promise<void>;
  requestActivityAction(action: ActivityAction): Promise<void>;
  getAppSettings(): Promise<AppSettingsSummary>;
  updateAppSettings(
    input: UpdateAppSettingsInput,
  ): Promise<UpdateAppSettingsResult>;
  revealTranscriptsFolder(): Promise<void>;
  revealModelsFolder(): Promise<void>;
  getLocalAiConnection(): Promise<LocalAiConnectionSummary>;
  connectLocalAi(input: ConnectLocalAiInput): Promise<ConnectLocalAiResult>;
  disconnectLocalAi(): Promise<DisconnectLocalAiResult>;
  generateLocalAiMeetingSummary(
    transcriptId: string,
  ): Promise<GenerateLocalAiMeetingSummaryResult>;
  checkForAppUpdate(): Promise<CheckForAppUpdateResult>;
  downloadAppUpdate(): Promise<DownloadAppUpdateResult>;
  cancelAppUpdate(): Promise<void>;
  installAppUpdate(): Promise<InstallAppUpdateResult>;
  onManualUpdateCheck(
    listener: (result: CheckForAppUpdateResult) => void,
  ): () => void;
  onAppUpdateProgress(
    listener: (progress: AppUpdateProgress) => void,
  ): () => void;
  onDictationShortcut(listener: () => void): () => void;
  onActivityAction(listener: (action: ActivityAction) => void): () => void;
  onAppStateChanged(listener: (state: AppState) => void): () => void;
}
