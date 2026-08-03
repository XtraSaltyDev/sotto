import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  consumePendingPermissionRepair,
  markPendingPermissionRepair,
} from './post-update-permissions';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const userDataDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sotto-permissions-'));
  temporaryDirectories.push(directory);
  return directory;
};

describe('post-update permission repair marker', () => {
  it('consumes a written marker exactly once', async () => {
    const directory = await userDataDirectory();
    await markPendingPermissionRepair(directory);

    await expect(consumePendingPermissionRepair(directory)).resolves.toBe(true);
    await expect(consumePendingPermissionRepair(directory)).resolves.toBe(false);
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it('reports no pending repair on a normal launch', async () => {
    const directory = await userDataDirectory();
    await expect(consumePendingPermissionRepair(directory)).resolves.toBe(false);
  });

  it('creates the directory when marking before it exists', async () => {
    const directory = path.join(await userDataDirectory(), 'nested');
    await markPendingPermissionRepair(directory);
    await expect(consumePendingPermissionRepair(directory)).resolves.toBe(true);
  });
});
