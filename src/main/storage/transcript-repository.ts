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
  isTranscriptSpeakerId,
  isTranscriptId,
  normalizeTranscriptTags,
  normalizeTranscriptTitle,
  normalizeTranscriptSegmentText,
  normalizeSpeakerLabel,
  parseTranscriptRecord,
  TranscriptValidationError,
  type TranscriptId,
  type TranscriptRecord,
  type TranscriptSpeaker,
  type TranscriptSpeakerId,
} from '../transcription/transcript-types';

export const MAX_TRANSCRIPT_RECORD_BYTES = 64 * 1_024 * 1_024;

export type RenameSpeakerLabelResult =
  | {
      outcome: 'renamed';
      record: TranscriptRecord;
      speaker: TranscriptSpeaker;
    }
  | { outcome: 'not-found' };

export type UpdateSegmentTextResult =
  | {
      outcome: 'updated';
      record: TranscriptRecord;
      segment: TranscriptRecord['segments'][number];
    }
  | { outcome: 'not-found' };

export type UpdateTranscriptMetadataResult =
  | {
      outcome: 'updated';
      record: TranscriptRecord;
    }
  | { outcome: 'not-found' };

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
  private mutationChain: Promise<void> = Promise.resolve();

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

  /** Reads only after transcript mutations already queued have settled. */
  getAfterPendingMutations(
    id: TranscriptId,
  ): Promise<TranscriptRecord | null> {
    return this.serializeMutation(() => this.get(id));
  }

  async updateSegmentText(
    transcriptId: TranscriptId,
    segmentIndex: number,
    text: string,
  ): Promise<UpdateSegmentTextResult> {
    if (!isTranscriptId(transcriptId)) {
      throw new TranscriptValidationError('Transcript id must be a UUID.');
    }
    if (!Number.isSafeInteger(segmentIndex) || segmentIndex < 0) {
      throw new TranscriptValidationError('Transcript segment index is invalid.');
    }

    const normalizedTranscriptId = transcriptId.toLowerCase();
    const normalizedText = normalizeTranscriptSegmentText(text);

    return this.serializeMutation(async () => {
      const current = await this.get(normalizedTranscriptId);
      const currentSegment = current?.segments[segmentIndex];
      if (!current || !currentSegment) return { outcome: 'not-found' };

      if (currentSegment.text === normalizedText) {
        return { outcome: 'updated', record: current, segment: currentSegment };
      }

      const segment = {
        ...currentSegment,
        text: normalizedText,
        // Corrected prose no longer has a reliable one-to-one relationship
        // with the original Whisper tokens. Segment-level seeking remains.
        words: [],
      };
      const segments = current.segments.map((candidate, index) =>
        index === segmentIndex ? segment : candidate,
      );
      const record = await this.save({
        ...current,
        text: segments
          .map((candidate) => candidate.text)
          .filter((candidate) => candidate.length > 0)
          .join(' '),
        segments,
      });

      return { outcome: 'updated', record, segment: record.segments[segmentIndex] };
    });
  }

  async renameSpeakerLabel(
    transcriptId: TranscriptId,
    speakerId: TranscriptSpeakerId,
    label: string,
  ): Promise<RenameSpeakerLabelResult> {
    if (!isTranscriptId(transcriptId)) {
      throw new TranscriptValidationError('Transcript id must be a UUID.');
    }
    if (!isTranscriptSpeakerId(speakerId)) {
      throw new TranscriptValidationError('Speaker id must be a UUID.');
    }

    const normalizedTranscriptId = transcriptId.toLowerCase();
    const normalizedSpeakerId = speakerId.toLowerCase();
    const normalizedLabel = normalizeSpeakerLabel(label);

    return this.serializeMutation(async () => {
      const current = await this.get(normalizedTranscriptId);
      const speakerAnalysis = current?.speakerAnalysis;
      const speakers = speakerAnalysis?.speakers;
      const speakerIndex = speakers?.findIndex(
        (speaker) => speaker.id === normalizedSpeakerId,
      );

      if (
        !current ||
        !speakerAnalysis ||
        !speakers ||
        speakerIndex === undefined ||
        speakerIndex < 0
      ) {
        return { outcome: 'not-found' };
      }

      const speaker: TranscriptSpeaker = {
        ...speakers[speakerIndex],
        label: normalizedLabel,
      };

      if (speakers[speakerIndex].label === normalizedLabel) {
        return { outcome: 'renamed', record: current, speaker };
      }

      const nextSpeakers = speakers.map((candidate, index) =>
        index === speakerIndex ? speaker : candidate,
      );
      const record = await this.save({
        ...current,
        speakerAnalysis: {
          ...speakerAnalysis,
          speakers: nextSpeakers,
        },
      });

      return { outcome: 'renamed', record, speaker };
    });
  }

  async updateMetadata(
    transcriptId: TranscriptId,
    metadata: { title?: unknown; tags?: unknown },
  ): Promise<UpdateTranscriptMetadataResult> {
    if (!isTranscriptId(transcriptId)) {
      throw new TranscriptValidationError('Transcript id must be a UUID.');
    }
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      (metadata.title === undefined && metadata.tags === undefined)
    ) {
      throw new TranscriptValidationError(
        'A transcript title or tags update is required.',
      );
    }

    const normalizedTranscriptId = transcriptId.toLowerCase();
    const normalizedTitle =
      metadata.title === undefined
        ? undefined
        : normalizeTranscriptTitle(metadata.title);
    const normalizedTags =
      metadata.tags === undefined
        ? undefined
        : normalizeTranscriptTags(metadata.tags);

    return this.serializeMutation(async () => {
      const current = await this.get(normalizedTranscriptId);
      if (!current) return { outcome: 'not-found' };

      const title = normalizedTitle ?? current.title;
      const tags = normalizedTags ?? current.tags;
      if (
        title === current.title &&
        tags.length === current.tags.length &&
        tags.every((tag, index) => tag === current.tags[index])
      ) {
        return { outcome: 'updated', record: current };
      }

      return {
        outcome: 'updated',
        record: await this.save({ ...current, title, tags }),
      };
    });
  }

  async delete(id: TranscriptId): Promise<boolean> {
    const recordPath = this.pathForId(id);

    return this.serializeMutation(async () => {
      await this.ensureRoot();

      try {
        await unlink(recordPath);
        return true;
      } catch (error) {
        if (isMissingFileError(error)) {
          return false;
        }

        throw error;
      }
    });
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

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(operation, operation);
    this.mutationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
