import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ManagedModelProvisioner,
  provisionManagedDefaultModel,
  pruneManagedModelRevisions,
  validateModelUrl,
} from './managed-model';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe('managed default transcription model', () => {
  const identityFor = (bytes: Buffer, revision = 'a'.repeat(40)) => ({
    fileName: 'model.bin',
    revision,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  });

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

  it('downloads to a private temporary file and atomically activates a verified model', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-managed-model-'));
    temporaryDirectories.push(root);
    const bytes = Buffer.from('downloaded-model');
    const statuses: string[] = [];
    const provisioner = new ManagedModelProvisioner({
      managedModelsDirectory: path.join(root, 'managed', 'revision'),
      modelUrl: 'https://updates.example.test/models/model.bin',
      identity: identityFor(bytes),
      fetcher: vi.fn(async () =>
        new Response(bytes, {
          headers: { 'content-length': String(bytes.length) },
        }),
      ),
      onStatus: (status) => statuses.push(status.state),
    });

    const destination = await provisioner.provision();

    await expect(readFile(destination)).resolves.toEqual(bytes);
    await expect(readdir(path.dirname(destination))).resolves.toEqual(['model.bin']);
    expect(statuses).toEqual(['checking', 'downloading', 'downloading', 'verifying', 'ready']);
  });

  it('coalesces concurrent provisioning and never overwrites a verified cache', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-managed-model-'));
    temporaryDirectories.push(root);
    const bytes = Buffer.from('same-model');
    let calls = 0;
    const provisioner = new ManagedModelProvisioner({
      managedModelsDirectory: path.join(root, 'managed'),
      modelUrl: 'https://updates.example.test/models/model.bin',
      identity: identityFor(bytes),
      fetcher: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response(bytes);
      },
    });

    const [first, second] = await Promise.all([
      provisioner.provision(),
      provisioner.provision(),
    ]);

    expect(first).toBe(second);
    expect(calls).toBe(1);
    await expect(readFile(first)).resolves.toEqual(bytes);
  });

  it('rejects checksum or size mismatch and leaves no partial model', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-managed-model-'));
    temporaryDirectories.push(root);
    const destinationDirectory = path.join(root, 'managed');
    const provisioner = new ManagedModelProvisioner({
      managedModelsDirectory: destinationDirectory,
      modelUrl: 'https://updates.example.test/models/model.bin',
      identity: {
        fileName: 'model.bin',
        sha256: 'a'.repeat(64),
        size: 3,
      },
      fetcher: async () => new Response(Buffer.from('wrong')),
    });

    await expect(provisioner.provision()).rejects.toThrow(/pinned maximum size/u);
    await expect(access(path.join(destinationDirectory, 'model.bin'))).rejects.toThrow();
    await expect(readdir(destinationDirectory)).resolves.toEqual([]);
  });

  it('quarantines a corrupt cache before activating the verified replacement', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-managed-model-'));
    temporaryDirectories.push(root);
    const bytes = Buffer.from('replacement-model');
    const destinationDirectory = path.join(root, 'managed');
    await mkdir(destinationDirectory, { recursive: true });
    await writeFile(path.join(destinationDirectory, 'model.bin'), 'corrupt-cache');
    const provisioner = new ManagedModelProvisioner({
      managedModelsDirectory: destinationDirectory,
      modelUrl: 'https://updates.example.test/models/model.bin',
      identity: identityFor(bytes),
      fetcher: async () => new Response(bytes),
    });

    const destination = await provisioner.provision();

    await expect(readFile(destination)).resolves.toEqual(bytes);
    await expect(readdir(destinationDirectory)).resolves.toEqual(
      expect.arrayContaining([
        'model.bin',
        expect.stringMatching(/^model\.bin\.corrupt-/u),
      ]),
    );
  });

  it('imports a matching local file and safely retries after a cancelled download', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-managed-model-'));
    temporaryDirectories.push(root);
    const bytes = Buffer.from('offline-model');
    const source = path.join(root, 'source.bin');
    await writeFile(source, bytes);
    const fetcher = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const provisioner = new ManagedModelProvisioner({
      managedModelsDirectory: path.join(root, 'managed'),
      modelUrl: 'https://updates.example.test/models/model.bin',
      identity: identityFor(bytes),
      fetcher,
    });
    const pending = provisioner.provision();
    await new Promise((resolve) => setTimeout(resolve, 0));
    provisioner.cancel();
    await expect(pending).rejects.toThrow(/aborted|cancelled/u);
    await expect(provisioner.importFromPath(source)).resolves.toMatch(/model\.bin$/u);
    await expect(readFile(path.join(root, 'managed', 'model.bin'))).resolves.toEqual(bytes);
  });

  it('validates HTTPS model URLs and keeps revision cleanup path-safe', async () => {
    expect(validateModelUrl('https://updates.example.test/model.bin')).toBe(
      'https://updates.example.test/model.bin',
    );
    expect(() => validateModelUrl('http://updates.example.test/model.bin')).toThrow(/HTTPS/u);
    expect(() => validateModelUrl('https://updates.example.test/model.bin?x=1')).toThrow(/query/u);

    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-managed-model-'));
    temporaryDirectories.push(root);
    const current = 'a'.repeat(40);
    const previous = 'b'.repeat(40);
    const obsolete = 'c'.repeat(40);
    await Promise.all([
      mkdir(path.join(root, current), { recursive: true }),
      mkdir(path.join(root, previous), { recursive: true }),
      mkdir(path.join(root, obsolete), { recursive: true }),
    ]);
    await writeFile(path.join(root, obsolete, 'model.bin'), 'old');
    await pruneManagedModelRevisions({
      managedModelsRoot: root,
      currentRevision: current,
      retainRevisions: 1,
    });
    await expect(access(path.join(root, obsolete))).rejects.toThrow();
    await expect(access(path.join(root, previous))).rejects.toThrow();
  });

  it('retains a protected obsolete revision even when it is outside the retention window', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-managed-model-'));
    temporaryDirectories.push(root);
    const current = 'a'.repeat(40);
    const previous = 'b'.repeat(40);
    const protectedRevision = 'c'.repeat(40);
    await Promise.all([
      mkdir(path.join(root, current), { recursive: true }),
      mkdir(path.join(root, previous), { recursive: true }),
      mkdir(path.join(root, protectedRevision), { recursive: true }),
    ]);

    await pruneManagedModelRevisions({
      managedModelsRoot: root,
      currentRevision: current,
      retainRevisions: 1,
      activeModelPaths: [path.join(root, protectedRevision, 'model.bin')],
    });

    await expect(access(path.join(root, previous))).rejects.toThrow();
    await expect(access(path.join(root, protectedRevision))).resolves.toBeUndefined();
  });
});
