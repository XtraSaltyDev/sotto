import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LEGACY_TRANSCRIPT_SCHEMA_VERSION,
  MAX_SPEAKER_LABEL_CHARACTERS,
  MAX_TRANSCRIPT_SPEAKERS,
  SPEAKER_TRANSCRIPT_SCHEMA_VERSION,
  TRANSCRIPT_SCHEMA_VERSION,
  WORD_TIMING_TRANSCRIPT_SCHEMA_VERSION,
  TranscriptValidationError,
  type TranscriptRecord,
  type TranscriptSpeakerAnalysis,
} from '../transcription/transcript-types';
import { TranscriptRepository } from './transcript-repository';

const FIRST_ID = '32ce6fee-8f3e-4f03-a266-46d6c00ef08c';
const SECOND_ID = '8a219ad8-2544-47dd-b984-a2369a105a9e';
const FIRST_SPEAKER_ID = '6d73be9d-c055-4dc2-93d6-d821fb4f95ec';
const SECOND_SPEAKER_ID = 'a75d6b1a-eaa3-43bf-8084-08e3b509c445';
const UNKNOWN_SPEAKER_ID = '61e5aa03-c688-49d6-98a7-0537cb406e90';

const createRecord = (
  id = FIRST_ID,
  createdAt = '2026-07-27T12:00:00.000Z',
  completedAt = '2026-07-27T12:01:00.000Z',
): TranscriptRecord => ({
  schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
  id,
  title: 'Weekly product meeting',
  tags: [],
  createdAt,
  completedAt,
  source: {
    type: 'imported-file',
    name: 'weekly-meeting.mp4',
    mediaKind: 'video',
    sizeBytes: 12_345,
  },
  durationMs: 2_500,
  language: 'en',
  engine: {
    name: 'whisper.cpp',
    model: 'ggml-base.en.bin',
    version: 'v1.8.2',
  },
  speakerAnalysis: null,
  text: 'Welcome to Sotto.',
  segments: [
    {
      startMs: 0,
      endMs: 2_500,
      text: 'Welcome to Sotto.',
      speakerId: null,
      words: [],
    },
  ],
});

const createSpeakerRecord = (): TranscriptRecord => ({
  ...createRecord(),
  speakerAnalysis: {
    engine: {
      name: 'local-speaker-diarization',
      model: 'community-1',
      version: '1.0.0',
    },
    speakers: [
      { id: FIRST_SPEAKER_ID, label: 'Speaker 1' },
      { id: SECOND_SPEAKER_ID, label: 'Speaker 2' },
    ],
  },
  text: 'Welcome to Sotto. This stays private.',
  segments: [
    {
      startMs: 0,
      endMs: 1_250,
      text: 'Welcome to Sotto.',
      speakerId: FIRST_SPEAKER_ID,
      words: [],
    },
    {
      startMs: 1_250,
      endMs: 2_500,
      text: 'This stays private.',
      speakerId: SECOND_SPEAKER_ID,
      words: [],
    },
  ],
});

const createLegacyRecord = () => {
  const record = createRecord();
  return {
    schemaVersion: LEGACY_TRANSCRIPT_SCHEMA_VERSION,
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    source: record.source,
    durationMs: record.durationMs,
    language: record.language,
    engine: record.engine,
    text: record.text,
    segments: record.segments.map(({ startMs, endMs, text }) => ({
      startMs,
      endMs,
      text,
    })),
  };
};

const createSchemaV2Record = () => {
  const record = createSpeakerRecord();
  return {
    ...record,
    schemaVersion: SPEAKER_TRANSCRIPT_SCHEMA_VERSION,
    segments: record.segments.map((segment) => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      speakerId: segment.speakerId,
    })),
  };
};

const createSchemaV3Record = () => {
  const record = createSpeakerRecord();
  return {
    ...record,
    schemaVersion: WORD_TIMING_TRANSCRIPT_SCHEMA_VERSION,
    tags: undefined,
  };
};

const requireSpeakerAnalysis = (
  record: TranscriptRecord,
): TranscriptSpeakerAnalysis => {
  if (!record.speakerAnalysis) {
    throw new Error('The test record must include speaker analysis.');
  }
  return record.speakerAnalysis;
};

describe('TranscriptRepository', () => {
  let rootPath: string;
  let repository: TranscriptRepository;

  beforeEach(async () => {
    rootPath = await mkdtemp(path.join(os.tmpdir(), 'sotto-transcripts-'));
    repository = new TranscriptRepository(rootPath);
  });

  afterEach(async () => {
    await rm(rootPath, { recursive: true, force: true });
  });

  it('atomically saves one canonical JSON file and retrieves it', async () => {
    const record = createRecord();

    await expect(repository.save(record)).resolves.toEqual(record);
    await expect(repository.get(record.id)).resolves.toEqual(record);

    expect(await readdir(rootPath)).toEqual([`${record.id}.json`]);
  });

  it('reads schema-v1 records as canonical v4 without rewriting them', async () => {
    const legacyRecord = createLegacyRecord();
    const filePath = path.join(rootPath, `${legacyRecord.id}.json`);
    const serialized = `${JSON.stringify(legacyRecord, null, 2)}\n`;
    await writeFile(filePath, serialized, { encoding: 'utf8', mode: 0o600 });

    await expect(repository.get(legacyRecord.id)).resolves.toEqual(createRecord());
    await expect(readFile(filePath, 'utf8')).resolves.toBe(serialized);

    await expect(
      repository.renameSpeakerLabel(
        legacyRecord.id,
        FIRST_SPEAKER_ID,
        'Mike',
      ),
    ).resolves.toEqual({ outcome: 'not-found' });
    await expect(readFile(filePath, 'utf8')).resolves.toBe(serialized);
  });

  it('lists mixed schema-v1 and schema-v2 records normally', async () => {
    const legacyRecord = createLegacyRecord();
    await writeFile(
      path.join(rootPath, `${legacyRecord.id}.json`),
      `${JSON.stringify(legacyRecord)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    const newer = createRecord(
      SECOND_ID,
      '2026-07-27T12:30:00.000Z',
      '2026-07-27T13:00:00.000Z',
    );
    await repository.save(newer);

    await expect(repository.list()).resolves.toEqual([newer, createRecord()]);
  });

  it('reads schema-v2 speaker records with empty word timings', async () => {
    const schemaV2 = createSchemaV2Record();
    await writeFile(
      path.join(rootPath, `${schemaV2.id}.json`),
      `${JSON.stringify(schemaV2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );

    await expect(repository.get(schemaV2.id)).resolves.toEqual(
      createSpeakerRecord(),
    );
  });

  it('reads schema-v3 word timings with empty library tags', async () => {
    const schemaV3 = createSchemaV3Record();
    const serialized = `${JSON.stringify(schemaV3)}\n`;
    const filePath = path.join(rootPath, `${schemaV3.id}.json`);
    await writeFile(filePath, serialized, { encoding: 'utf8', mode: 0o600 });

    await expect(repository.get(schemaV3.id)).resolves.toEqual(
      createSpeakerRecord(),
    );
    await expect(readFile(filePath, 'utf8')).resolves.toBe(serialized);
  });

  it('lets an older schema-v1 transcript be corrected through canonical storage', async () => {
    const legacyRecord = createLegacyRecord();
    const filePath = path.join(rootPath, `${legacyRecord.id}.json`);
    await writeFile(filePath, `${JSON.stringify(legacyRecord)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });

    await expect(
      repository.updateSegmentText(legacyRecord.id, 0, 'Corrected legacy text.'),
    ).resolves.toMatchObject({ outcome: 'updated' });
    await expect(repository.get(legacyRecord.id)).resolves.toMatchObject({
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      text: 'Corrected legacy text.',
      segments: [{ text: 'Corrected legacy text.', speakerId: null, words: [] }],
    });
  });

  it('round-trips speaker analysis and segment assignments', async () => {
    const record = createSpeakerRecord();

    await expect(repository.save(record)).resolves.toEqual(record);
    await expect(repository.get(record.id)).resolves.toEqual(record);
  });

  it('lists valid records newest first while isolating corrupt records', async () => {
    const older = createRecord(
      FIRST_ID,
      '2026-07-27T10:00:00.000Z',
      '2026-07-27T12:00:00.000Z',
    );
    const newer = createRecord(
      SECOND_ID,
      '2026-07-27T09:00:00.000Z',
      '2026-07-27T13:00:00.000Z',
    );
    await repository.save(older);
    await repository.save(newer);
    await writeFile(path.join(rootPath, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json'), '{');

    await expect(repository.list()).resolves.toEqual([newer, older]);
  });

  it('returns null for missing and corrupt individual records', async () => {
    await expect(repository.get(FIRST_ID)).resolves.toBeNull();
    await writeFile(path.join(rootPath, `${FIRST_ID}.json`), '{broken');
    await expect(repository.get(FIRST_ID)).resolves.toBeNull();
  });

  it('deletes a record idempotently', async () => {
    const record = createRecord();
    await repository.save(record);

    await expect(repository.delete(record.id)).resolves.toBe(true);
    await expect(repository.delete(record.id)).resolves.toBe(false);
  });

  it('cleans abandoned temporary files without touching records or directories', async () => {
    const record = createRecord();
    await repository.save(record);
    await writeFile(path.join(rootPath, `${record.id}.abandoned.tmp`), 'partial');
    await mkdir(path.join(rootPath, 'keep.tmp'));

    await expect(repository.cleanupTemporaryFiles()).resolves.toBe(1);
    expect((await readdir(rootPath)).sort()).toEqual(
      [`${record.id}.json`, 'keep.tmp'].sort(),
    );
  });

  it.each([
    {
      label: 'absolute title',
      mutate: (record: TranscriptRecord) => {
        record.title = '/Users/example/meeting.mp4';
      },
    },
    {
      label: 'source path',
      mutate: (record: TranscriptRecord) => {
        record.source.name = 'C:\\Users\\example\\meeting.mp4';
      },
    },
  ])('refuses to persist a $label', async ({ mutate }) => {
    const record = createRecord();
    mutate(record);

    await expect(repository.save(record)).rejects.toBeInstanceOf(
      TranscriptValidationError,
    );
    expect(await readdir(rootPath)).toEqual([]);
  });

  it('rejects ids that could escape the repository root', async () => {
    await expect(repository.get('../../outside')).rejects.toBeInstanceOf(
      TranscriptValidationError,
    );
  });

  it('rejects a completion time earlier than the job creation time', async () => {
    const record = createRecord(
      FIRST_ID,
      '2026-07-27T12:00:00.000Z',
      '2026-07-27T11:59:59.000Z',
    );

    await expect(repository.save(record)).rejects.toBeInstanceOf(
      TranscriptValidationError,
    );
  });

  it.each([
    {
      label: 'duplicate speaker ids',
      mutate: (record: TranscriptRecord) => {
        requireSpeakerAnalysis(record).speakers[1].id = FIRST_SPEAKER_ID;
      },
    },
    {
      label: 'empty speaker label',
      mutate: (record: TranscriptRecord) => {
        requireSpeakerAnalysis(record).speakers[0].label = '   ';
      },
    },
    {
      label: 'oversized speaker label',
      mutate: (record: TranscriptRecord) => {
        requireSpeakerAnalysis(record).speakers[0].label = 'x'.repeat(
          MAX_SPEAKER_LABEL_CHARACTERS + 1,
        );
      },
    },
    {
      label: 'speaker label with a control character',
      mutate: (record: TranscriptRecord) => {
        requireSpeakerAnalysis(record).speakers[0].label = 'Mike\nSmith';
      },
    },
    {
      label: 'invalid speaker id',
      mutate: (record: TranscriptRecord) => {
        requireSpeakerAnalysis(record).speakers[0].id = 'speaker-1';
      },
    },
    {
      label: 'segment with a dangling speaker reference',
      mutate: (record: TranscriptRecord) => {
        record.segments[0].speakerId = UNKNOWN_SPEAKER_ID;
      },
    },
  ])('rejects a v2 record with $label', async ({ mutate }) => {
    const record = createSpeakerRecord();
    mutate(record);

    await expect(repository.save(record)).rejects.toBeInstanceOf(
      TranscriptValidationError,
    );
    expect(await readdir(rootPath)).toEqual([]);
  });

  it('bounds the number of declared speakers', async () => {
    const record = createSpeakerRecord();
    requireSpeakerAnalysis(record).speakers = Array.from(
      { length: MAX_TRANSCRIPT_SPEAKERS + 1 },
      (_, index) => ({
        id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
        label: `Speaker ${index + 1}`,
      }),
    );

    await expect(repository.save(record)).rejects.toBeInstanceOf(
      TranscriptValidationError,
    );
  });

  it('renames one speaker atomically while preserving the transcript', async () => {
    const record = createSpeakerRecord();
    await repository.save(record);

    const result = await repository.renameSpeakerLabel(
      record.id,
      FIRST_SPEAKER_ID.toUpperCase(),
      '  Mike  ',
    );
    expect(result.outcome).toBe('renamed');
    if (result.outcome !== 'renamed') return;

    expect(result.speaker).toEqual({ id: FIRST_SPEAKER_ID, label: 'Mike' });
    expect(result.record).toEqual({
      ...record,
      speakerAnalysis: {
        ...requireSpeakerAnalysis(record),
        speakers: [
          { id: FIRST_SPEAKER_ID, label: 'Mike' },
          { id: SECOND_SPEAKER_ID, label: 'Speaker 2' },
        ],
      },
    });
    await expect(repository.get(record.id)).resolves.toEqual(result.record);
  });

  it('returns not-found and leaves the record unchanged for an unknown speaker', async () => {
    const record = createSpeakerRecord();
    await repository.save(record);
    const filePath = path.join(rootPath, `${record.id}.json`);
    const before = await readFile(filePath, 'utf8');

    await expect(
      repository.renameSpeakerLabel(record.id, UNKNOWN_SPEAKER_ID, 'Unknown'),
    ).resolves.toEqual({ outcome: 'not-found' });
    await expect(readFile(filePath, 'utf8')).resolves.toBe(before);
  });

  it('returns not-found for a missing transcript and validates rename ids', async () => {
    await expect(
      repository.renameSpeakerLabel(SECOND_ID, FIRST_SPEAKER_ID, 'Mike'),
    ).resolves.toEqual({ outcome: 'not-found' });
    await expect(
      repository.renameSpeakerLabel('../../outside', FIRST_SPEAKER_ID, 'Mike'),
    ).rejects.toBeInstanceOf(TranscriptValidationError);
    await expect(
      repository.renameSpeakerLabel(FIRST_ID, 'speaker-1', 'Mike'),
    ).rejects.toBeInstanceOf(TranscriptValidationError);
  });

  it('rejects an invalid rename without changing the record', async () => {
    const record = createSpeakerRecord();
    await repository.save(record);
    const filePath = path.join(rootPath, `${record.id}.json`);
    const before = await readFile(filePath, 'utf8');

    await expect(
      repository.renameSpeakerLabel(record.id, FIRST_SPEAKER_ID, 'Mike\nSmith'),
    ).rejects.toBeInstanceOf(TranscriptValidationError);
    await expect(readFile(filePath, 'utf8')).resolves.toBe(before);
  });

  it('applies a delete invoked during a rename after the rename completes', async () => {
    const record = createSpeakerRecord();
    await repository.save(record);

    const originalSave = repository.save.bind(repository);
    let signalSaveStarted = (): void => undefined;
    let releaseSave = (): void => undefined;
    const saveStarted = new Promise<void>((resolve) => {
      signalSaveStarted = resolve;
    });
    const saveMayFinish = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    repository.save = async (candidate) => {
      signalSaveStarted();
      await saveMayFinish;
      return originalSave(candidate);
    };

    const renameResult = repository.renameSpeakerLabel(
      record.id,
      FIRST_SPEAKER_ID,
      'Mike',
    );
    await saveStarted;
    const deleteResult = repository.delete(record.id);
    const deleteBeforeRelease = await Promise.race([
      deleteResult.then(() => 'deleted' as const),
      new Promise<'pending'>((resolve) => {
        setTimeout(() => resolve('pending'), 50);
      }),
    ]);

    releaseSave();
    await expect(renameResult).resolves.toMatchObject({ outcome: 'renamed' });
    await expect(deleteResult).resolves.toBe(true);

    expect(deleteBeforeRelease).toBe('pending');
    await expect(repository.get(record.id)).resolves.toBeNull();
  });

  it('serializes concurrent speaker renames so neither edit is lost', async () => {
    const record = createSpeakerRecord();
    await repository.save(record);

    await Promise.all([
      repository.renameSpeakerLabel(record.id, FIRST_SPEAKER_ID, 'Mike'),
      repository.renameSpeakerLabel(record.id, SECOND_SPEAKER_ID, 'Sarah'),
    ]);

    const saved = await repository.get(record.id);
    expect(saved?.speakerAnalysis?.speakers).toEqual([
      { id: FIRST_SPEAKER_ID, label: 'Mike' },
      { id: SECOND_SPEAKER_ID, label: 'Sarah' },
    ]);
  });

  it('updates one segment without changing its timing or speaker assignment', async () => {
    const record = createSpeakerRecord();
    record.segments[0].words = [
      { startMs: 0, endMs: 600, text: 'Welcome' },
      { startMs: 600, endMs: 1_250, text: ' to Sotto.' },
    ];
    await repository.save(record);

    await expect(
      repository.updateSegmentText(
        record.id,
        0,
        '  Welcome to the private Sotto workspace.  ',
      ),
    ).resolves.toMatchObject({
      outcome: 'updated',
      segment: {
        startMs: 0,
        endMs: 1_250,
        speakerId: FIRST_SPEAKER_ID,
        text: 'Welcome to the private Sotto workspace.',
        words: [],
      },
    });

    await expect(repository.get(record.id)).resolves.toMatchObject({
      text: 'Welcome to the private Sotto workspace. This stays private.',
      segments: [
        {
          startMs: 0,
          endMs: 1_250,
          speakerId: FIRST_SPEAKER_ID,
          text: 'Welcome to the private Sotto workspace.',
          words: [],
        },
        record.segments[1],
      ],
    });
  });

  it('rejects empty corrections and missing segment indexes without rewriting', async () => {
    const record = createRecord();
    await repository.save(record);
    const filePath = path.join(rootPath, `${record.id}.json`);
    const before = await readFile(filePath, 'utf8');

    await expect(
      repository.updateSegmentText(record.id, 0, ' \n\t '),
    ).rejects.toThrow('Transcript segment text cannot be empty.');
    await expect(
      repository.updateSegmentText(record.id, 4, 'Missing segment'),
    ).resolves.toEqual({ outcome: 'not-found' });
    await expect(readFile(filePath, 'utf8')).resolves.toBe(before);
  });

  it('serializes a correction and speaker rename so neither change is lost', async () => {
    const record = createSpeakerRecord();
    await repository.save(record);

    await Promise.all([
      repository.updateSegmentText(record.id, 0, 'Corrected welcome.'),
      repository.renameSpeakerLabel(record.id, FIRST_SPEAKER_ID, 'Morgan'),
    ]);

    await expect(repository.get(record.id)).resolves.toMatchObject({
      text: 'Corrected welcome. This stays private.',
      segments: expect.arrayContaining([
        expect.objectContaining({
          text: 'Corrected welcome.',
          speakerId: FIRST_SPEAKER_ID,
        }),
      ]),
      speakerAnalysis: {
        speakers: [
          { id: FIRST_SPEAKER_ID, label: 'Morgan' },
          { id: SECOND_SPEAKER_ID, label: 'Speaker 2' },
        ],
      },
    });
  });

  it('atomically updates a title and normalized tags without losing content', async () => {
    const record = createSpeakerRecord();
    await repository.save(record);

    await expect(
      repository.updateMetadata(record.id, {
        title: '  Customer launch review  ',
        tags: [' Client ', 'Planning', 'client'],
      }),
    ).resolves.toMatchObject({
      outcome: 'updated',
      record: {
        title: 'Customer launch review',
        tags: ['Client', 'Planning'],
        text: record.text,
        segments: record.segments,
      },
    });

    const saved = await repository.get(record.id);
    expect(saved).toMatchObject({
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      title: 'Customer launch review',
      tags: ['Client', 'Planning'],
      text: record.text,
    });
    expect((await readdir(rootPath)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects invalid metadata without rewriting the transcript', async () => {
    const record = createRecord();
    await repository.save(record);
    const filePath = path.join(rootPath, `${record.id}.json`);
    const before = await readFile(filePath, 'utf8');

    await expect(
      repository.updateMetadata(record.id, { title: '/Users/name/private' }),
    ).rejects.toThrow('absolute path');
    await expect(
      repository.updateMetadata(record.id, { tags: ['bad,tag'] }),
    ).rejects.toThrow('cannot contain a comma');
    await expect(readFile(filePath, 'utf8')).resolves.toBe(before);
  });

  it('serializes metadata updates with segment and speaker edits', async () => {
    const record = createSpeakerRecord();
    await repository.save(record);

    await Promise.all([
      repository.updateMetadata(record.id, {
        title: 'Renamed meeting',
        tags: ['Important'],
      }),
      repository.updateSegmentText(record.id, 0, 'Corrected welcome.'),
      repository.renameSpeakerLabel(record.id, FIRST_SPEAKER_ID, 'Morgan'),
    ]);

    await expect(repository.get(record.id)).resolves.toMatchObject({
      title: 'Renamed meeting',
      tags: ['Important'],
      text: 'Corrected welcome. This stays private.',
      speakerAnalysis: {
        speakers: [
          { id: FIRST_SPEAKER_ID, label: 'Morgan' },
          { id: SECOND_SPEAKER_ID, label: 'Speaker 2' },
        ],
      },
    });
  });
});
