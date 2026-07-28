import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
  speakerAnalysis: null,
  text: 'First item. Second item.',
  segments: [
    { startMs: 0, endMs: 1_000, text: 'First item.', speakerId: null },
    {
      startMs: 3_660_000,
      endMs: 3_661_000,
      text: 'Second item.',
      speakerId: null,
    },
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

    const analyzed = {
      ...record,
      speakerAnalysis: {
        engine: {
          name: 'sherpa-onnx',
          model: 'pyannote + 3D-Speaker',
          version: '1.13.4',
        },
        speakers: [],
      },
    } satisfies TranscriptRecord;
    expect(formatTranscriptForExport(analyzed)).toContain(
      '[1:01:00] Unclear: Second item.',
    );
  });

  it('maps, renames, and exports transcript-local speaker labels', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-speakers-'));
    temporaryRoots.push(root);
    const repository = new TranscriptRepository(path.join(root, 'transcripts'));
    const speakerId = '11111111-1111-4111-8111-111111111111';
    const labeled: TranscriptRecord = {
      ...record,
      speakerAnalysis: {
        engine: {
          name: 'sherpa-onnx',
          model: 'pyannote + 3D-Speaker',
          version: '1.13.4',
        },
        speakers: [{ id: speakerId, label: 'Speaker 1' }],
      },
      segments: record.segments.map((segment) => ({ ...segment, speakerId })),
    };
    await repository.save(labeled);
    const runtimeStatus = await resolveEngineRuntime({
      appPath: root,
      isPackaged: false,
      platform: 'linux',
      arch: 'x64',
      environment: {},
    });
    const controller = new AppController(
      repository,
      runtimeStatus,
      path.join(root, 'jobs'),
    );
    await controller.initialize();

    const detail = await controller.getTranscript(record.id);
    expect(detail).toMatchObject({
      speakerAnalysis: { speakers: [{ id: speakerId, label: 'Speaker 1' }] },
    });
    expect(detail?.segments.every((segment) => segment.speakerId === speakerId)).toBe(
      true,
    );
    await expect(
      controller.renameTranscriptSpeaker(record.id, speakerId, 'Morgan'),
    ).resolves.toEqual({
      outcome: 'renamed',
      speaker: { id: speakerId, label: 'Morgan' },
    });
    await expect(controller.getTranscriptExport(record.id, 'txt')).resolves.toMatchObject({
      content: expect.stringContaining('Morgan: First item.'),
    });
    const docx = await controller.getTranscriptExport(record.id, 'docx');
    expect(Buffer.isBuffer(docx?.content)).toBe(true);
    expect((docx?.content as Buffer).subarray(0, 2).toString('ascii')).toBe('PK');
  });

  it('does not let a slow rename reload resurrect a deleted transcript', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-reload-order-'));
    temporaryRoots.push(root);
    const repository = new TranscriptRepository(path.join(root, 'transcripts'));
    const speakerId = '11111111-1111-4111-8111-111111111111';
    await repository.save({
      ...record,
      speakerAnalysis: {
        engine: {
          name: 'sherpa-onnx',
          model: 'pyannote + 3D-Speaker',
          version: '1.13.4',
        },
        speakers: [{ id: speakerId, label: 'Speaker 1' }],
      },
      segments: record.segments.map((segment) => ({ ...segment, speakerId })),
    });
    const runtimeStatus = await resolveEngineRuntime({
      appPath: root,
      isPackaged: false,
      platform: 'linux',
      arch: 'x64',
      environment: {},
    });
    const controller = new AppController(
      repository,
      runtimeStatus,
      path.join(root, 'jobs'),
    );
    await controller.initialize();

    const originalList = repository.list.bind(repository);
    let listCalls = 0;
    let releaseFirstReload: () => void = () => undefined;
    const firstReloadReleased = new Promise<void>((resolve) => {
      releaseFirstReload = resolve;
    });
    let firstReloadCaptured: () => void = () => undefined;
    const firstReloadStarted = new Promise<void>((resolve) => {
      firstReloadCaptured = resolve;
    });
    vi.spyOn(repository, 'list').mockImplementation(async () => {
      listCalls += 1;
      if (listCalls === 1) {
        const captured = await originalList();
        firstReloadCaptured();
        await firstReloadReleased;
        return captured;
      }
      return originalList();
    });

    const rename = controller.renameTranscriptSpeaker(
      record.id,
      speakerId,
      'Morgan',
    );
    await firstReloadStarted;
    const deletion = controller.deleteTranscript(record.id);
    await vi.waitFor(async () => {
      expect(await repository.get(record.id)).toBeNull();
    });
    releaseFirstReload();

    await expect(rename).resolves.toMatchObject({ outcome: 'renamed' });
    await expect(deletion).resolves.toBe(true);
    expect(controller.getState().transcripts).toEqual([]);
  });

  it('waits for an in-flight speaker rename before exporting', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-export-order-'));
    temporaryRoots.push(root);
    const repository = new TranscriptRepository(path.join(root, 'transcripts'));
    const speakerId = '11111111-1111-4111-8111-111111111111';
    await repository.save({
      ...record,
      speakerAnalysis: {
        engine: {
          name: 'sherpa-onnx',
          model: 'pyannote + 3D-Speaker',
          version: '1.13.4',
        },
        speakers: [{ id: speakerId, label: 'Speaker 1' }],
      },
      segments: record.segments.map((segment) => ({ ...segment, speakerId })),
    });
    const runtimeStatus = await resolveEngineRuntime({
      appPath: root,
      isPackaged: false,
      platform: 'linux',
      arch: 'x64',
      environment: {},
    });
    const controller = new AppController(
      repository,
      runtimeStatus,
      path.join(root, 'jobs'),
    );
    await controller.initialize();

    const originalSave = repository.save.bind(repository);
    let releaseSave: () => void = () => undefined;
    const saveReleased = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let saveEntered: () => void = () => undefined;
    const saveStarted = new Promise<void>((resolve) => {
      saveEntered = resolve;
    });
    vi.spyOn(repository, 'save').mockImplementation(async (nextRecord) => {
      saveEntered();
      await saveReleased;
      return originalSave(nextRecord);
    });

    const rename = controller.renameTranscriptSpeaker(
      record.id,
      speakerId,
      'Morgan',
    );
    await saveStarted;
    const pendingExport = controller.getTranscriptExport(record.id, 'txt');
    releaseSave();

    await expect(rename).resolves.toMatchObject({ outcome: 'renamed' });
    await expect(pendingExport).resolves.toMatchObject({
      content: expect.stringContaining('Morgan: First item.'),
    });
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

  it('blocks live capture when macOS recording permission is missing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-permission-'));
    temporaryRoots.push(root);
    const repository = new TranscriptRepository(path.join(root, 'transcripts'));
    const runtimeStatus = await resolveEngineRuntime({
      appPath: root,
      isPackaged: false,
      platform: 'linux',
      arch: 'x64',
      environment: {},
    });
    const capability = {
      state: 'permission-required',
      message: 'Allow Screen & System Audio Recording.',
    } as const;
    const controller = new AppController(
      repository,
      runtimeStatus,
      path.join(root, 'jobs'),
      capability,
    );

    expect(controller.getState().recording.capability).toEqual(capability);
    await expect(controller.startLiveRecording()).rejects.toMatchObject({
      code: 'permission-denied',
      message: capability.message,
    });
  });

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

  it('keeps a deleted transcript link ready when completion was still being saved', async () => {
    const { controller, recordingRepository, transcriptRepository } =
      await makeLiveRecordingController();
    await recordingRepository.updateTranscription(record.id, {
      state: 'transcribing',
      updatedAt: '2026-07-27T12:04:30.000Z',
      message: 'Transcribing locally.',
      jobId: record.id,
    });

    const recordingService = (
      controller as unknown as {
        recordingService: {
          markTranscriptionCompleted: (
            recordingId: string,
            jobId: string,
            transcriptId: string,
          ) => Promise<void>;
        };
      }
    ).recordingService;
    const originalComplete =
      recordingService.markTranscriptionCompleted.bind(recordingService);
    let releaseCompletion: () => void = () => undefined;
    const completionReleased = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    let completionEntered: () => void = () => undefined;
    const completionStarted = new Promise<void>((resolve) => {
      completionEntered = resolve;
    });
    vi.spyOn(recordingService, 'markTranscriptionCompleted').mockImplementation(
      async (recordingId, jobId, transcriptId) => {
        completionEntered();
        await completionReleased;
        await originalComplete(recordingId, jobId, transcriptId);
      },
    );

    (
      controller as unknown as {
        handleJobChanged: (job: {
          id: string;
          sourceName: string;
          stage: 'completed';
          progress: number;
          startedAt: string;
          message: string;
          recordingId: string;
          transcriptId: string;
        }) => void;
      }
    ).handleJobChanged({
      id: record.id,
      sourceName: 'Live meeting.webm',
      stage: 'completed',
      progress: 1,
      startedAt: record.createdAt,
      message: 'Transcript complete.',
      recordingId: record.id,
      transcriptId: record.id,
    });
    await completionStarted;

    const deletion = controller.deleteTranscript(record.id);
    await vi.waitFor(async () => {
      expect(await transcriptRepository.get(record.id)).toBeNull();
    });
    releaseCompletion();
    await expect(deletion).resolves.toBe(true);

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
