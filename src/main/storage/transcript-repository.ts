import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

import {
  isTranscriptId,
  parseTranscriptRecord,
  TranscriptValidationError,
  type TranscriptId,
  type TranscriptRecord,
} from '../transcription/transcript-types';

export const MAX_TRANSCRIPT_RECORD_BYTES = 64 * 1_024 * 1_024;

const isMissingFileError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const isCorruptRecordError = (error: unknown): boolean =>
  error instanceof SyntaxError || error instanceof TranscriptValidationError;

const isRecordFile = (entry: Dirent): boolean => {
  if (!entry.isFile() || !entry.name.endsWith('.json')) {
    return false;
  }

  return isTranscriptId(entry.name.slice(0, -'.json'.length));
};

export class TranscriptRepository {
  constructor(private readonly rootPath: string) {
    if (rootPath.trim().length === 0) {
      throw new TypeError('Transcript repository root path cannot be empty.');
    }
  }

  async save(record: TranscriptRecord): Promise<TranscriptRecord> {
    const normalized = parseTranscriptRecord(record);
    await this.ensureRoot();

    const destinationPath = this.pathForId(normalized.id);
    const temporaryPath = path.join(
      this.rootPath,
      `${normalized.id}.${randomUUID()}.tmp`,
    );
    const serialized = `${JSON.stringify(normalized, null, 2)}\n`;

    if (Buffer.byteLength(serialized, 'utf8') > MAX_TRANSCRIPT_RECORD_BYTES) {
      throw new TranscriptValidationError(
        `Serialized transcript exceeds ${MAX_TRANSCRIPT_RECORD_BYTES} bytes.`,
      );
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

  async list(): Promise<TranscriptRecord[]> {
    await this.ensureRoot();
    const entries = await readdir(this.rootPath, { withFileTypes: true });
    const records: TranscriptRecord[] = [];

    for (const entry of entries) {
      if (!isRecordFile(entry)) {
        continue;
      }

      const record = await this.readRecord(path.join(this.rootPath, entry.name));
      if (record !== null) {
        records.push(record);
      }
    }

    return records.sort((left, right) => {
      const byCompletedAt =
        Date.parse(right.completedAt) - Date.parse(left.completedAt);
      return byCompletedAt === 0
        ? right.id.localeCompare(left.id)
        : byCompletedAt;
    });
  }

  async get(id: TranscriptId): Promise<TranscriptRecord | null> {
    await this.ensureRoot();
    return this.readRecord(this.pathForId(id));
  }

  async delete(id: TranscriptId): Promise<boolean> {
    await this.ensureRoot();

    try {
      await unlink(this.pathForId(id));
      return true;
    } catch (error) {
      if (isMissingFileError(error)) {
        return false;
      }

      throw error;
    }
  }

  async cleanupTemporaryFiles(): Promise<number> {
    await this.ensureRoot();
    const entries = await readdir(this.rootPath, { withFileTypes: true });
    let removed = 0;

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.tmp')) {
        continue;
      }

      try {
        await unlink(path.join(this.rootPath, entry.name));
        removed += 1;
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
    }

    return removed;
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
  }

  private pathForId(id: TranscriptId): string {
    if (!isTranscriptId(id)) {
      throw new TranscriptValidationError('Transcript id must be a UUID.');
    }

    return path.join(this.rootPath, `${id.toLowerCase()}.json`);
  }

  private async readRecord(filePath: string): Promise<TranscriptRecord | null> {
    let file;

    try {
      file = await open(filePath, 'r');
      const stats = await file.stat();

      if (!stats.isFile() || stats.size > MAX_TRANSCRIPT_RECORD_BYTES) {
        await file.close();
        return null;
      }

      const contents = await file.readFile({ encoding: 'utf8' });
      await file.close();
      file = undefined;

      return parseTranscriptRecord(JSON.parse(contents) as unknown);
    } catch (error) {
      await file?.close().catch(() => undefined);

      if (isMissingFileError(error) || isCorruptRecordError(error)) {
        return null;
      }

      throw error;
    }
  }
}
