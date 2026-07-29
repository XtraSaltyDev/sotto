import { createWriteStream } from 'node:fs';
import { lstat, statfs } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import type {
  AppendLiveRecordingChunkResult,
  LiveRecordingErrorCode,
  LiveRecordingSnapshot,
  SavedRecordingSummary,
  TranscriptionErrorCode,
} from '../../shared/contracts';
import {
  MAX_MEDIA_FILE_BYTES,
  validateSelectedMedia,
  type SelectedMedia,
} from '../media/media-import';
import { createTranscriptId, isTranscriptId } from '../transcription/transcript-types';
import {
  RecordingRepository,
} from './recording-repository';
import {
  toSavedRecordingSummary,
  type RecordingMetadata,
  type RecordingTranscriptionMetadata,
} from './recording-metadata';

export const MAX_LIVE_RECORDING_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_LIVE_RECORDING_WRITE_WAIT_MS = 15_000;
export const MIN_LIVE_RECORDING_FREE_BYTES = 512 * 1024 * 1024;

export class LiveRecordingError extends Error {
  constructor(
    readonly code: LiveRecordingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LiveRecordingError';
  }
}

interface RecordingStream extends EventEmitter {
  write(
    chunk: Uint8Array,
    callback?: (error?: Error | null) => void,
  ): boolean;
  end(callback?: () => void): this;
  destroy(error?: Error): this;
}

export interface LiveRecordingServiceOptions {
  recordingsRoot: string;
  onRecordingChanged: (recording: LiveRecordingSnapshot | null) => void;
  writeWaitMs?: number;
  minimumFreeBytes?: number;
  getAvailableBytes?: (recordingsRoot: string) => Promise<number | null>;
  createStream?: (filePath: string) => RecordingStream;
}

interface ActiveRecording {
  readonly id: string;
  readonly sourceName: string;
  readonly startedAt: string;
  readonly stream: RecordingStream;
  writeQueue: Promise<void>;
  pendingReject: ((error: unknown) => void) | null;
  streamError: Error | null;
  bytesWritten: number;
  failed: boolean;
}

type LiveRecordingOperation =
  | { readonly kind: 'starting' }
  | {
      readonly kind: 'cancelling' | 'finishing';
      readonly recordingId: string;
    };

const snapshot = (recording: ActiveRecording): LiveRecordingSnapshot => ({
  id: recording.id,
  sourceName: recording.sourceName,
  startedAt: recording.startedAt,
  bytesWritten: recording.bytesWritten,
});

const sourceNameFor = (startedAt: string): string => {
  const stamp = startedAt
    .replace(/[:.]/gu, '-')
    .replace('T', '_')
    .replace('Z', '');
  return `Live meeting ${stamp}.webm`;
};

const asBuffer = (chunk: Uint8Array): Buffer =>
  Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error ? String(error.code) : undefined;

const asLiveRecordingError = (
  error: unknown,
  fallback = 'Sotto could not save the live recording to this device.',
): LiveRecordingError => {
  if (error instanceof LiveRecordingError) return error;
  if (errorCode(error) === 'ENOSPC' || errorCode(error) === 'EDQUOT') {
    return new LiveRecordingError(
      'storage-full',
      'Sotto ran out of local storage while saving this recording.',
    );
  }
  return new LiveRecordingError(
    'recording-failed',
    fallback,
  );
};

const metadataFor = (
  id: string,
  sourceName: string,
  startedAt: string,
): RecordingMetadata => ({
  schemaVersion: 1,
  id,
  sourceName,
  startedAt,
  completedAt: null,
  sizeBytes: 0,
  storageState: 'partial',
  transcription: {
    state: 'ready',
    updatedAt: startedAt,
    message: 'Recording in progress.',
  },
});

const waitForOpen = (
  stream: RecordingStream,
  timeoutMs: number,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener('open', onOpen);
      stream.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onOpen = (): void => {
      settle();
    };
    const onError = (error: Error): void => {
      settle(error);
    };
    const timer = setTimeout(() => {
      const timeout = new LiveRecordingError(
        'recording-failed',
        'Sotto timed out while opening the private recording file.',
      );
      settle(timeout);
      stream.destroy(timeout);
    }, timeoutMs);
    timer.unref?.();
    stream.once('open', onOpen);
    stream.once('error', onError);
  });

const defaultAvailableBytes = async (
  recordingsRoot: string,
): Promise<number | null> => {
  try {
    const stats = await statfs(recordingsRoot);
    const available = stats.bavail * stats.bsize;
    return Number.isSafeInteger(available) && available >= 0 ? available : null;
  } catch {
    return null;
  }
};

export class LiveRecordingService {
  private activeRecording: ActiveRecording | null = null;
  private operation: LiveRecordingOperation | null = null;
  private readonly repository: RecordingRepository;
  private readonly writeWaitMs: number;
  private readonly minimumFreeBytes: number;
  private readonly getAvailableBytes: (
    recordingsRoot: string,
  ) => Promise<number | null>;
  private readonly createStream: (filePath: string) => RecordingStream;

  constructor(private readonly options: LiveRecordingServiceOptions) {
    if (!path.isAbsolute(options.recordingsRoot)) {
      throw new TypeError('The live recordings root must be absolute.');
    }
    this.repository = new RecordingRepository(options.recordingsRoot);
    this.writeWaitMs = options.writeWaitMs ?? MAX_LIVE_RECORDING_WRITE_WAIT_MS;
    if (!Number.isSafeInteger(this.writeWaitMs) || this.writeWaitMs <= 0) {
      throw new TypeError('The live recording write timeout must be positive.');
    }
    this.minimumFreeBytes =
      options.minimumFreeBytes ?? MIN_LIVE_RECORDING_FREE_BYTES;
    if (
      !Number.isSafeInteger(this.minimumFreeBytes) ||
      this.minimumFreeBytes < 0
    ) {
      throw new TypeError('The live recording free-space reserve must be non-negative.');
    }
    this.getAvailableBytes = options.getAvailableBytes ?? defaultAvailableBytes;
    this.createStream = options.createStream ?? ((filePath) =>
      createWriteStream(filePath, { flags: 'wx', mode: 0o600 }));
  }

  async initialize(): Promise<void> {
    await this.repository.initialize();
  }

  getActive(): LiveRecordingSnapshot | null {
    return this.activeRecording ? snapshot(this.activeRecording) : null;
  }

  hasActiveOrPendingRecording(): boolean {
    return this.activeRecording !== null || this.operation !== null;
  }

  async listSavedRecordings(): Promise<SavedRecordingSummary[]> {
    const recordings = await this.repository.list();
    return recordings.map(toSavedRecordingSummary);
  }

  async getSavedRecording(id: string): Promise<RecordingMetadata | null> {
    return this.repository.get(id);
  }

  async getRecordingMedia(id: string): Promise<SelectedMedia | null> {
    if (!isTranscriptId(id)) return null;
    const metadata = await this.repository.get(id);
    if (!metadata || metadata.storageState !== 'complete') return null;
    const filePath = this.repository.durablePath(id);
    const fileStats = await this.safeDurableStat(filePath);
    if (!fileStats) return null;
    const validation = validateSelectedMedia(filePath, fileStats.size);
    if (!validation.ok) return null;
    return {
      ...validation.media,
      name: metadata.sourceName,
      sourceType: 'recording',
      recordingId: metadata.id,
      cleanupAfterTranscription: false,
    };
  }

  getMediaForTranscription(id: string): Promise<SelectedMedia | null> {
    return this.getRecordingMedia(id);
  }

  async getExportDescriptor(
    id: string,
  ): Promise<{ fileName: string; path: string; sizeBytes: number } | null> {
    const media = await this.getRecordingMedia(id);
    return media
      ? { fileName: media.name, path: media.path, sizeBytes: media.sizeBytes }
      : null;
  }

  async has(id: string): Promise<boolean> {
    return (await this.getRecordingMedia(id)) !== null;
  }

  async start(): Promise<LiveRecordingSnapshot> {
    if (this.activeRecording || this.operation) {
      throw new LiveRecordingError('busy', 'A live recording is already in progress.');
    }

    const operation = { kind: 'starting' } as const;
    this.operation = operation;

    try {
      const availableBytes = await this.getAvailableBytes(
        this.options.recordingsRoot,
      );
      if (
        availableBytes !== null &&
        availableBytes < this.minimumFreeBytes
      ) {
        throw new LiveRecordingError(
          'storage-full',
          'This device has less than 512 MB free. Free up space before starting a live recording.',
        );
      }

      const id = createTranscriptId();
      const startedAt = new Date().toISOString();
      const sourceName = sourceNameFor(startedAt);
      let recording: ActiveRecording | null = null;
      try {
        await this.repository.createPartial(metadataFor(id, sourceName, startedAt));
        const stream = this.createStream(this.repository.partialPath(id));
        recording = {
          id,
          sourceName,
          startedAt,
          stream,
          writeQueue: Promise.resolve(),
          pendingReject: null,
          streamError: null,
          bytesWritten: 0,
          failed: false,
        };
        stream.on('error', (error: Error) => {
          if (!recording) return;
          recording.streamError = error;
          recording.pendingReject?.(error);
        });
        await waitForOpen(stream, this.writeWaitMs);
      } catch (error) {
        recording?.stream.destroy();
        await this.repository.removeUnfinished(id).catch(() => undefined);
        throw asLiveRecordingError(error, 'Sotto could not create a private partial recording.');
      }

      this.activeRecording = recording;
      this.publish();
      return snapshot(recording);
    } finally {
      if (this.operation === operation) this.operation = null;
    }
  }

  async append(
    recordingId: string,
    chunk: Uint8Array,
  ): Promise<AppendLiveRecordingChunkResult> {
    const recording = this.assertActive(recordingId);
    if (
      this.operation &&
      this.operation.kind !== 'starting' &&
      this.operation.recordingId === recording.id
    ) {
      throw new LiveRecordingError(
        'busy',
        'The live recording is already being finalized.',
      );
    }
    if (chunk.byteLength === 0) {
      return { outcome: 'accepted', bytesWritten: recording.bytesWritten };
    }
    if (chunk.byteLength > MAX_LIVE_RECORDING_CHUNK_BYTES) {
      return {
        outcome: 'rejected',
        reason: 'The recording chunk was larger than the allowed limit.',
        code: 'recording-failed',
      };
    }
    let rejectedForSize = false;
    const operation = recording.writeQueue.then(async () => {
      if (recording.bytesWritten + chunk.byteLength > MAX_MEDIA_FILE_BYTES) {
        rejectedForSize = true;
        return;
      }
      await this.writeChunk(recording, chunk);
      recording.bytesWritten += chunk.byteLength;
      this.publish();
    });
    recording.writeQueue = operation.catch(() => undefined);
    try {
      await operation;
      if (rejectedForSize) {
        return {
          outcome: 'rejected',
          reason: 'The live recording reached the 20 GB limit.',
          code: 'recording-failed',
        };
      }
      return { outcome: 'accepted', bytesWritten: recording.bytesWritten };
    } catch (error) {
      const failure = asLiveRecordingError(error);
      recording.streamError = failure;
      await this.failActive(recording);
      throw failure;
    }
  }

  async finish(recordingId: string): Promise<SelectedMedia> {
    const recording = this.assertActive(recordingId);
    if (this.operation) {
      throw new LiveRecordingError(
        'busy',
        'The live recording is already being finalized.',
      );
    }
    const operation = {
      kind: 'finishing',
      recordingId: recording.id,
    } as const;
    this.operation = operation;

    let encoderClosed = false;
    try {
      await recording.writeQueue;
      if (recording.streamError) throw recording.streamError;
      await this.endStream(recording);
      encoderClosed = true;
      const completedAt = new Date().toISOString();
      await this.repository.markFinalizing(recording.id, completedAt);
      const sizeBytes = await this.repository.promoteFinalizing(recording.id);
      await this.repository.completeMetadata(recording.id, sizeBytes, completedAt);
      const filePath = this.repository.durablePath(recording.id);
      const validation = validateSelectedMedia(filePath, sizeBytes);
      if (!validation.ok) throw new LiveRecordingError('recording-failed', validation.reason);
      return {
        ...validation.media,
        name: recording.sourceName,
        sourceType: 'recording',
        recordingId: recording.id,
        cleanupAfterTranscription: false,
      };
    } catch (error) {
      if (!encoderClosed) {
        await this.repository.removeUnfinished(recording.id).catch(() => undefined);
      }
      throw asLiveRecordingError(
        error,
        encoderClosed
          ? 'Sotto could not finish saving the recording, but the closed audio was kept for automatic recovery after restart.'
          : 'Sotto could not finish saving the live recording.',
      );
    } finally {
      if (this.activeRecording?.id === recording.id) {
        this.activeRecording = null;
        this.options.onRecordingChanged(null);
      }
      if (this.operation === operation) this.operation = null;
    }
  }

  async cancel(recordingId: string): Promise<boolean> {
    const recording = this.assertActive(recordingId, false);
    if (!recording) return false;
    if (this.operation) return false;

    const operation = {
      kind: 'cancelling',
      recordingId: recording.id,
    } as const;
    this.operation = operation;

    try {
      recording.failed = true;
      recording.pendingReject?.(
        new LiveRecordingError(
          'recording-failed',
          'The incomplete live recording was cancelled.',
        ),
      );
      recording.stream.destroy();
      await recording.writeQueue.catch(() => undefined);
      await this.repository.removeUnfinished(recording.id);
      return true;
    } finally {
      if (this.activeRecording?.id === recording.id) {
        this.activeRecording = null;
        this.options.onRecordingChanged(null);
      }
      if (this.operation === operation) this.operation = null;
    }
  }

  async updateTranscription(
    recordingId: string,
    transcription: RecordingTranscriptionMetadata,
  ): Promise<void> {
    const updated = await this.repository.updateTranscription(
      recordingId,
      transcription,
    );
    if (!updated) {
      throw new LiveRecordingError(
        'recording-failed',
        'That saved recording is no longer available.',
      );
    }
  }

  async markTranscribing(recordingId: string, jobId: string): Promise<void> {
    await this.updateTranscription(recordingId, {
      state: 'transcribing',
      updatedAt: new Date().toISOString(),
      message: 'Transcribing locally. The original recording will be kept.',
      jobId,
    });
  }

  async markTranscriptionCompleted(
    recordingId: string,
    jobId: string,
    transcriptId: string,
  ): Promise<void> {
    await this.updateTranscription(recordingId, {
      state: 'completed',
      updatedAt: new Date().toISOString(),
      message: 'Transcript ready. The original recording is still saved.',
      jobId,
      transcriptId,
    });
  }

  async markTranscriptionFailed(
    recordingId: string,
    jobId: string,
    failureCode: TranscriptionErrorCode,
    message: string,
  ): Promise<void> {
    await this.updateTranscription(recordingId, {
      state: 'failed',
      updatedAt: new Date().toISOString(),
      message: `${message} The original recording is still saved.`.slice(0, 2_000),
      errorCode: failureCode,
      jobId,
    });
  }

  async markTranscriptionCancelled(
    recordingId: string,
    jobId: string,
  ): Promise<void> {
    await this.updateTranscription(recordingId, {
      state: 'cancelled',
      updatedAt: new Date().toISOString(),
      message:
        'Transcription was cancelled. The original recording is still saved and can be retried.',
      jobId,
    });
  }

  async markReady(recordingId: string, message: string): Promise<void> {
    await this.updateTranscription(recordingId, {
      state: 'ready',
      updatedAt: new Date().toISOString(),
      message,
    });
  }

  async reconcileTranscripts(transcriptIds: ReadonlySet<string>): Promise<void> {
    const recordings = await this.repository.list();
    for (const recording of recordings) {
      if (
        transcriptIds.has(recording.id) &&
        recording.transcription.state !== 'completed'
      ) {
        await this.markTranscriptionCompleted(
          recording.id,
          recording.id,
          recording.id,
        );
      } else if (
        !transcriptIds.has(recording.id) &&
        recording.transcription.state === 'completed'
      ) {
        await this.markReady(
          recording.id,
          'The transcript was deleted. The original recording is ready to transcribe again.',
        );
      }
    }
  }

  async delete(recordingId: string): Promise<boolean> {
    if (
      isTranscriptId(recordingId) &&
      this.activeRecording?.id === recordingId.toLowerCase()
    ) {
      return false;
    }
    return this.repository.delete(recordingId);
  }

  async clearTranscriptLink(recordingId: string): Promise<void> {
    const metadata = await this.repository.get(recordingId);
    if (!metadata || metadata.storageState !== 'complete') return;
    await this.repository.updateTranscription(recordingId, {
      state: 'ready',
      updatedAt: new Date().toISOString(),
      message: 'Transcript deleted. Ready to transcribe again.',
    });
  }

  durablePath(recordingId: string): string {
    return this.repository.durablePath(recordingId);
  }

  async dispose(): Promise<void> {
    if (this.activeRecording) await this.cancel(this.activeRecording.id);
  }

  private async writeChunk(recording: ActiveRecording, chunk: Uint8Array): Promise<void> {
    if (recording.failed || recording.streamError) {
      throw recording.streamError ?? new LiveRecordingError(
        'recording-failed',
        'The live recording is no longer writable.',
      );
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        const timeout = new LiveRecordingError(
          'recording-failed',
          'Sotto could not keep up with local storage while recording. The capture was stopped.',
        );
        recording.streamError = timeout;
        recording.stream.destroy(timeout);
        settle(timeout);
      }, this.writeWaitMs);
      timer.unref?.();

      const settle = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        recording.pendingReject = null;
        if (error) reject(error);
        else resolve();
      };

      recording.pendingReject = settle;
      try {
        // The callback runs after this chunk has left the stream's internal
        // buffer. The timeout bounds both a stalled write callback and
        // prolonged backpressure.
        recording.stream.write(asBuffer(chunk), (error) => settle(error));
      } catch (error) {
        settle(error);
      }
    });
  }

  private async endStream(recording: ActiveRecording): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        const timeout = new LiveRecordingError(
          'recording-failed',
          'Sotto timed out while closing the live recording.',
        );
        recording.stream.destroy(timeout);
        settle(timeout);
      }, this.writeWaitMs);
      timer.unref?.();
      const settle = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        recording.pendingReject = null;
        recording.stream.removeListener('close', onClose);
        recording.stream.removeListener('error', onError);
        if (error) reject(error);
        else resolve();
      };
      const onClose = (): void => settle();
      const onError = (error: Error): void => settle(error);
      recording.pendingReject = settle;
      recording.stream.once('close', onClose);
      recording.stream.once('error', onError);
      try {
        recording.stream.end();
      } catch (error) {
        settle(error);
      }
    });
  }

  private async failActive(recording: ActiveRecording): Promise<void> {
    if (recording.failed) return;
    recording.failed = true;
    if (this.activeRecording?.id === recording.id) {
      this.activeRecording = null;
      this.options.onRecordingChanged(null);
    }
    recording.stream.destroy();
    await this.repository.removeUnfinished(recording.id).catch(() => undefined);
  }

  private async safeDurableStat(filePath: string): Promise<{ size: number } | null> {
    try {
      const stats = await lstat(filePath);
      return stats.isFile() && stats.size > 0 && stats.size <= MAX_MEDIA_FILE_BYTES
        ? { size: stats.size }
        : null;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw asLiveRecordingError(
        error,
        'Sotto could not read the saved recording.',
      );
    }
  }

  private assertActive(recordingId: string): ActiveRecording;
  private assertActive(
    recordingId: string,
    throwIfMissing: false,
  ): ActiveRecording | null;
  private assertActive(
    recordingId: string,
    throwIfMissing = true,
  ): ActiveRecording | null {
    if (
      !isTranscriptId(recordingId) ||
      !this.activeRecording ||
      this.activeRecording.id !== recordingId.toLowerCase()
    ) {
      if (throwIfMissing) {
        throw new LiveRecordingError('recording-failed', 'That live recording is no longer active.');
      }
      return null;
    }
    return this.activeRecording;
  }

  private publish(): void {
    this.options.onRecordingChanged(
      this.activeRecording ? snapshot(this.activeRecording) : null,
    );
  }
}
