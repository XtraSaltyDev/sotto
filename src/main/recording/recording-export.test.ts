import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  copyRecordingForExport,
  type RecordingExportOperations,
} from './recording-export';

describe('copyRecordingForExport', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  const makePaths = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-export-'));
    roots.push(root);
    return {
      destinationPath: path.join(root, 'Meeting.webm'),
      root,
      sourcePath: path.join(root, 'recording.webm'),
    };
  };

  it('copies through an adjacent temporary file and replaces the destination', async () => {
    const paths = await makePaths();
    await writeFile(paths.sourcePath, 'durable original', { mode: 0o600 });
    await writeFile(paths.destinationPath, 'older export');

    await copyRecordingForExport(paths.sourcePath, paths.destinationPath);

    await expect(readFile(paths.destinationPath, 'utf8')).resolves.toBe(
      'durable original',
    );
    expect((await readdir(paths.root)).sort()).toEqual(
      ['Meeting.webm', 'recording.webm'].sort(),
    );
  });

  it('cleans a failed disk-full temporary copy without replacing an existing export', async () => {
    const paths = await makePaths();
    await writeFile(paths.sourcePath, 'durable original');
    await writeFile(paths.destinationPath, 'existing export');
    const operations: RecordingExportOperations = {
      chmod: async () => undefined,
      copyFile: async (_source, temporaryPath) => {
        await writeFile(temporaryPath, 'partial');
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      },
      rename: async () => undefined,
      unlink: async (filePath) => {
        await rm(filePath, { force: true });
      },
    };

    await expect(
      copyRecordingForExport(
        paths.sourcePath,
        paths.destinationPath,
        operations,
      ),
    ).rejects.toMatchObject({ code: 'ENOSPC' });
    await expect(readFile(paths.destinationPath, 'utf8')).resolves.toBe(
      'existing export',
    );
    expect((await readdir(paths.root)).sort()).toEqual(
      ['Meeting.webm', 'recording.webm'].sort(),
    );
  });
});
