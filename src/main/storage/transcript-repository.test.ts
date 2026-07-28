import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  TRANSCRIPT_SCHEMA_VERSION,
  TranscriptValidationError,
  type TranscriptRecord,
} from '../transcription/transcript-types';
import { TranscriptRepository } from './transcript-repository';

const FIRST_ID = '32ce6fee-8f3e-4f03-a266-46d6c00ef08c';
const SECOND_ID = '8a219ad8-2544-47dd-b984-a2369a105a9e';

const createRecord = (
  id = FIRST_ID,
  createdAt = '2026-07-27T12:00:00.000Z',
  completedAt = '2026-07-27T12:01:00.000Z',
): TranscriptRecord => ({
  schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
  id,
  title: 'Weekly product meeting',
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
  text: 'Welcome to Sotto.',
  segments: [{ startMs: 0, endMs: 2_500, text: 'Welcome to Sotto.' }],
});

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
});
