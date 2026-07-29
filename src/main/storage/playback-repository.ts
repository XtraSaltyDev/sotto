import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';

import { isTranscriptId } from '../transcription/transcript-types';

export const PLAYBACK_FILE_NAME = 'playback.wav';

export interface PlaybackFileDescriptor {
  path: string;
  sizeBytes: number;
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** Stores only Sotto-created playback audio, keyed by transcript UUID. */
export class PlaybackRepository {
  constructor(private readonly rootPath: string) {
    if (!path.isAbsolute(rootPath)) {
      throw new TypeError('Playback storage must use an absolute path.');
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(this.rootPath, 0o700);
    const entries = await readdir(this.rootPath, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.tmp'))
        .map((entry) => rm(path.join(this.rootPath, entry.name), { force: true })),
    );
  }

  async retain(transcriptId: string, normalizedWavPath: string): Promise<number> {
    const id = this.normalizedId(transcriptId);
    if (!path.isAbsolute(normalizedWavPath)) {
      throw new TypeError('Playback input must use an absolute path.');
    }
    const source = await lstat(normalizedWavPath);
    if (!source.isFile() || source.size < 44) {
      throw new Error('The private playback audio is missing or invalid.');
    }

    await this.initialize();
    const directory = this.directoryPath(id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(directory, 0o700);
    const temporaryPath = path.join(this.rootPath, `${id}.${randomUUID()}.tmp`);
    try {
      await copyFile(normalizedWavPath, temporaryPath, constants.COPYFILE_EXCL);
      if (process.platform !== 'win32') await chmod(temporaryPath, 0o600);
      const temporary = await open(temporaryPath, 'r+');
      try {
        await temporary.sync();
      } finally {
        await temporary.close();
      }
      await rename(temporaryPath, this.filePath(id));
      if (process.platform !== 'win32') await chmod(this.filePath(id), 0o600);
      return source.size;
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      const entries = await readdir(directory).catch(() => []);
      if (entries.length === 0) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  async get(transcriptId: string): Promise<PlaybackFileDescriptor | null> {
    const id = this.normalizedId(transcriptId);
    try {
      const filePath = this.filePath(id);
      const stats = await lstat(filePath);
      if (!stats.isFile() || stats.size < 44) return null;
      return { path: filePath, sizeBytes: stats.size };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async delete(transcriptId: string): Promise<boolean> {
    const id = this.normalizedId(transcriptId);
    const existed = (await this.get(id)) !== null;
    await rm(this.directoryPath(id), { recursive: true, force: true });
    return existed;
  }

  async cleanupOrphans(transcriptIds: ReadonlySet<string>): Promise<number> {
    await this.initialize();
    const entries = await readdir(this.rootPath, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        isTranscriptId(entry.name) &&
        !transcriptIds.has(entry.name.toLowerCase())
      ) {
        await rm(path.join(this.rootPath, entry.name), {
          recursive: true,
          force: true,
        });
        removed += 1;
      }
    }
    return removed;
  }

  private normalizedId(value: string): string {
    if (!isTranscriptId(value)) throw new TypeError('Transcript id must be a UUID.');
    return value.toLowerCase();
  }

  private directoryPath(id: string): string {
    return path.join(this.rootPath, id);
  }

  private filePath(id: string): string {
    return path.join(this.directoryPath(id), PLAYBACK_FILE_NAME);
  }
}
