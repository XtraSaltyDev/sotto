import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createSourceProvenance } from './source-provenance.cjs';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe('source provenance', () => {
  it('distinguishes a clean commit from modified and untracked source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-provenance-'));
    temporaryDirectories.push(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Sotto Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'sotto@example.test'], { cwd: root });
    await writeFile(path.join(root, 'tracked.txt'), 'one');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'test'], { cwd: root });

    const clean = createSourceProvenance(root);
    expect(clean.sourceState).toBe('clean');
    expect(clean.sourceDigest).toMatch(/^[0-9a-f]{64}$/u);

    await writeFile(path.join(root, 'tracked.txt'), 'two');
    await writeFile(path.join(root, 'untracked.txt'), 'three');
    const dirty = createSourceProvenance(root);
    expect(dirty).toMatchObject({ commit: clean.commit, sourceState: 'dirty' });
    expect(dirty.sourceDigest).not.toBe(clean.sourceDigest);
  });
});
