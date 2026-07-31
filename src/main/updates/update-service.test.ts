import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  compareAppVersions,
  parseUpdateManifest,
  UpdateService,
  updatePlatformKey,
} from './update-service';

const MANIFEST_URL = 'http://10.1.2.3:8090/internal/sotto/latest.json';
const ORIGIN = 'http://10.1.2.3:8090';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const downloadsDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sotto-updates-'));
  temporaryDirectories.push(directory);
  return directory;
};

interface TestArtifact {
  file: string;
  downloadUrl: string;
  sha256: string;
  size: number;
}

const manifestFor = (version: string, artifact: Buffer) => ({
  schemaVersion: 1,
  app: 'sotto',
  version,
  publishedAt: '2026-07-31T12:00:00Z',
  artifacts: {
    'darwin-arm64': {
      file: 'Sotto-arm64.dmg',
      downloadUrl: `${ORIGIN}/internal/sotto/Sotto-arm64.dmg`,
      sha256: createHash('sha256').update(artifact).digest('hex'),
      size: artifact.byteLength,
    },
  } as Record<string, TestArtifact>,
});

const serviceWith = (
  fetcher: typeof fetch,
  downloads: string,
  currentVersion = '0.1.9',
): UpdateService =>
  new UpdateService({
    manifestUrl: MANIFEST_URL,
    currentVersion,
    platformKey: 'darwin-arm64',
    downloadsDirectory: downloads,
    stagingDirectory: path.join(downloads, 'staging'),
    installedAppPath: null,
    fetcher,
  });

describe('compareAppVersions', () => {
  it('orders numeric versions and rejects malformed input', () => {
    expect(compareAppVersions('0.1.9', '0.1.10')).toBe(-1);
    expect(compareAppVersions('0.2.0', '0.1.10')).toBe(1);
    expect(compareAppVersions('1.0.0', '1.0.0')).toBe(0);
    expect(() => compareAppVersions('0.1', '0.1.9')).toThrow(TypeError);
    expect(() => compareAppVersions('0.1.9-beta', '0.1.9')).toThrow(TypeError);
  });
});

describe('updatePlatformKey', () => {
  it('maps only the released platforms', () => {
    expect(updatePlatformKey('darwin', 'arm64')).toBe('darwin-arm64');
    expect(updatePlatformKey('win32', 'x64')).toBe('win32-x64');
    expect(updatePlatformKey('linux', 'x64')).toBeNull();
    expect(updatePlatformKey('darwin', 'x64')).toBeNull();
  });
});

describe('parseUpdateManifest', () => {
  it('rejects artifacts served from a different origin', () => {
    const manifest = manifestFor('0.2.0', Buffer.from('bytes'));
    manifest.artifacts['darwin-arm64'].downloadUrl =
      'http://attacker.example/Sotto-arm64.dmg';
    expect(() => parseUpdateManifest(manifest, ORIGIN)).toThrow(
      'The update artifact must come from the manifest origin.',
    );
  });

  it('rejects manifests for other apps or schemas', () => {
    expect(() =>
      parseUpdateManifest({ schemaVersion: 2, app: 'sotto' }, ORIGIN),
    ).toThrow('The update manifest is invalid.');
    expect(() =>
      parseUpdateManifest(
        { ...manifestFor('0.2.0', Buffer.from('x')), app: 'other' },
        ORIGIN,
      ),
    ).toThrow('The update manifest is invalid.');
  });
});

describe('UpdateService', () => {
  it('reports a newer published version as an available update', async () => {
    const artifact = Buffer.from('new-sotto-build');
    const fetcher = vi.fn(async () =>
      Response.json(manifestFor('0.2.0', artifact)),
    );
    const service = serviceWith(
      fetcher as typeof fetch,
      await downloadsDirectory(),
    );

    await expect(service.checkForUpdates()).resolves.toEqual({
      outcome: 'update-available',
      update: {
        version: '0.2.0',
        publishedAt: '2026-07-31T12:00:00.000Z',
        size: artifact.byteLength,
      },
    });
  });

  it('treats the current and older versions as up to date', async () => {
    const artifact = Buffer.from('same-build');
    const fetcher = vi.fn(async () =>
      Response.json(manifestFor('0.1.9', artifact)),
    );
    const service = serviceWith(
      fetcher as typeof fetch,
      await downloadsDirectory(),
    );

    await expect(service.checkForUpdates()).resolves.toEqual({
      outcome: 'up-to-date',
      version: '0.1.9',
    });
  });

  it('reports unreachable update servers without throwing', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const service = serviceWith(
      fetcher as typeof fetch,
      await downloadsDirectory(),
    );

    await expect(service.checkForUpdates()).resolves.toMatchObject({
      outcome: 'unavailable',
    });
  });

  it('downloads, verifies, and atomically renames the update artifact', async () => {
    const artifact = Buffer.from('sotto-0.2.0-dmg-bytes');
    const manifest = manifestFor('0.2.0', artifact);
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('latest.json')
        ? Response.json(manifest)
        : new Response(artifact),
    );
    const downloads = await downloadsDirectory();
    const service = serviceWith(fetcher as typeof fetch, downloads);

    const result = await service.downloadUpdate();
    expect(result).toMatchObject({
      outcome: 'downloaded',
      fileName: 'Sotto-0.2.0-arm64.dmg',
      version: '0.2.0',
    });
    const written = await readFile(
      path.join(downloads, 'Sotto-0.2.0-arm64.dmg'),
    );
    expect(written.equals(artifact)).toBe(true);
    await expect(readdir(downloads)).resolves.toEqual(['Sotto-0.2.0-arm64.dmg']);
  });

  it('discards downloads whose checksum does not match the manifest', async () => {
    const artifact = Buffer.from('published-bytes');
    const manifest = manifestFor('0.2.0', artifact);
    const tampered = Buffer.from('tampered-bytes!');
    manifest.artifacts['darwin-arm64'].size = tampered.byteLength;
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('latest.json')
        ? Response.json(manifest)
        : new Response(tampered),
    );
    const downloads = await downloadsDirectory();
    const service = serviceWith(fetcher as typeof fetch, downloads);

    await expect(service.downloadUpdate()).resolves.toEqual({
      outcome: 'failed',
      reason: 'The update download did not match its published checksum.',
    });
    await expect(readdir(downloads)).resolves.toEqual([]);
  });

  it('stops downloads that exceed their published size', async () => {
    const artifact = Buffer.from('small');
    const manifest = manifestFor('0.2.0', artifact);
    const oversized = Buffer.from('a-much-longer-body-than-published');
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('latest.json')
        ? Response.json(manifest)
        : new Response(oversized),
    );
    const downloads = await downloadsDirectory();
    const service = serviceWith(fetcher as typeof fetch, downloads);

    await expect(service.downloadUpdate()).resolves.toEqual({
      outcome: 'failed',
      reason: 'The update download exceeded its published size.',
    });
    await expect(readdir(downloads)).resolves.toEqual([]);
  });

  it('stages an in-place update and swaps the installed bundle on install', async () => {
    const archive = Buffer.from('zip-archive-bytes');
    const manifest = manifestFor('0.2.0', Buffer.from('dmg'));
    manifest.artifacts['darwin-arm64-archive'] = {
      file: 'Sotto-darwin-arm64.zip',
      downloadUrl: `${ORIGIN}/internal/sotto/Sotto-darwin-arm64.zip`,
      sha256: createHash('sha256').update(archive).digest('hex'),
      size: archive.byteLength,
    };
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('latest.json')
        ? Response.json(manifest)
        : new Response(archive),
    );
    const root = await downloadsDirectory();
    const installedAppPath = path.join(root, 'Applications', 'Sotto.app');
    await mkdir(path.join(installedAppPath, 'Contents'), { recursive: true });
    await writeFile(
      path.join(installedAppPath, 'Contents', 'marker'),
      'old-version',
    );
    const service = new UpdateService({
      manifestUrl: MANIFEST_URL,
      currentVersion: '0.1.9',
      platformKey: 'darwin-arm64',
      downloadsDirectory: path.join(root, 'downloads'),
      stagingDirectory: path.join(root, 'staging'),
      installedAppPath,
      fetcher: fetcher as typeof fetch,
      extractArchive: async (_archivePath, directory) => {
        const bundle = path.join(directory, 'Sotto.app', 'Contents');
        await mkdir(bundle, { recursive: true });
        await writeFile(path.join(bundle, 'marker'), 'new-version');
      },
    });

    await expect(service.downloadUpdate()).resolves.toEqual({
      outcome: 'staged',
      version: '0.2.0',
    });
    // Nothing lands in the Downloads folder for a staged update.
    await expect(readdir(path.join(root, 'downloads'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await expect(service.installUpdate()).resolves.toEqual({
      outcome: 'installed',
      version: '0.2.0',
    });
    await expect(
      readFile(path.join(installedAppPath, 'Contents', 'marker'), 'utf8'),
    ).resolves.toBe('new-version');
    await expect(
      readFile(
        path.join(root, 'staging', 'retired-0.1.9.app', 'Contents', 'marker'),
        'utf8',
      ),
    ).resolves.toBe('old-version');
    // A second install without a staged update is refused.
    await expect(service.installUpdate()).resolves.toMatchObject({
      outcome: 'failed',
    });
  });

  it('falls back to the Downloads folder when no bundle can be replaced', async () => {
    const artifact = Buffer.from('dmg-bytes');
    const manifest = manifestFor('0.2.0', artifact);
    manifest.artifacts['darwin-arm64-archive'] = {
      file: 'Sotto-darwin-arm64.zip',
      downloadUrl: `${ORIGIN}/internal/sotto/Sotto-darwin-arm64.zip`,
      sha256: createHash('sha256').update(Buffer.from('zip')).digest('hex'),
      size: 3,
    };
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('latest.json')
        ? Response.json(manifest)
        : new Response(artifact),
    );
    const downloads = await downloadsDirectory();
    const service = serviceWith(fetcher as typeof fetch, downloads);

    await expect(service.downloadUpdate()).resolves.toMatchObject({
      outcome: 'downloaded',
      fileName: 'Sotto-0.2.0-arm64.dmg',
    });
  });

  it('fails a staged update whose archive holds no app bundle', async () => {
    const archive = Buffer.from('zip-archive-bytes');
    const manifest = manifestFor('0.2.0', Buffer.from('dmg'));
    manifest.artifacts['darwin-arm64-archive'] = {
      file: 'Sotto-darwin-arm64.zip',
      downloadUrl: `${ORIGIN}/internal/sotto/Sotto-darwin-arm64.zip`,
      sha256: createHash('sha256').update(archive).digest('hex'),
      size: archive.byteLength,
    };
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('latest.json')
        ? Response.json(manifest)
        : new Response(archive),
    );
    const root = await downloadsDirectory();
    const service = new UpdateService({
      manifestUrl: MANIFEST_URL,
      currentVersion: '0.1.9',
      platformKey: 'darwin-arm64',
      downloadsDirectory: path.join(root, 'downloads'),
      stagingDirectory: path.join(root, 'staging'),
      installedAppPath: path.join(root, 'Sotto.app'),
      fetcher: fetcher as typeof fetch,
      extractArchive: async () => undefined,
    });

    await expect(service.downloadUpdate()).resolves.toEqual({
      outcome: 'failed',
      reason: 'The downloaded update did not contain the Sotto app.',
    });
  });

  it('refuses to download when already up to date', async () => {
    const artifact = Buffer.from('current');
    const fetcher = vi.fn(async () =>
      Response.json(manifestFor('0.1.9', artifact)),
    );
    const service = serviceWith(
      fetcher as typeof fetch,
      await downloadsDirectory(),
    );

    await expect(service.downloadUpdate()).resolves.toEqual({
      outcome: 'failed',
      reason: 'Sotto is already up to date.',
    });
  });
});
