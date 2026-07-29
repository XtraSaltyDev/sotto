import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PlaybackRepository } from './playback-repository';

const FIRST_ID = '32ce6fee-8f3e-4f03-a266-46d6c00ef08c';
const SECOND_ID = '8a219ad8-2544-47dd-b984-a2369a105a9e';
const roots: string[] = [];

const makeRepository = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-playback-'));
  roots.push(root);
  const repository = new PlaybackRepository(path.join(root, 'playback'));
  await repository.initialize();
  return { repository, root };
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('PlaybackRepository', () => {
  it('atomically retains a private normalized WAV without changing its source', async () => {
    const { repository, root } = await makeRepository();
    const sourcePath = path.join(root, 'normalized.wav');
    const source = Buffer.alloc(128, 7);
    await writeFile(sourcePath, source);

    await expect(repository.retain(FIRST_ID, sourcePath)).resolves.toBe(128);
    await expect(readFile(sourcePath)).resolves.toEqual(source);
    const retained = await repository.get(FIRST_ID);
    expect(retained).toMatchObject({ sizeBytes: 128 });
    await expect(readFile(retained?.path ?? '')).resolves.toEqual(source);
    expect((await readdir(path.join(root, 'playback'))).sort()).toEqual([FIRST_ID]);

    if (process.platform !== 'win32') {
      expect((await stat(retained?.path ?? '')).mode & 0o777).toBe(0o600);
    }
  });

  it('deletes only the requested copy and reports idempotent absence', async () => {
    const { repository, root } = await makeRepository();
    const sourcePath = path.join(root, 'normalized.wav');
    await writeFile(sourcePath, Buffer.alloc(64));
    await repository.retain(FIRST_ID, sourcePath);
    await repository.retain(SECOND_ID, sourcePath);

    await expect(repository.delete(FIRST_ID)).resolves.toBe(true);
    await expect(repository.delete(FIRST_ID)).resolves.toBe(false);
    await expect(repository.get(SECOND_ID)).resolves.toMatchObject({ sizeBytes: 64 });
  });

  it('cleans abandoned temporary files and transcript-orphaned directories', async () => {
    const { repository, root } = await makeRepository();
    const playbackRoot = path.join(root, 'playback');
    await writeFile(path.join(playbackRoot, `${FIRST_ID}.abandoned.tmp`), 'partial');
    await mkdir(path.join(playbackRoot, SECOND_ID));
    await writeFile(path.join(playbackRoot, SECOND_ID, 'playback.wav'), Buffer.alloc(64));

    await repository.initialize();
    await expect(repository.cleanupOrphans(new Set([FIRST_ID]))).resolves.toBe(1);
    await expect(readdir(playbackRoot)).resolves.toEqual([]);
  });
});
