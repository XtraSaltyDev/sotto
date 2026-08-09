import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { provisionManagedDefaultModel } from './managed-model';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe('managed default transcription model', () => {
  it('verifies and migrates the bundled seed into managed app data', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-managed-model-'));
    temporaryDirectories.push(root);
    const bundled = path.join(root, 'resources', 'model.bin');
    const managed = path.join(root, 'app-data', 'managed-models');
    const bytes = Buffer.from('verified-model');
    await mkdir(path.dirname(bundled), { recursive: true });
    await writeFile(bundled, bytes);

    const destination = await provisionManagedDefaultModel({
      bundledModelPath: bundled,
      managedModelsDirectory: managed,
      identity: {
        fileName: 'model.bin',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      },
    });

    await expect(readFile(destination)).resolves.toEqual(bytes);
  });

  it('rejects a seed that does not match the pinned model identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-managed-model-'));
    temporaryDirectories.push(root);
    const bundled = path.join(root, 'model.bin');
    await writeFile(bundled, 'wrong');

    await expect(
      provisionManagedDefaultModel({
        bundledModelPath: bundled,
        managedModelsDirectory: path.join(root, 'managed'),
        identity: { fileName: 'model.bin', sha256: 'a'.repeat(64), size: 5 },
      }),
    ).rejects.toThrow(/failed verification/u);
  });
});
