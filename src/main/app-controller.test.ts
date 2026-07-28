import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RecordingRepository } from './recording/recording-repository';
import { RECORDING_METADATA_SCHEMA_VERSION } from './recording/recording-metadata';
import { resolveEngineRuntime } from './runtime/engine-runtime';
import { TranscriptRepository } from './storage/transcript-repository';
import {
  AppController,
  formatTranscriptForExport,
  toTranscriptDetail,
  toTranscriptSummary,
} from './app-controller';
import {
  TRANSCRIPT_SCHEMA_VERSION,
  type TranscriptRecord,
} from './transcription/transcript-types';

const record: TranscriptRecord = {
  schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
  id: '32ce6fee-8f3e-4f03-a266-46d6c00ef08c',
  title: 'Teams planning meeting',
  createdAt: '2026-07-27T12:00:00.000Z',
  completedAt: '2026-07-27T12:05:00.000Z',
  source: {
    type: 'imported-file',
    name: 'meeting.mp4',
    mediaKind: 'video',
    sizeBytes: 42,
  },
  durationMs: 3_661_000,
  language: 'en',
  engine: { name: 'whisper.cpp', version: '1.9.1', model: 'small.en' },
  text: 'First item. Second item.',
  segments: [
    { startMs: 0, endMs: 1_000, text: 'First item.' },
    { startMs: 3_660_000, endMs: 3_661_000, text: 'Second item.' },
  ],
};

describe('transcript presentation', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it('maps persisted records without exposing a source path', () => {
    expect(toTranscriptSummary(record)).toEqual({
      id: record.id,
      title: record.title,
      sourceName: 'meeting.mp4',
      createdAt: record.createdAt,
      durationMs: record.durationMs,
      language: 'en',
      preview: record.text,
    });
    expect(toTranscriptDetail(record).completedAt).toBe(record.completedAt);
    expect(toTranscriptDetail(record)).not.toHaveProperty('source');
  });

  it('exports readable timestamps and transcript text', () => {
    expect(formatTranscriptForExport(record)).toContain('Duration: 1:01:01');
    expect(formatTranscriptForExport(record)).toContain('[1:01:00] Second item.');
  });

  const makeLiveRecordingController = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-controller-'));
    temporaryRoots.push(root);
    const transcriptRepository = new TranscriptRepository(
      path.join(root, 'transcripts'),
    );
    const recordingRepository = new RecordingRepository(
      path.join(root, 'recordings'),
    );
    await recordingRepository.initialize();
    const completedAt = '2026-07-27T12:05:00.000Z';
    await recordingRepository.createPartial({
      schemaVersion: RECORDING_METADATA_SCHEMA_VERSION,
      id: record.id,
      sourceName: 'Live meeting.webm',
      startedAt: record.createdAt,
      completedAt: null,
      sizeBytes: 0,
      storageState: 'partial',
      transcription: {
        state: 'ready',
        updatedAt: record.createdAt,
        message: 'Recording in progress.',
      },
    });
    await writeFile(recordingRepository.partialPath(record.id), 'durable webm', {
      mode: 0o600,
    });
    const sizeBytes = await recordingRepository.promotePartial(record.id);
    await recordingRepository.completeMetadata(
      record.id,
      sizeBytes,
      completedAt,
    );

    const liveRecord: TranscriptRecord = {
      ...record,
      recordingId: record.id,
      source: {
        type: 'recording',
        name: 'Live meeting.webm',
        mediaKind: 'audio',
        sizeBytes,
      },
    };
    await transcriptRepository.save(liveRecord);
    const runtimeStatus = await resolveEngineRuntime({
      appPath: root,
      isPackaged: false,
      platform: 'linux',
      arch: 'x64',
      environment: {},
    });
    const controller = new AppController(
      transcriptRepository,
      runtimeStatus,
      path.join(root, 'jobs'),
    );
    await controller.initialize();
    return {
      controller,
      recordingRepository,
      transcriptRepository,
    };
  };

  it('keeps a linked transcript when the user deletes only its recording', async () => {
    const { controller, transcriptRepository } =
      await makeLiveRecordingController();

    expect(controller.getState().recordings).toHaveLength(1);
    await expect(controller.getTranscript(record.id)).resolves.toMatchObject({
      id: record.id,
      recordingId: record.id,
    });
    await expect(controller.getRecordingExport(record.id)).resolves.toMatchObject({
      fileName: 'Live meeting.webm',
    });

    await expect(controller.deleteRecording(record.id)).resolves.toBe(true);
    await expect(transcriptRepository.get(record.id)).resolves.toMatchObject({
      id: record.id,
      recordingId: record.id,
    });
    await expect(controller.getTranscript(record.id)).resolves.not.toHaveProperty(
      'recordingId',
    );
    expect(controller.getState().recordings).toEqual([]);
  });

  it('keeps the original recording and clears its link when only the transcript is deleted', async () => {
    const { controller, recordingRepository } =
      await makeLiveRecordingController();

    await expect(controller.deleteTranscript(record.id)).resolves.toBe(true);
    await expect(
      readFile(recordingRepository.durablePath(record.id), 'utf8'),
    ).resolves.toBe('durable webm');
    expect(controller.getState().transcripts).toEqual([]);
    expect(controller.getState().recordings).toEqual([
      expect.objectContaining({
        id: record.id,
        transcriptionState: 'ready',
      }),
    ]);
    expect(controller.getState().recordings[0]).not.toHaveProperty('transcriptId');
  });

  it('does not delete a recording while its metadata says transcription is active', async () => {
    const { controller, recordingRepository } =
      await makeLiveRecordingController();
    await recordingRepository.updateTranscription(record.id, {
      state: 'transcribing',
      updatedAt: '2026-07-27T12:06:00.000Z',
      message: 'Transcribing locally.',
      jobId: record.id,
    });

    await expect(controller.deleteRecording(record.id)).rejects.toMatchObject({
      code: 'busy',
    });
    await expect(
      readFile(recordingRepository.durablePath(record.id), 'utf8'),
    ).resolves.toBe('durable webm');
  });
});
