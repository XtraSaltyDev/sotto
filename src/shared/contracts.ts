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
  cancelTranscription: 'sotto:transcription:cancel',
  getTranscript: 'sotto:transcript:get',
  deleteTranscript: 'sotto:transcript:delete',
  exportTranscript: 'sotto:transcript:export',
  stateChanged: 'sotto:state:changed',
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
  state: 'ready' | 'unsupported';
  message: string;
}

export interface LiveRecordingSnapshot {
  id: string;
  sourceName: string;
  startedAt: string;
  bytesWritten: number;
}

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
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscriptDetail extends TranscriptSummary {
  completedAt: string;
  text: string;
  segments: TranscriptSegment[];
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
}

export type ImportMediaResult =
  | { outcome: 'cancelled' }
  | { outcome: 'rejected'; reason: string; code: TranscriptionErrorCode }
  | { outcome: 'started'; job: TranscriptionJobSnapshot };

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

export type CancelTranscriptionResult =
  | { outcome: 'cancelled' }
  | { outcome: 'not-found' };

export type DeleteTranscriptResult =
  | { outcome: 'deleted' }
  | { outcome: 'not-found' };

export type ExportTranscriptResult =
  | { outcome: 'cancelled' }
  | { outcome: 'saved'; fileName: string }
  | { outcome: 'not-found' }
  | { outcome: 'failed'; reason: string };

export interface SottoDesktopApi {
  getAppState(): Promise<AppState>;
  importMedia(): Promise<ImportMediaResult>;
  startLiveRecording(): Promise<StartLiveRecordingResult>;
  appendLiveRecordingChunk(
    recordingId: string,
    chunk: ArrayBuffer,
  ): Promise<AppendLiveRecordingChunkResult>;
  finishLiveRecording(recordingId: string): Promise<FinishLiveRecordingResult>;
  cancelLiveRecording(recordingId: string): Promise<CancelLiveRecordingResult>;
  retryRecording(recordingId: string): Promise<RetryRecordingResult>;
  deleteRecording(recordingId: string): Promise<DeleteRecordingResult>;
  exportRecording(recordingId: string): Promise<ExportRecordingResult>;
  cancelTranscription(jobId: string): Promise<CancelTranscriptionResult>;
  getTranscript(transcriptId: string): Promise<TranscriptDetail | null>;
  deleteTranscript(transcriptId: string): Promise<DeleteTranscriptResult>;
  exportTranscript(transcriptId: string): Promise<ExportTranscriptResult>;
  onAppStateChanged(listener: (state: AppState) => void): () => void;
}
