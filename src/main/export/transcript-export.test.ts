import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  writeTranscriptExport,
  type TranscriptExportOperations,
} from './transcript-export';

describe('writeTranscriptExport', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  const makeDestination = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-transcript-export-'));
    roots.push(root);
    return {
      destinationPath: path.join(root, 'Meeting.docx'),
      root,
    };
  };

  it.each([
    { content: 'plain transcript', label: 'text' },
    { content: Buffer.from('PK\u0003\u0004docx'), label: 'DOCX bytes' },
  ])('atomically replaces a destination with $label', async ({ content }) => {
    const paths = await makeDestination();
    await writeFile(paths.destinationPath, 'older export');

    await writeTranscriptExport(paths.destinationPath, content);

    await expect(readFile(paths.destinationPath)).resolves.toEqual(
      Buffer.from(content),
    );
    expect(await readdir(paths.root)).toEqual(['Meeting.docx']);
  });

  it('removes a partial temporary file and preserves the destination on failure', async () => {
    const paths = await makeDestination();
    await writeFile(paths.destinationPath, 'existing document');
    let temporaryPath = '';
    const operations: TranscriptExportOperations = {
      openExclusive: async (filePath, mode) => {
        temporaryPath = filePath;
        const file = await open(filePath, 'wx', mode);
        return {
          close: () => file.close(),
          sync: () => file.sync(),
          write: async () => {
            await file.writeFile('partial DOCX');
            throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
          },
        };
      },
      rename: async () => undefined,
      unlink: async (filePath) => {
        await rm(filePath, { force: true });
      },
    };

    await expect(
      writeTranscriptExport(paths.destinationPath, Buffer.alloc(1_024), operations),
    ).rejects.toMatchObject({ code: 'ENOSPC' });

    expect(path.dirname(temporaryPath)).toBe(paths.root);
    expect(path.basename(temporaryPath)).toMatch(
      /^\.Meeting\.docx\.[0-9a-f-]+\.sotto-export\.tmp$/u,
    );
    await expect(readFile(paths.destinationPath, 'utf8')).resolves.toBe(
      'existing document',
    );
    expect(await readdir(paths.root)).toEqual(['Meeting.docx']);
  });

  it('rejects a relative destination before opening a temporary file', async () => {
    await expect(
      writeTranscriptExport('Meeting.docx', 'transcript'),
    ).rejects.toThrow('Transcript export path must be absolute.');
  });
});
