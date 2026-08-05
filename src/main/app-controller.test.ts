import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AppState,
  LiveRecordingCapability,
  SavedRecordingSummary,
} from '../shared/contracts';
import type { SelectedMedia } from './media/media-import';
import { LocalAiConnectionService } from './local-ai/local-ai-connection';
import { RecordingRepository } from './recording/recording-repository';
import { RECORDING_METADATA_SCHEMA_VERSION } from './recording/recording-metadata';
import { resolveEngineRuntime } from './runtime/engine-runtime';
import { TranscriptRepository } from './storage/transcript-repository';
import type { PlaybackRepository } from './storage/playback-repository';
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
  tags: [],
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
    { startMs: 0, endMs: 1_000, text: 'First item.', speakerId: null, words: [] },
    {
      startMs: 3_660_000,
      endMs: 3_661_000,
      text: 'Second item.',
      speakerId: null,
      words: [],
    },
  ],
};

const readyRuntimeStatus = (
  root: string,
): ConstructorParameters<typeof AppController>[1] => {
  const component = {
    path: path.join(root, 'runtime-component'),
    source: 'bundled',
    state: 'ready',
  } as const;
  return {
    ready: true,
    state: 'ready',
    resourcesRoot: root,
    runtime: {
      ffmpegPath: path.join(root, 'ffmpeg'),
      modelPath: path.join(root, 'model.bin'),
      speakerDiarization: null,
      whisperPath: path.join(root, 'whisper-cli'),
    },
    components: {
      ffmpeg: component,
      model: component,
      speakerChild: component,
      speakerEmbeddingModel: component,
      speakerModule: component,
      speakerSegmentationModel: component,
      whisper: component,
    },
  };
};

const importedMedia = (root: string): SelectedMedia => ({
  cleanupAfterTranscription: false,
  extension: 'MP3',
  mediaKind: 'audio',
  name: 'Imported meeting.mp3',
  path: path.join(root, 'imported-meeting.mp3'),
  sizeBytes: 128,
});

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
      tags: [],
    });
    expect(toTranscriptDetail(record).completedAt).toBe(record.completedAt);
    expect(toTranscriptDetail(record)).not.toHaveProperty('source');
  });

  it('searches cached transcript content, speakers, dates, and tags locally', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-library-search-'));
    temporaryRoots.push(root);
    const repository = new TranscriptRepository(path.join(root, 'transcripts'));
    const speakerId = '11111111-1111-4111-8111-111111111111';
    await repository.save({
      ...record,
      tags: ['Client'],
      speakerAnalysis: {
        engine: {
          name: 'sherpa-onnx',
          model: 'pyannote + 3D-Speaker',
          version: '1.13.4',
        },
        speakers: [{ id: speakerId, label: 'Morgan' }],
      },
      segments: record.segments.map((segment) => ({
        ...segment,
        speakerId,
      })),
    });
    const controller = new AppController(
      repository,
      readyRuntimeStatus(root),
      path.join(root, 'jobs'),
    );
    await controller.initialize();

    expect(
      controller.searchTranscriptLibrary({
        text: 'Morgan Second',
        createdFrom: '2026-07-01T00:00:00.000Z',
        speaker: 'morgan',
        tag: 'client',
      }),
    ).toMatchObject({
      transcripts: [{ id: record.id, tags: ['Client'] }],
      availableSpeakers: ['Morgan'],
      availableTags: ['Client'],
    });
    await controller.dispose();
  });

  it('updates title and tags together and refreshes library state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-library-metadata-'));
    temporaryRoots.push(root);
    const repository = new TranscriptRepository(path.join(root, 'transcripts'));
    await repository.save(record);
    const controller = new AppController(
      repository,
      readyRuntimeStatus(root),
      path.join(root, 'jobs'),
    );
    await controller.initialize();

    await expect(
      controller.updateTranscriptMetadata(record.id, {
        title: 'Customer launch',
        tags: ['Important'],
      }),
    ).resolves.toEqual({
      outcome: 'updated',
      title: 'Customer launch',
      tags: ['Important'],
    });
    expect(controller.getState().transcripts).toEqual([
      expect.objectContaining({
        id: record.id,
        title: 'Customer launch',
        tags: ['Important'],
      }),
    ]);
    expect(
      controller.searchTranscriptLibrary({
        text: 'Customer',
        createdFrom: null,
        speaker: null,
        tag: 'Important',
      }).transcripts,
    ).toHaveLength(1);
    await controller.dispose();
  });

  it('withholds an implausible legacy speaker count instead of showing phantom people', () => {
    const speakers = Array.from({ length: 100 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      label: `Speaker ${index + 1}`,
    }));
    const fragmented: TranscriptRecord = {
      ...record,
      speakerAnalysis: {
        engine: {
          name: 'sherpa-onnx',
          model: 'pyannote + 3D-Speaker',
          version: '1.13.4',
        },
        speakers,
      },
      segments: record.segments.map((segment, index) => ({
        ...segment,
        speakerId: speakers[index].id,
      })),
    };

    const detail = toTranscriptDetail(fragmented);
    expect(detail.speakerAnalysis).toBeNull();
    expect(detail.segments.every((segment) => segment.speakerId === null)).toBe(true);
    expect(formatTranscriptForExport(fragmented)).not.toContain('Speaker 100');
  });

  it('computes transcript previews during reload instead of rescanning records on state emits', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-summary-cache-'));
    temporaryRoots.push(root);
    const repository = new TranscriptRepository(path.join(root, 'transcripts'));
    let textReads = 0;
    const countedRecord = {
      ...record,
      get text() {
        textReads += 1;
        return record.text;
      },
    } satisfies TranscriptRecord;
    vi.spyOn(repository, 'list').mockResolvedValue([countedRecord]);
    const controller = new AppController(
      repository,
      readyRuntimeStatus(root),
      path.join(root, 'jobs'),
    );
    await controller.initialize();

    expect(textReads).toBe(1);
    expect(controller.getState().transcripts).toEqual([
      expect.objectContaining({ id: record.id, preview: record.text }),
    ]);
    const listener = vi.fn<(state: AppState) => void>();
    controller.subscribe(listener);
    (
      controller as unknown as {
        emit(): void;
      }
    ).emit();
    controller.getState();
    controller.getState();

    expect(listener).toHaveBeenCalledOnce();
    expect(textReads).toBe(1);
    await controller.dispose();
  });

  it('keeps list summaries cached while detail reads stay repository-backed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-summary-refresh-'));
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
    const controller = new AppController(
      repository,
      readyRuntimeStatus(root),
      path.join(root, 'jobs'),
    );
    await controller.initialize();

    expect(controller.getState().transcripts[0]?.preview).toBe(record.text);
    const updatedText = 'Updated    preview after a repository mutation.';
    await repository.save({ ...labeled, text: updatedText });

    expect(controller.getState().transcripts[0]?.preview).toBe(record.text);
    await expect(controller.getTranscript(record.id)).resolves.toMatchObject({
      text: updatedText,
    });

    await expect(
      controller.renameTranscriptSpeaker(record.id, speakerId, 'Morgan'),
    ).resolves.toMatchObject({ outcome: 'renamed' });
    expect(controller.getState().transcripts).toEqual([
      expect.objectContaining({
        id: record.id,
        preview: 'Updated preview after a repository mutation.',
      }),
    ]);
    await expect(controller.getTranscript(record.id)).resolves.toMatchObject({
      speakerAnalysis: { speakers: [{ id: speakerId, label: 'Morgan' }] },
      text: updatedText,
    });
    await controller.dispose();
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
    await expect(controller.getTranscriptExport(record.id, 'srt')).resolves.toMatchObject({
      content: expect.stringContaining('Morgan: First item.'),
    });
    await expect(controller.getTranscriptExport(record.id, 'vtt')).resolves.toMatchObject({
      content: expect.stringContaining('WEBVTT'),
    });
    const portable = await controller.getTranscriptExport(record.id, 'json');
    expect(JSON.parse(portable?.content as string)).toMatchObject({
      format: 'sotto-portable-transcript',
      transcript: { speakers: [{ label: 'Morgan' }] },
    });
    const minutes = await controller.getTranscriptExport(record.id, 'minutes-docx');
    expect(Buffer.isBuffer(minutes?.content)).toBe(true);
    expect((minutes?.content as Buffer).subarray(0, 2).toString('ascii')).toBe('PK');
    await expect(
      controller.getTranscriptCopyText(record.id, 'meeting-minutes'),
    ).resolves.toContain('Teams planning meeting');
    await expect(controller.getDictationText(record.id)).resolves.toBe(
      record.text,
    );
    await expect(
      controller.getDictationText('5f04a88f-5f68-4ff8-a6e3-bc58414087b2'),
    ).resolves.toBeNull();
    await controller.dispose();
  });

  it('updates transcript text, cached preview, and later exports together', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-corrections-'));
    temporaryRoots.push(root);
    const repository = new TranscriptRepository(path.join(root, 'transcripts'));
    await repository.save(record);
    const controller = new AppController(
      repository,
      readyRuntimeStatus(root),
      path.join(root, 'jobs'),
    );
    await controller.initialize();

    await expect(
      controller.updateTranscriptSegment(record.id, 0, 'Corrected first item.'),
    ).resolves.toEqual({
      outcome: 'updated',
      segment: {
        startMs: 0,
        endMs: 1_000,
        text: 'Corrected first item.',
        speakerId: null,
        words: [],
      },
      text: 'Corrected first item. Second item.',
      preview: 'Corrected first item. Second item.',
      localAiMeetingSummary: null,
      meetingSummary: expect.objectContaining({
        overview: 'Corrected first item. Second item.',
      }),
    });
    expect(controller.getState().transcripts[0]?.preview).toBe(
      'Corrected first item. Second item.',
    );
    await expect(controller.getTranscriptExport(record.id, 'txt')).resolves.toMatchObject({
      content: expect.stringContaining('[0:00] Corrected first item.'),
    });
    await controller.dispose();
  });

  it('generates, persists, presents, and exports a Local AI meeting draft', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-local-ai-summary-'));
    temporaryRoots.push(root);
    const repository = new TranscriptRepository(path.join(root, 'transcripts'));
    await repository.save(record);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'gemma3:4b', object: 'model', owned_by: 'library' }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              overview: 'The team reviewed two agenda items.',
              keyPoints: [{ segmentIndex: 1, text: 'The second item was discussed.' }],
              decisions: [],
              actionItems: [],
            }),
          },
        }],
      }), { status: 200 });
    });
    const localAiService = new LocalAiConnectionService({
      filePath: path.join(root, 'local-ai', 'connection.json'),
      credentialCipher: {
        encrypt: (value) => value,
        decrypt: (value) => value,
      },
      fetcher: fetcher as typeof fetch,
      now: () => new Date('2026-07-29T20:00:00.000Z'),
    });
    await expect(localAiService.connect({
      baseUrl: 'http://127.0.0.1:11434',
      selectedModel: 'gemma3:4b',
    })).resolves.toMatchObject({ outcome: 'connected' });
    const controller = new AppController(
      repository,
      readyRuntimeStatus(root),
      path.join(root, 'jobs'),
    );
    await controller.initialize();

    const previewed = await controller.previewLocalAiMeetingSummary(
      record.id,
      localAiService,
    );
    if (previewed.outcome !== 'ready') {
      throw new Error(`Expected a preview, received ${previewed.outcome}.`);
    }

    await expect(
      controller.generateLocalAiMeetingSummary(
        record.id,
        localAiService,
        previewed.preview.approvalFingerprint,
      ),
    ).resolves.toMatchObject({
      outcome: 'generated',
      localAiMeetingSummary: {
        model: 'gemma3:4b',
        summary: {
          overview: 'The team reviewed two agenda items.',
          keyPoints: [{
            text: 'The second item was discussed.',
            startMs: 3_660_000,
            speakerId: null,
          }],
        },
      },
    });
    await expect(controller.getTranscript(record.id)).resolves.toMatchObject({
      localAiMeetingSummary: {
        model: 'gemma3:4b',
        summary: { overview: 'The team reviewed two agenda items.' },
      },
    });
    await expect(controller.getTranscriptExport(record.id, 'txt')).resolves.toMatchObject({
      content: expect.stringContaining('The team reviewed two agenda items.'),
    });
    await controller.dispose();
  });

  it('sends nothing when the transcript changed after the preview was approved', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-local-ai-stale-'));
    temporaryRoots.push(root);
    const repository = new TranscriptRepository(path.join(root, 'transcripts'));
    await repository.save(record);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'gemma3:4b', object: 'model', owned_by: 'library' }],
        }), { status: 200 });
      }
      throw new Error('The transcript must never be sent after it changed.');
    });
    const localAiService = new LocalAiConnectionService({
      filePath: path.join(root, 'local-ai', 'connection.json'),
      credentialCipher: { encrypt: (value) => value, decrypt: (value) => value },
      fetcher: fetcher as typeof fetch,
      now: () => new Date('2026-07-29T20:00:00.000Z'),
    });
    await localAiService.connect({
      baseUrl: 'http://127.0.0.1:11434',
      selectedModel: 'gemma3:4b',
    });
    const controller = new AppController(
      repository,
      readyRuntimeStatus(root),
      path.join(root, 'jobs'),
    );
    await controller.initialize();

    const previewed = await controller.previewLocalAiMeetingSummary(
      record.id,
      localAiService,
    );
    if (previewed.outcome !== 'ready') {
      throw new Error(`Expected a preview, received ${previewed.outcome}.`);
    }
    // The user edits a segment between reviewing the payload and confirming it.
    await controller.updateTranscriptSegment(record.id, 0, 'A different first item.');

    await expect(
      controller.generateLocalAiMeetingSummary(
        record.id,
        localAiService,
        previewed.preview.approvalFingerprint,
      ),
    ).resolves.toEqual({
      outcome: 'rejected',
      reason:
        'The transcript changed after you reviewed what would be sent. Review it again before sending.',
    });
    await controller.dispose();
  });

  it('reports a cancelled Local AI summary as cancelled and saves nothing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-local-ai-cancel-'));
    temporaryRoots.push(root);
    const repository = new TranscriptRepository(path.join(root, 'transcripts'));
    await repository.save(record);
    const controller = new AppController(
      repository,
      readyRuntimeStatus(root),
      path.join(root, 'jobs'),
    );
    await controller.initialize();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'gemma3:4b', object: 'model', owned_by: 'library' }],
        }), { status: 200 });
      }
      // Stop the generation exactly while the model request is outstanding.
      controller.cancelLocalAiMeetingSummary(record.id);
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const localAiService = new LocalAiConnectionService({
      filePath: path.join(root, 'local-ai', 'connection.json'),
      credentialCipher: { encrypt: (value) => value, decrypt: (value) => value },
      fetcher: fetcher as typeof fetch,
      now: () => new Date('2026-07-29T20:00:00.000Z'),
    });
    await localAiService.connect({
      baseUrl: 'http://127.0.0.1:11434',
      selectedModel: 'gemma3:4b',
    });

    const previewed = await controller.previewLocalAiMeetingSummary(
      record.id,
      localAiService,
    );
    if (previewed.outcome !== 'ready') {
      throw new Error(`Expected a preview, received ${previewed.outcome}.`);
    }

    await expect(
      controller.generateLocalAiMeetingSummary(
        record.id,
        localAiService,
        previewed.preview.approvalFingerprint,
      ),
    ).resolves.toEqual({ outcome: 'cancelled' });
    await expect(controller.getTranscript(record.id)).resolves.toMatchObject({
      localAiMeetingSummary: null,
    });
    await controller.dispose();
  });

  it('publishes the running Local AI summary so a reloaded window can still cancel it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-local-ai-state-'));
    temporaryRoots.push(root);
    const repository = new TranscriptRepository(path.join(root, 'transcripts'));
    await repository.save(record);
    const controller = new AppController(
      repository,
      readyRuntimeStatus(root),
      path.join(root, 'jobs'),
    );
    await controller.initialize();
    expect(controller.getState().activeLocalAiSummary).toBeNull();

    const observed: Array<string | null> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'gemma3:4b', object: 'model', owned_by: 'library' }],
        }), { status: 200 });
      }
      // Mid-flight is the only moment the published state matters.
      observed.push(
        controller.getState().activeLocalAiSummary?.transcriptId ?? null,
      );
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              overview: 'A short review.',
              keyPoints: [],
              decisions: [],
              actionItems: [],
            }),
          },
        }],
      }), { status: 200 });
    });
    const localAiService = new LocalAiConnectionService({
      filePath: path.join(root, 'local-ai', 'connection.json'),
      credentialCipher: { encrypt: (value) => value, decrypt: (value) => value },
      fetcher: fetcher as typeof fetch,
      now: () => new Date('2026-07-29T20:00:00.000Z'),
    });
    await localAiService.connect({
      baseUrl: 'http://127.0.0.1:11434',
      selectedModel: 'gemma3:4b',
    });

    const previewed = await controller.previewLocalAiMeetingSummary(
      record.id,
      localAiService,
    );
    if (previewed.outcome !== 'ready') {
      throw new Error(`Expected a preview, received ${previewed.outcome}.`);
    }
    await controller.generateLocalAiMeetingSummary(
      record.id,
      localAiService,
      previewed.preview.approvalFingerprint,
    );

    expect(observed).toEqual([record.id]);
    expect(controller.getState().activeLocalAiSummary).toBeNull();
    await controller.dispose();
  });

  it('queues a second approved summary and runs it when the first finishes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-local-ai-queue-'));
    temporaryRoots.push(root);
    const repository = new TranscriptRepository(path.join(root, 'transcripts'));
    const second = { ...record, id: '9d4c1f26-1a3f-4a55-9d1f-1c2f3b4a5d6e' };
    await repository.save(record);
    await repository.save(second);
    const controller = new AppController(
      repository,
      readyRuntimeStatus(root),
      path.join(root, 'jobs'),
    );
    await controller.initialize();

    const sentOrder: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstInFlight = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let pending = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'gemma3:4b', object: 'model', owned_by: 'library' }],
        }), { status: 200 });
      }
      sentOrder.push(
        controller.getState().activeLocalAiSummary?.transcriptId ?? 'none',
      );
      // Hold the first send open so the second has to queue behind it.
      if (++pending === 1) await firstInFlight;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              overview: 'A short review.',
              keyPoints: [],
              decisions: [],
              actionItems: [],
            }),
          },
        }],
      }), { status: 200 });
    });
    const localAiService = new LocalAiConnectionService({
      filePath: path.join(root, 'local-ai', 'connection.json'),
      credentialCipher: { encrypt: (value) => value, decrypt: (value) => value },
      fetcher: fetcher as typeof fetch,
      now: () => new Date('2026-07-29T20:00:00.000Z'),
    });
    await localAiService.connect({
      baseUrl: 'http://127.0.0.1:11434',
      selectedModel: 'gemma3:4b',
    });

    const approvalFor = async (id: string): Promise<string> => {
      const previewed = await controller.previewLocalAiMeetingSummary(
        id,
        localAiService,
      );
      if (previewed.outcome !== 'ready') {
        throw new Error(`Expected a preview, received ${previewed.outcome}.`);
      }
      return previewed.preview.approvalFingerprint;
    };

    const running = controller.generateLocalAiMeetingSummary(
      record.id,
      localAiService,
      await approvalFor(record.id),
    );
    // The first send is in flight; the second must wait rather than be refused.
    await expect(
      controller.generateLocalAiMeetingSummary(
        second.id,
        localAiService,
        await approvalFor(second.id),
      ),
    ).resolves.toEqual({ outcome: 'queued', position: 1 });
    expect(controller.getState().queuedLocalAiSummaries).toEqual([second.id]);

    releaseFirst();
    await expect(running).resolves.toMatchObject({ outcome: 'generated' });
    // The queued send starts from the first one's teardown, so wait for the
    // saved result rather than for the queue to merely look empty.
    await vi.waitFor(async () => {
      await expect(controller.getTranscript(second.id)).resolves.toMatchObject({
        localAiMeetingSummary: { model: 'gemma3:4b' },
      });
    });

    expect(sentOrder).toEqual([record.id, second.id]);
    expect(controller.getState().activeLocalAiSummary).toBeNull();
    expect(controller.getState().queuedLocalAiSummaries).toEqual([]);
    await controller.dispose();
  });

  it('drops a queued summary that is cancelled before its turn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-local-ai-dequeue-'));
    temporaryRoots.push(root);
    const repository = new TranscriptRepository(path.join(root, 'transcripts'));
    const second = { ...record, id: '9d4c1f26-1a3f-4a55-9d1f-1c2f3b4a5d6e' };
    await repository.save(record);
    await repository.save(second);
    const controller = new AppController(
      repository,
      readyRuntimeStatus(root),
      path.join(root, 'jobs'),
    );
    await controller.initialize();

    const sent: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstInFlight = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let pending = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'gemma3:4b', object: 'model', owned_by: 'library' }],
        }), { status: 200 });
      }
      sent.push(controller.getState().activeLocalAiSummary?.transcriptId ?? 'none');
      if (++pending === 1) await firstInFlight;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              overview: 'A short review.',
              keyPoints: [],
              decisions: [],
              actionItems: [],
            }),
          },
        }],
      }), { status: 200 });
    });
    const localAiService = new LocalAiConnectionService({
      filePath: path.join(root, 'local-ai', 'connection.json'),
      credentialCipher: { encrypt: (value) => value, decrypt: (value) => value },
      fetcher: fetcher as typeof fetch,
      now: () => new Date('2026-07-29T20:00:00.000Z'),
    });
    await localAiService.connect({
      baseUrl: 'http://127.0.0.1:11434',
      selectedModel: 'gemma3:4b',
    });

    const previewFirst = await controller.previewLocalAiMeetingSummary(
      record.id,
      localAiService,
    );
    const previewSecond = await controller.previewLocalAiMeetingSummary(
      second.id,
      localAiService,
    );
    if (previewFirst.outcome !== 'ready' || previewSecond.outcome !== 'ready') {
      throw new Error('Expected both previews to be ready.');
    }

    const running = controller.generateLocalAiMeetingSummary(
      record.id,
      localAiService,
      previewFirst.preview.approvalFingerprint,
    );
    await controller.generateLocalAiMeetingSummary(
      second.id,
      localAiService,
      previewSecond.preview.approvalFingerprint,
    );
    controller.cancelLocalAiMeetingSummary(second.id);
    expect(controller.getState().queuedLocalAiSummaries).toEqual([]);

    releaseFirst();
    await running;
    await expect(controller.getTranscript(second.id)).resolves.toMatchObject({
      localAiMeetingSummary: null,
    });
    // Only the first transcript was ever sent.
    expect(sent).toEqual([record.id]);
    await controller.dispose();
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

    // Single-record mutations refresh through repository.get. Gate the
    // first get after the rename mutation lands — that is the rename's
    // refresh read — to model a slow reload without blocking the
    // repository's own mutation chain.
    const originalGet = repository.get.bind(repository);
    const originalRename = repository.renameSpeakerLabel.bind(repository);
    let renameMutationDone = false;
    let refreshGateUsed = false;
    let releaseFirstReload: () => void = () => undefined;
    const firstReloadReleased = new Promise<void>((resolve) => {
      releaseFirstReload = resolve;
    });
    let firstReloadCaptured: () => void = () => undefined;
    const firstReloadStarted = new Promise<void>((resolve) => {
      firstReloadCaptured = resolve;
    });
    vi.spyOn(repository, 'renameSpeakerLabel').mockImplementation(
      async (...args: Parameters<typeof originalRename>) => {
        const result = await originalRename(...args);
        renameMutationDone = true;
        return result;
      },
    );
    vi.spyOn(repository, 'get').mockImplementation(async (id) => {
      if (renameMutationDone && !refreshGateUsed) {
        refreshGateUsed = true;
        const captured = await originalGet(id);
        firstReloadCaptured();
        await firstReloadReleased;
        return captured;
      }
      return originalGet(id);
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

  const makeReadyRecordingController = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-ready-controller-'));
    temporaryRoots.push(root);
    const repository = new TranscriptRepository(path.join(root, 'transcripts'));
    const controller = new AppController(
      repository,
      readyRuntimeStatus(root),
      path.join(root, 'jobs'),
      {
        state: 'ready',
        message: 'Live meeting capture is ready.',
      },
    );
    await controller.initialize();
    return { controller, root };
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

  it('allows microphone-only dictation without screen-recording permission', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-dictation-'));
    temporaryRoots.push(root);
    const repository = new TranscriptRepository(path.join(root, 'transcripts'));
    const controller = new AppController(
      repository,
      readyRuntimeStatus(root),
      path.join(root, 'jobs'),
      {
        state: 'permission-required',
        message: 'Allow Screen & System Audio Recording.',
      },
    );
    await controller.initialize();

    const recording = await controller.startLiveRecording('dictation');
    expect(recording).toMatchObject({ kind: 'dictation' });
    expect(recording.sourceName).toMatch(/^Dictation /u);
    await expect(controller.cancelLiveRecording(recording.id)).resolves.toBe(true);
    await controller.dispose();
  });

  it('allows a first live capture request to reach normal startup checks', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-setup-'));
    temporaryRoots.push(root);
    const repository = new TranscriptRepository(path.join(root, 'transcripts'));
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
      {
        state: 'setup-required',
        message: 'Start live recording to request access.',
      },
    );

    await expect(controller.startLiveRecording()).rejects.toMatchObject({
      code: 'engine-unavailable',
    });
  });

  it('refreshes a capability provider on state reads and recording lifecycle emits', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-capability-provider-'));
    temporaryRoots.push(root);
    const repository = new TranscriptRepository(path.join(root, 'transcripts'));
    let capability: LiveRecordingCapability = {
      state: 'setup-required',
      message: 'Start live recording to request access.',
    };
    const capabilityProvider = vi.fn(
      (): LiveRecordingCapability => capability,
    );
    const controller = new AppController(
      repository,
      readyRuntimeStatus(root),
      path.join(root, 'jobs'),
      capabilityProvider,
    );
    await controller.initialize();

    expect(controller.getState().recording.capability).toEqual(capability);
    const observedCapabilities: LiveRecordingCapability[] = [];
    const unsubscribe = controller.subscribe((state) => {
      observedCapabilities.push(state.recording.capability);
    });

    capability = {
      state: 'ready',
      message: 'Live meeting capture is ready.',
    };
    const recording = await controller.startLiveRecording();
    expect(observedCapabilities.at(-1)).toEqual(capability);

    capability = {
      state: 'permission-required',
      message: 'Allow Screen & System Audio Recording.',
    };
    await expect(controller.cancelLiveRecording(recording.id)).resolves.toBe(true);
    expect(observedCapabilities.at(-1)).toEqual(capability);
    await expect(controller.startLiveRecording()).rejects.toMatchObject({
      code: 'permission-denied',
      message: capability.message,
    });
    expect(controller.getState().recording.capability).toEqual(capability);

    unsubscribe();
    await controller.dispose();
  });

  it('blocks imported transcription while a live recording is active', async () => {
    const { controller, root } = await makeReadyRecordingController();
    const recording = await controller.startLiveRecording();

    await expect(
      controller.startTranscription(importedMedia(root)),
    ).rejects.toMatchObject({
      code: 'busy',
      message: expect.stringContaining('Finish or cancel'),
    });

    await expect(controller.cancelLiveRecording(recording.id)).resolves.toBe(
      true,
    );
    await controller.dispose();
  });

  it('blocks start and retry paths while a live recording is finalizing', async () => {
    const { controller, root } = await makeReadyRecordingController();
    const recording = await controller.startLiveRecording();
    await controller.appendLiveRecordingChunk(
      recording.id,
      new TextEncoder().encode('recording'),
    );

    const recordingService = (
      controller as unknown as {
        recordingService: {
          listSavedRecordings: () => Promise<SavedRecordingSummary[]>;
          repository: {
            promoteFinalizing: (recordingId: string) => Promise<number>;
          };
        };
      }
    ).recordingService;
    const promoteFinalizing = recordingService.repository.promoteFinalizing.bind(
      recordingService.repository,
    );
    const listSavedRecordings = recordingService.listSavedRecordings.bind(
      recordingService,
    );
    let releasePromotion: () => void = () => undefined;
    const promotionReleased = new Promise<void>((resolve) => {
      releasePromotion = resolve;
    });
    let promotionEntered: () => void = () => undefined;
    const promotionStarted = new Promise<void>((resolve) => {
      promotionEntered = resolve;
    });
    let releaseFinalizationReload: () => void = () => undefined;
    const finalizationReloadReleased = new Promise<void>((resolve) => {
      releaseFinalizationReload = resolve;
    });
    let finalizationReloadEntered: () => void = () => undefined;
    const finalizationReloadStarted = new Promise<void>((resolve) => {
      finalizationReloadEntered = resolve;
    });
    vi.spyOn(recordingService.repository, 'promoteFinalizing').mockImplementation(
      async (recordingId) => {
        promotionEntered();
        await promotionReleased;
        return promoteFinalizing(recordingId);
      },
    );
    vi.spyOn(recordingService, 'listSavedRecordings').mockImplementation(
      async () => {
        finalizationReloadEntered();
        await finalizationReloadReleased;
        return listSavedRecordings();
      },
    );

    const finishing = controller.finishLiveRecording(recording.id);
    await promotionStarted;

    expect(controller.getState().recording.active).toMatchObject({
      id: recording.id,
    });
    releasePromotion();
    await finalizationReloadStarted;

    // The service has promoted the file and cleared its own active slot, but
    // the controller keeps the visible recording and exclusivity guard until
    // it can hand the durable media to transcription.
    expect(controller.getState().recording.active).toMatchObject({
      id: recording.id,
    });
    await expect(
      controller.startTranscription(importedMedia(root)),
    ).rejects.toMatchObject({ code: 'busy' });
    await expect(controller.retryRecording(recording.id)).rejects.toMatchObject({
      code: 'busy',
    });
    await expect(controller.startLiveRecording()).rejects.toMatchObject({
      code: 'busy',
    });

    releaseFinalizationReload();
    await expect(finishing).resolves.toMatchObject({
      recordingId: recording.id,
    });
    expect(controller.getState().recording.active).toBeNull();
    await controller.dispose();
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

  it('deletes a linked transcript and saved recording together', async () => {
    const { controller, recordingRepository, transcriptRepository } =
      await makeLiveRecordingController();

    await expect(controller.deleteMeeting(record.id, record.id)).resolves.toEqual({
      outcome: 'deleted',
    });

    await expect(transcriptRepository.get(record.id)).resolves.toBeNull();
    await expect(
      readFile(recordingRepository.durablePath(record.id), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(controller.getState().transcripts).toEqual([]);
    expect(controller.getState().recordings).toEqual([]);
  });

  it('does not delete a recording when the requested transcript is not linked to it', async () => {
    const { controller, recordingRepository, transcriptRepository } =
      await makeLiveRecordingController();
    const unrelatedTranscript: TranscriptRecord = {
      ...record,
      id: '6c6be6e2-5d03-49a1-80f2-a6d849d46b68',
      source: {
        type: 'imported-file',
        name: 'unrelated.mp3',
        mediaKind: 'audio',
        sizeBytes: 42,
      },
    };
    await transcriptRepository.save(unrelatedTranscript);

    await expect(
      controller.deleteMeeting(record.id, unrelatedTranscript.id),
    ).resolves.toEqual({ outcome: 'not-found' });

    await expect(transcriptRepository.get(record.id)).resolves.toMatchObject({
      id: record.id,
    });
    await expect(transcriptRepository.get(unrelatedTranscript.id)).resolves.toMatchObject({
      id: unrelatedTranscript.id,
    });
    await expect(
      readFile(recordingRepository.durablePath(record.id), 'utf8'),
    ).resolves.toBe('durable webm');
  });

  it('does not delete either part of a meeting while transcription is active', async () => {
    const { controller, recordingRepository, transcriptRepository } =
      await makeLiveRecordingController();
    await recordingRepository.updateTranscription(record.id, {
      state: 'transcribing',
      updatedAt: '2026-07-27T12:06:00.000Z',
      message: 'Transcribing locally.',
      jobId: record.id,
    });

    await expect(controller.deleteMeeting(record.id, record.id)).resolves.toMatchObject({
      outcome: 'rejected',
    });

    await expect(transcriptRepository.get(record.id)).resolves.toMatchObject({
      id: record.id,
    });
    await expect(
      readFile(recordingRepository.durablePath(record.id), 'utf8'),
    ).resolves.toBe('durable webm');
  });

  it('reports a partial deletion and refreshes the remaining recording', async () => {
    const { controller, recordingRepository, transcriptRepository } =
      await makeLiveRecordingController();
    const recordingService = (
      controller as unknown as {
        recordingService: { delete: (recordingId: string) => Promise<boolean> };
      }
    ).recordingService;
    vi.spyOn(recordingService, 'delete').mockRejectedValue(
      new Error('The recording is locked.'),
    );

    await expect(controller.deleteMeeting(record.id, record.id)).resolves.toEqual({
      outcome: 'partial',
      reason: 'The transcript was deleted, but Sotto could not delete the saved recording.',
    });

    await expect(transcriptRepository.get(record.id)).resolves.toBeNull();
    await expect(
      readFile(recordingRepository.durablePath(record.id), 'utf8'),
    ).resolves.toBe('durable webm');
    expect(controller.getState().transcripts).toEqual([]);
    expect(controller.getState().recordings).toEqual([
      expect.objectContaining({ id: record.id }),
    ]);
  });

  it('deletes imported playback independently and with its transcript', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-imported-playback-'));
    temporaryRoots.push(root);
    const transcriptRepository = new TranscriptRepository(
      path.join(root, 'transcripts'),
    );
    await transcriptRepository.save(record);
    const controller = new AppController(
      transcriptRepository,
      readyRuntimeStatus(root),
      path.join(root, 'jobs'),
    );
    await controller.initialize();
    const playbackRepository = (
      controller as unknown as { playbackRepository: PlaybackRepository }
    ).playbackRepository;
    const normalizedPath = path.join(root, 'normalized.wav');
    await writeFile(normalizedPath, Buffer.alloc(64));
    await playbackRepository.retain(record.id, normalizedPath);

    await expect(controller.getTranscript(record.id)).resolves.toMatchObject({
      playback: {
        state: 'available',
        kind: 'imported-audio-copy',
        sizeBytes: 64,
      },
    });
    await expect(controller.deletePlayback(record.id)).resolves.toBe(true);
    await expect(transcriptRepository.get(record.id)).resolves.toMatchObject({
      id: record.id,
    });
    await expect(controller.getTranscript(record.id)).resolves.toMatchObject({
      playback: { state: 'unavailable', reason: 'missing' },
    });

    await playbackRepository.retain(record.id, normalizedPath);
    await expect(controller.deleteTranscript(record.id)).resolves.toBe(true);
    await expect(playbackRepository.get(record.id)).resolves.toBeNull();
  });

  it('reconciles recording metadata from the cached recording transcript id set', async () => {
    const { controller } = await makeLiveRecordingController();

    expect(controller.getState().recordings).toEqual([
      expect.objectContaining({
        id: record.id,
        transcriptionState: 'completed',
        transcriptId: record.id,
      }),
    ]);
    await controller.dispose();
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
