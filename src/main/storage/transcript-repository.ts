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

import type { LocalAiMeetingSummary } from '../../shared/contracts';
import { fingerprintTranscriptForLocalAi } from '../local-ai/local-ai-meeting-summary';
import {
  isTranscriptSpeakerId,
  isTranscriptId,
  normalizeTranscriptTags,
  normalizeTranscriptTitle,
  normalizeTranscriptSegmentText,
  normalizeSpeakerLabel,
  parseTranscriptRecord,
  createTranscriptSpeakerId,
  MAX_TRANSCRIPT_SPEAKERS,
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

export type AssignSegmentSpeakerResult =
  | {
      outcome: 'updated';
      record: TranscriptRecord;
      segment: TranscriptRecord['segments'][number];
    }
  | { outcome: 'not-found' };

export type AssignSegmentSpeakersResult =
  | {
      outcome: 'updated';
      record: TranscriptRecord;
      /** Segments actually changed; a stale index is skipped, not refused. */
      assignedCount: number;
    }
  | { outcome: 'not-found' };

export type AddSpeakerResult =
  | { outcome: 'added'; record: TranscriptRecord; speaker: TranscriptSpeaker }
  | { outcome: 'not-found' }
  | { outcome: 'rejected'; reason: string };

/** Recorded when a transcript gains a speaker no automatic pass produced. */
const MANUAL_SPEAKER_ENGINE = {
  name: 'manual-annotation',
  model: 'none',
  version: '1',
} as const;

export type SaveLocalAiMeetingSummaryResult =
  | { outcome: 'saved'; record: TranscriptRecord }
  | { outcome: 'not-found' | 'stale' };

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

  /**
   * Count of record files the most recent list() could not read — corrupt,
   * oversized, or written by a newer schema than this build understands.
   * Surfaced so hidden transcripts are never silently invisible.
   */
  private skippedRecordCount = 0;

  get lastSkippedRecordCount(): number {
    return this.skippedRecordCount;
  }

  async list(): Promise<TranscriptRecord[]> {
    await this.ensureRoot();
    const entries = await readdir(this.rootPath, { withFileTypes: true });
    const records: TranscriptRecord[] = [];
    let skipped = 0;

    for (const entry of entries) {
      if (!isRecordFile(entry)) {
        continue;
      }

      const record = await this.readRecord(path.join(this.rootPath, entry.name));
      if (record !== null) {
        records.push(record);
      } else {
        skipped += 1;
      }
    }
    this.skippedRecordCount = skipped;

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
        localAiMeetingSummary: null,
      });

      return { outcome: 'updated', record, segment: record.segments[segmentIndex] };
    });
  }

  /**
   * Reassigns one segment to a different speaker, or to none. Unlike a text
   * correction this leaves the words untouched: which voice said a line does
   * not change what was said, and the word timings stay usable for playback.
   *
   * Ground-truth annotation is the reason this exists, so it deliberately
   * allows what automatic labelling cannot express — merging two clusters that
   * were the same person by pointing their segments at one speaker.
   */
  async assignSegmentSpeaker(
    transcriptId: TranscriptId,
    segmentIndex: number,
    speakerId: TranscriptSpeakerId | null,
  ): Promise<AssignSegmentSpeakerResult> {
    if (!isTranscriptId(transcriptId)) {
      throw new TranscriptValidationError('Transcript id must be a UUID.');
    }
    if (!Number.isSafeInteger(segmentIndex) || segmentIndex < 0) {
      throw new TranscriptValidationError('Transcript segment index is invalid.');
    }
    if (speakerId !== null && !isTranscriptSpeakerId(speakerId)) {
      throw new TranscriptValidationError('Speaker id must be a UUID or null.');
    }

    const normalizedTranscriptId = transcriptId.toLowerCase();
    const normalizedSpeakerId = speakerId === null ? null : speakerId.toLowerCase();

    return this.serializeMutation(async () => {
      const current = await this.get(normalizedTranscriptId);
      const currentSegment = current?.segments[segmentIndex];
      if (!current || !currentSegment) return { outcome: 'not-found' };
      if (
        normalizedSpeakerId !== null &&
        !current.speakerAnalysis?.speakers.some(
          (speaker) => speaker.id === normalizedSpeakerId,
        )
      ) {
        return { outcome: 'not-found' };
      }
      if (currentSegment.speakerId === normalizedSpeakerId) {
        return { outcome: 'updated', record: current, segment: currentSegment };
      }

      const segments = current.segments.map((candidate, index) =>
        index === segmentIndex
          ? { ...candidate, speakerId: normalizedSpeakerId }
          : candidate,
      );
      const record = await this.save({
        ...current,
        segments,
        // A summary quotes speakers, so a reassignment invalidates it.
        localAiMeetingSummary: null,
      });
      return { outcome: 'updated', record, segment: record.segments[segmentIndex] };
    });
  }

  /**
   * Reassigns many segments at once. Annotating a long meeting means moving
   * hundreds of segments, and doing that one call at a time would rewrite the
   * whole record hundreds of times; this reads and writes it once. It is also
   * atomic, so a bulk assignment cannot half-apply.
   */
  async assignSegmentSpeakers(
    transcriptId: TranscriptId,
    segmentIndexes: readonly number[],
    speakerId: TranscriptSpeakerId | null,
  ): Promise<AssignSegmentSpeakersResult> {
    if (!isTranscriptId(transcriptId)) {
      throw new TranscriptValidationError('Transcript id must be a UUID.');
    }
    if (
      segmentIndexes.some(
        (index) => !Number.isSafeInteger(index) || index < 0,
      )
    ) {
      throw new TranscriptValidationError('Transcript segment index is invalid.');
    }
    if (speakerId !== null && !isTranscriptSpeakerId(speakerId)) {
      throw new TranscriptValidationError('Speaker id must be a UUID or null.');
    }

    const normalizedSpeakerId = speakerId === null ? null : speakerId.toLowerCase();
    const targets = new Set(segmentIndexes);

    return this.serializeMutation(async () => {
      const current = await this.get(transcriptId.toLowerCase());
      if (!current) return { outcome: 'not-found' };
      if (
        normalizedSpeakerId !== null &&
        !current.speakerAnalysis?.speakers.some(
          (speaker) => speaker.id === normalizedSpeakerId,
        )
      ) {
        return { outcome: 'not-found' };
      }
      // An index past the end is a stale selection, not a reason to refuse the
      // rest: the transcript may have been re-transcribed in another window.
      const applicable = [...targets].filter(
        (index) => index < current.segments.length,
      );
      if (applicable.length === 0) {
        return { outcome: 'updated', record: current, assignedCount: 0 };
      }

      const segments = current.segments.map((segment, index) =>
        targets.has(index) && index < current.segments.length
          ? { ...segment, speakerId: normalizedSpeakerId }
          : segment,
      );
      const record = await this.save({
        ...current,
        segments,
        localAiMeetingSummary: null,
      });
      return { outcome: 'updated', record, assignedCount: applicable.length };
    });
  }

  /**
   * Adds a speaker that automatic labelling did not produce. Annotation needs
   * this because the truth can contain people the clustering never separated.
   */
  async addSpeaker(
    transcriptId: TranscriptId,
    label: string,
  ): Promise<AddSpeakerResult> {
    if (!isTranscriptId(transcriptId)) {
      throw new TranscriptValidationError('Transcript id must be a UUID.');
    }
    const normalizedLabel = normalizeSpeakerLabel(label);

    return this.serializeMutation(async () => {
      const current = await this.get(transcriptId.toLowerCase());
      if (!current) return { outcome: 'not-found' };
      const existing = current.speakerAnalysis?.speakers ?? [];
      if (existing.length >= MAX_TRANSCRIPT_SPEAKERS) {
        return { outcome: 'rejected', reason: 'This transcript already has the maximum number of speakers.' };
      }
      if (
        existing.some(
          (speaker) =>
            speaker.label.localeCompare(normalizedLabel, undefined, {
              sensitivity: 'accent',
            }) === 0,
        )
      ) {
        return { outcome: 'rejected', reason: 'That speaker name is already used in this transcript.' };
      }

      const speaker = { id: createTranscriptSpeakerId(), label: normalizedLabel };
      const record = await this.save({
        ...current,
        speakerAnalysis: {
          // A transcript annotated by hand no longer describes only what the
          // automatic pass produced, so the engine record says so.
          engine: current.speakerAnalysis?.engine ?? MANUAL_SPEAKER_ENGINE,
          speakers: [...existing, speaker],
        },
      });
      return { outcome: 'added', record, speaker };
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
        localAiMeetingSummary: null,
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

  async saveLocalAiMeetingSummary(
    transcriptId: TranscriptId,
    summary: LocalAiMeetingSummary,
    expectedFingerprint: string,
  ): Promise<SaveLocalAiMeetingSummaryResult> {
    if (!isTranscriptId(transcriptId)) {
      throw new TranscriptValidationError('Transcript id must be a UUID.');
    }
    if (!/^[0-9a-f]{64}$/u.test(expectedFingerprint)) {
      throw new TranscriptValidationError('Transcript fingerprint is invalid.');
    }
    return this.serializeMutation(async () => {
      const current = await this.get(transcriptId.toLowerCase());
      if (!current) return { outcome: 'not-found' };
      if (fingerprintTranscriptForLocalAi(current) !== expectedFingerprint) {
        return { outcome: 'stale' };
      }
      return {
        outcome: 'saved',
        record: await this.save({
          ...current,
          localAiMeetingSummary: {
            ...summary,
            summary: {
              ...summary.summary,
              keyPoints: summary.summary.keyPoints.map((item) => ({ ...item })),
              decisions: summary.summary.decisions.map((item) => ({ ...item })),
              actionItems: summary.summary.actionItems.map((item) => ({ ...item })),
            },
            inputFingerprint: expectedFingerprint,
          },
        }),
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
