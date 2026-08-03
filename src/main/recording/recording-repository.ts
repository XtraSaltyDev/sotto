import { randomUUID } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

import { MAX_MEDIA_FILE_BYTES } from '../media/media-import';
import {
  isTranscriptId,
} from '../transcription/transcript-types';
import {
  MAX_RECORDING_METADATA_BYTES,
  parseRecordingMetadata,
  RECORDING_METADATA_SCHEMA_VERSION,
  type RecordingMetadata,
  type RecordingTranscriptionMetadata,
} from './recording-metadata';

export const PARTIAL_RECORDING_FILE_NAME = 'recording.partial.webm';
export const FINALIZING_RECORDING_FILE_NAME = 'recording.finalizing.webm';
export const DURABLE_RECORDING_FILE_NAME = 'recording.webm';
export const RECORDING_METADATA_FILE_NAME = 'metadata.json';

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const isDirectory = (entry: Dirent): boolean =>
  entry.isDirectory() && isTranscriptId(entry.name);

const readRegularFile = async (
  filePath: string,
  maximumBytes: number,
): Promise<Buffer | null> => {
  try {
    const entry = await lstat(filePath);
    if (!entry.isFile() || entry.size > maximumBytes) return null;
    const file = await open(filePath, 'r');
    try {
      return await file.readFile();
    } finally {
      await file.close();
    }
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
};

const safeRecordingSize = async (filePath: string): Promise<number | null> => {
  try {
    const entry = await lstat(filePath);
    if (!entry.isFile() || entry.size <= 0 || entry.size > MAX_MEDIA_FILE_BYTES) {
      return null;
    }
    return entry.size;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
};

const recoveredSourceName = (id: string): string => `Recovered live meeting ${id}.webm`;

const recoveredDate = (fileStats: Stats): string =>
  new Date(fileStats.birthtimeMs || fileStats.mtimeMs).toISOString();

export class RecordingRepository {
  constructor(private readonly rootPath: string) {
    if (!path.isAbsolute(rootPath)) {
      throw new TypeError('The recording repository root must be absolute.');
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    await this.enforcePrivateDirectory(this.rootPath);
    const entries = await readdir(this.rootPath, { withFileTypes: true });
    await Promise.all(
      entries.filter(isDirectory).map((entry) => this.recoverDirectory(entry.name)),
    );
  }

  partialPath(id: string): string {
    return path.join(this.directoryPath(id), PARTIAL_RECORDING_FILE_NAME);
  }

  durablePath(id: string): string {
    return path.join(this.directoryPath(id), DURABLE_RECORDING_FILE_NAME);
  }

  finalizingPath(id: string): string {
    return path.join(this.directoryPath(id), FINALIZING_RECORDING_FILE_NAME);
  }

  async createPartial(metadata: RecordingMetadata): Promise<void> {
    const normalized = parseRecordingMetadata(metadata);
    if (normalized.storageState !== 'partial') {
      throw new TypeError('A new recording must start in partial storage state.');
    }
    const directory = this.directoryPath(normalized.id);
    await mkdir(directory, { recursive: false, mode: 0o700 });
    await this.enforcePrivateDirectory(directory);
    try {
      await this.save(normalized);
    } catch (error) {
      await rm(directory, { force: true, recursive: true }).catch(() => undefined);
      throw error;
    }
  }

  async save(metadata: RecordingMetadata): Promise<RecordingMetadata> {
    const normalized = parseRecordingMetadata(metadata);
    const directory = this.directoryPath(normalized.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.enforcePrivateDirectory(directory);
    const destinationPath = path.join(directory, RECORDING_METADATA_FILE_NAME);
    const temporaryPath = `${destinationPath}.${randomUUID()}.tmp`;
    const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORDING_METADATA_BYTES) {
      throw new Error('Serialized recording metadata is too large.');
    }

    const file = await open(temporaryPath, 'wx', 0o600);
    try {
      await file.writeFile(serialized, { encoding: 'utf8' });
      await file.sync();
      await file.close();
    } catch (error) {
      await file.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }

    try {
      await rename(temporaryPath, destinationPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return normalized;
  }

  async get(id: string): Promise<RecordingMetadata | null> {
    if (!isTranscriptId(id)) return null;
    return this.readMetadata(this.directoryPath(id));
  }

  async list(): Promise<RecordingMetadata[]> {
    await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    await this.enforcePrivateDirectory(this.rootPath);
    const entries = await readdir(this.rootPath, { withFileTypes: true });
    const records: RecordingMetadata[] = [];
    for (const entry of entries) {
      if (!isDirectory(entry)) continue;
      const metadata = await this.readMetadata(this.directoryPath(entry.name));
      if (!metadata || metadata.storageState !== 'complete') continue;
      if ((await safeRecordingSize(this.durablePath(metadata.id))) === null) continue;
      records.push(metadata);
    }
    return records.sort(
      (left, right) => Date.parse(right.completedAt ?? '') - Date.parse(left.completedAt ?? ''),
    );
  }

  async promotePartial(id: string): Promise<number> {
    if (!isTranscriptId(id)) throw new TypeError('Recording id must be a UUID.');
    const partialPath = this.partialPath(id);
    const durablePath = this.durablePath(id);
    const sizeBytes = await safeRecordingSize(partialPath);
    if (sizeBytes === null) {
      throw new Error('The partial live recording is missing or invalid.');
    }
    // Windows requires write access on a handle passed to FlushFileBuffers,
    // which is what FileHandle.sync() uses under the hood.
    const partialFile = await open(partialPath, 'r+');
    try {
      await partialFile.sync();
    } finally {
      await partialFile.close();
    }
    await rename(partialPath, durablePath);
    if (process.platform !== 'win32') await chmod(durablePath, 0o600);
    return sizeBytes;
  }

  async markFinalizing(
    id: string,
    completedAt: string,
  ): Promise<number> {
    if (!isTranscriptId(id)) throw new TypeError('Recording id must be a UUID.');
    const current = await this.get(id);
    if (!current || current.storageState !== 'partial') {
      throw new Error('The partial recording metadata is missing or invalid.');
    }
    const sizeBytes = await safeRecordingSize(this.partialPath(id));
    if (sizeBytes === null) {
      throw new Error('The partial live recording is missing or invalid.');
    }
    await rename(this.partialPath(id), this.finalizingPath(id));
    if (process.platform !== 'win32') {
      await chmod(this.finalizingPath(id), 0o600);
    }
    const finalizingFile = await open(this.finalizingPath(id), 'r+');
    try {
      await finalizingFile.sync();
    } finally {
      await finalizingFile.close();
    }
    await this.save({
      ...current,
      completedAt,
      sizeBytes,
      storageState: 'finalizing',
      transcription: {
        state: 'ready',
        updatedAt: completedAt,
        message: 'Recording closed locally. Finalizing its saved file.',
      },
    });
    return sizeBytes;
  }

  async promoteFinalizing(id: string): Promise<number> {
    if (!isTranscriptId(id)) throw new TypeError('Recording id must be a UUID.');
    const finalizingPath = this.finalizingPath(id);
    const sizeBytes = await safeRecordingSize(finalizingPath);
    if (sizeBytes === null) {
      throw new Error('The closed live recording is missing or invalid.');
    }
    const finalizingFile = await open(finalizingPath, 'r+');
    try {
      await finalizingFile.sync();
    } finally {
      await finalizingFile.close();
    }
    await rename(finalizingPath, this.durablePath(id));
    if (process.platform !== 'win32') await chmod(this.durablePath(id), 0o600);
    return sizeBytes;
  }

  async removeUnfinished(id: string): Promise<void> {
    if (!isTranscriptId(id)) return;
    let durableIsRegular = false;
    try {
      durableIsRegular = (await lstat(this.durablePath(id))).isFile();
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (durableIsRegular) {
      await unlink(this.partialPath(id)).catch((error) => {
        if (!isMissing(error)) throw error;
      });
      await unlink(this.finalizingPath(id)).catch((error) => {
        if (!isMissing(error)) throw error;
      });
      return;
    }
    await rm(this.directoryPath(id), { force: true, recursive: true });
  }

  async delete(id: string): Promise<boolean> {
    if (!isTranscriptId(id)) return false;
    const directory = this.directoryPath(id);
    try {
      await lstat(directory);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    await rm(directory, { force: true, recursive: true });
    return true;
  }

  async updateTranscription(
    id: string,
    transcription: RecordingTranscriptionMetadata,
  ): Promise<RecordingMetadata | null> {
    const current = await this.get(id);
    if (!current || current.storageState !== 'complete') return null;
    return this.save({ ...current, transcription });
  }

  async completeMetadata(
    id: string,
    sizeBytes: number,
    completedAt: string,
  ): Promise<RecordingMetadata> {
    const current = await this.get(id);
    if (!current) throw new Error('Recording metadata is missing.');
    return this.save({
      ...current,
      completedAt,
      sizeBytes,
      storageState: 'complete',
      transcription: {
        state: 'ready',
        updatedAt: completedAt,
        message: 'Recording saved locally. Ready to transcribe.',
      },
    });
  }

  /**
   * Preserve an interrupted capture. A non-empty partial file is usually a
   * decodable audio prefix, so it is promoted to the durable name and
   * registered as a recovered recording instead of being discarded. An
   * empty partial has nothing to keep and is removed.
   */
  async recoverInterrupted(id: string): Promise<RecordingMetadata | null> {
    if (!isTranscriptId(id)) return null;
    const partialSize = await safeRecordingSize(this.partialPath(id));
    if (partialSize === null || partialSize === 0) {
      await this.removeUnfinished(id);
      return null;
    }
    await this.promotePartial(id);
    return this.recoverFinalized(id);
  }

  async recoverFinalized(id: string): Promise<RecordingMetadata | null> {
    if (!isTranscriptId(id)) return null;
    const durablePath = this.durablePath(id);
    const sizeBytes = await safeRecordingSize(durablePath);
    if (sizeBytes === null) return null;
    const fileStats = await stat(durablePath);
    const current = await this.get(id);
    if (current?.storageState === 'complete') {
      if (current.sizeBytes !== sizeBytes) {
        return this.save({ ...current, sizeBytes });
      }
      return current;
    }
    const startedAt = current?.startedAt ?? recoveredDate(fileStats);
    const completedAt = current?.completedAt ?? new Date(fileStats.mtimeMs).toISOString();
    return this.save({
      schemaVersion: RECORDING_METADATA_SCHEMA_VERSION,
      id,
      sourceName: current?.sourceName ?? recoveredSourceName(id),
      startedAt,
      completedAt,
      sizeBytes,
      storageState: 'complete',
      transcription: {
        state: 'ready',
        updatedAt: completedAt,
        message: 'Recording recovered locally. Ready to transcribe.',
      },
    });
  }

  private async recoverDirectory(id: string): Promise<void> {
    await this.enforcePrivateDirectory(this.directoryPath(id));
    let durableIsRegular = false;
    try {
      durableIsRegular = (await lstat(this.durablePath(id))).isFile();
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (durableIsRegular) {
      await this.enforcePrivateFile(this.durablePath(id));
      await this.enforcePrivateFile(
        path.join(this.directoryPath(id), RECORDING_METADATA_FILE_NAME),
      );
      await this.recoverFinalized(id);
      await unlink(this.partialPath(id)).catch((error) => {
        if (!isMissing(error)) throw error;
      });
      await unlink(this.finalizingPath(id)).catch((error) => {
        if (!isMissing(error)) throw error;
      });
      const metadata = await this.get(id);
      if (metadata?.transcription.state === 'transcribing') {
        await this.save({
          ...metadata,
          transcription: {
            state: 'failed',
            updatedAt: new Date().toISOString(),
            message: 'Sotto was closed before transcription finished. Retry transcription to continue.',
            errorCode: 'transcription-failed',
            ...(metadata.transcription.jobId
              ? { jobId: metadata.transcription.jobId }
              : {}),
          },
        });
      }
      return;
    }

    const metadata = await this.get(id);
    const finalizingSize = await safeRecordingSize(this.finalizingPath(id));
    if (finalizingSize !== null || metadata?.storageState === 'finalizing') {
      // The encoder closed successfully before the previous process stopped.
      // Preserve and retry this atomic promotion instead of treating the file
      // as an interrupted capture. A failed retry leaves the marker and audio
      // in place for the next launch.
      try {
        await this.enforcePrivateFile(this.finalizingPath(id));
        await this.promoteFinalizing(id);
        await this.recoverFinalized(id);
      } catch {
        // Recovery is deliberately best-effort here. The caller can still
        // start, and no user audio is deleted after a clean encoder close.
      }
      return;
    }

    // A directory with only an ordinary partial file is an interrupted
    // capture. The captured prefix is user audio: promote it to a durable
    // recovered recording rather than discarding it. Only a directory with
    // no usable audio at all is removed; a failed promotion leaves
    // everything in place for the next launch to retry.
    const partialSize = await safeRecordingSize(this.partialPath(id));
    if (partialSize !== null && partialSize > 0) {
      try {
        await this.enforcePrivateFile(this.partialPath(id));
        await this.promotePartial(id);
        await this.recoverFinalized(id);
      } catch {
        // Deliberately best-effort: never delete interrupted audio.
      }
      return;
    }
    await rm(this.directoryPath(id), { force: true, recursive: true });
  }

  private async readMetadata(directory: string): Promise<RecordingMetadata | null> {
    const contents = await readRegularFile(
      path.join(directory, RECORDING_METADATA_FILE_NAME),
      MAX_RECORDING_METADATA_BYTES,
    );
    if (!contents) return null;
    try {
      return parseRecordingMetadata(JSON.parse(contents.toString('utf8')) as unknown);
    } catch {
      return null;
    }
  }

  private directoryPath(id: string): string {
    if (!isTranscriptId(id)) throw new TypeError('Recording id must be a UUID.');
    return path.join(this.rootPath, id.toLowerCase());
  }

  private async enforcePrivateDirectory(directory: string): Promise<void> {
    if (process.platform !== 'win32') await chmod(directory, 0o700);
  }

  private async enforcePrivateFile(filePath: string): Promise<void> {
    if (process.platform === 'win32') return;
    try {
      if ((await lstat(filePath)).isFile()) await chmod(filePath, 0o600);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}
