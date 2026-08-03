import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecordingRepository } from './recording-repository';
import type { RecordingMetadata } from './recording-metadata';

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>(
    'node:fs/promises',
  );
  return {
    ...actual,
    open: vi.fn(actual.open),
  };
});

const RECORDING_ID = '00000000-0000-4000-8000-000000000001';
const STARTED_AT = '2026-07-29T12:00:00.000Z';

const partialMetadata = (): RecordingMetadata => ({
  schemaVersion: 1,
  id: RECORDING_ID,
  sourceName: 'Live meeting.webm',
  startedAt: STARTED_AT,
  completedAt: null,
  sizeBytes: 0,
  storageState: 'partial',
  transcription: {
    state: 'ready',
    updatedAt: STARTED_AT,
    message: 'Recording in progress.',
  },
});

describe('RecordingRepository', () => {
  let root: string | undefined;

  afterEach(async () => {
    vi.mocked(open).mockClear();
    if (root) await rm(root, { force: true, recursive: true });
    root = undefined;
  });

  it('opens a partial recording with write access before syncing it', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'sotto-recording-repository-'));
    const repository = new RecordingRepository(root);
    const partialPath = repository.partialPath(RECORDING_ID);
    const contents = Buffer.from('webm test bytes');
    await mkdir(path.dirname(partialPath), { recursive: true });
    await writeFile(partialPath, contents);
    vi.mocked(open).mockClear();

    await expect(repository.promotePartial(RECORDING_ID)).resolves.toBe(
      contents.byteLength,
    );

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(partialPath, 'r+');
    await expect(readFile(repository.durablePath(RECORDING_ID))).resolves.toEqual(
      contents,
    );
  });

  it('recovers audio whose encoder closed before durable promotion finished', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'sotto-recording-repository-'));
    const repository = new RecordingRepository(root);
    const contents = Buffer.from('closed webm bytes');
    const completedAt = '2026-07-29T12:00:05.000Z';
    await repository.initialize();
    await repository.createPartial(partialMetadata());
    await writeFile(repository.partialPath(RECORDING_ID), contents);

    await expect(
      repository.markFinalizing(RECORDING_ID, completedAt),
    ).resolves.toBe(contents.byteLength);
    await expect(stat(repository.partialPath(RECORDING_ID))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(repository.finalizingPath(RECORDING_ID))).resolves.toEqual(
      contents,
    );

    const restarted = new RecordingRepository(root);
    await restarted.initialize();

    await expect(readFile(restarted.durablePath(RECORDING_ID))).resolves.toEqual(
      contents,
    );
    await expect(restarted.list()).resolves.toEqual([
      expect.objectContaining({
        id: RECORDING_ID,
        completedAt,
        sizeBytes: contents.byteLength,
        storageState: 'complete',
      }),
    ]);
  });

  it('preserves a capture that was interrupted before its encoder closed', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'sotto-recording-repository-'));
    const repository = new RecordingRepository(root);
    await repository.initialize();
    await repository.createPartial(partialMetadata());
    await writeFile(repository.partialPath(RECORDING_ID), 'interrupted');

    const restarted = new RecordingRepository(root);
    await restarted.initialize();

    await expect(
      readFile(restarted.durablePath(RECORDING_ID), 'utf8'),
    ).resolves.toBe('interrupted');
    await expect(restarted.list()).resolves.toEqual([
      expect.objectContaining({
        id: RECORDING_ID,
        storageState: 'complete',
        transcription: expect.objectContaining({ state: 'ready' }),
      }),
    ]);
  });

  it('removes an interrupted capture that recorded no audio at all', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'sotto-recording-repository-'));
    const repository = new RecordingRepository(root);
    await repository.initialize();
    await repository.createPartial(partialMetadata());
    await writeFile(repository.partialPath(RECORDING_ID), '');

    const restarted = new RecordingRepository(root);
    await restarted.initialize();

    await expect(
      stat(path.dirname(restarted.partialPath(RECORDING_ID))),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
