import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  compareAppVersions,
  UpdateService,
  updatePlatformKey,
} from './update-service';
import type { AppUpdateProgress } from '../../shared/contracts';
import { signReleaseManifest } from './release-manifest.cjs';

const MANIFEST_URL = 'http://10.1.2.3:8090/internal/sotto/latest.json';
const ORIGIN = 'http://10.1.2.3:8090';
const SECURE_MANIFEST_URL =
  'https://updates.example.test/internal/sotto/latest.json';
const SECURE_ORIGIN = 'https://updates.example.test';
const testSigningKeys = generateKeyPairSync('ed25519');
const testTrustedKeys = {
  'test-2026': testSigningKeys.publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString(),
};

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
  target: string;
  file: string;
  downloadUrl: string;
  sha256: string;
  size: number;
}

const manifestFor = (version: string, artifact: Buffer) => ({
  schemaVersion: 2,
  app: 'sotto',
  channel: 'internal',
  releaseKind: 'internal-ad-hoc',
  version,
  bundleId: 'com.sotto.desktop',
  commit: '0123456789abcdef0123456789abcdef01234567',
  buildNumber: 42,
  publishedAt: '2026-07-31T12:00:00.000Z',
  artifacts: {
    'darwin-arm64': {
      target: 'darwin-arm64',
      file: 'Sotto-arm64.dmg',
      downloadUrl: `${ORIGIN}/internal/sotto/Sotto-arm64.dmg`,
      sha256: createHash('sha256').update(artifact).digest('hex'),
      size: artifact.byteLength,
    },
  } as Record<string, TestArtifact>,
});

const signedManifest = (manifest: ReturnType<typeof manifestFor>) =>
  signReleaseManifest(manifest, 'test-2026', testSigningKeys.privateKey);

const serviceWith = (
  fetcher: typeof fetch,
  downloads: string,
  currentVersion = '0.1.9',
  options: {
    installedAppPath?: string | null;
    onProgress?: (progress: AppUpdateProgress) => void;
  } = {},
): UpdateService =>
  new UpdateService({
    manifestUrl: MANIFEST_URL,
    trustedManifestKeys: testTrustedKeys,
    currentVersion,
    platformKey: 'darwin-arm64',
    downloadsDirectory: downloads,
    stagingDirectory: path.join(downloads, 'staging'),
    installedAppPath: options.installedAppPath ?? null,
    fetcher,
    allowInsecureUpdateUrlsForTests: true,
    onProgress: options.onProgress,
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

describe('UpdateService', () => {
  it('accepts an authenticated release manifest before offering an update', async () => {
    const artifact = Buffer.from('authenticated-build');
    const signed = signReleaseManifest(
      {
        schemaVersion: 2,
        app: 'sotto',
        channel: 'internal',
        releaseKind: 'internal-ad-hoc',
        version: '0.2.0',
        bundleId: 'com.sotto.desktop',
        commit: '0123456789abcdef0123456789abcdef01234567',
        buildNumber: 42,
        publishedAt: '2026-08-03T12:00:00.000Z',
        artifacts: {
          'darwin-arm64': {
            target: 'darwin-arm64',
            file: 'Sotto-arm64.dmg',
            downloadUrl: `${SECURE_ORIGIN}/internal/sotto/Sotto-arm64.dmg`,
            sha256: createHash('sha256').update(artifact).digest('hex'),
            size: artifact.byteLength,
          },
        },
      },
      'test-2026',
      testSigningKeys.privateKey,
    );
    const fetcher = vi.fn(async () => Response.json(signed));
    const downloads = await downloadsDirectory();
    const service = new UpdateService({
      manifestUrl: SECURE_MANIFEST_URL,
      trustedManifestKeys: testTrustedKeys,
      currentVersion: '0.1.9',
      platformKey: 'darwin-arm64',
      downloadsDirectory: downloads,
      stagingDirectory: path.join(downloads, 'staging'),
      installedAppPath: null,
      fetcher: fetcher as typeof fetch,
    });

    await expect(service.checkForUpdates()).resolves.toMatchObject({
      outcome: 'update-available',
      update: { version: '0.2.0' },
    });
  });

  it('does not fetch an artifact when authenticated metadata was tampered', async () => {
    const artifact = Buffer.from('authenticated-build');
    const signed = signReleaseManifest(
      {
        schemaVersion: 2,
        app: 'sotto',
        channel: 'internal',
        releaseKind: 'internal-ad-hoc',
        version: '0.2.0',
        bundleId: 'com.sotto.desktop',
        commit: '0123456789abcdef0123456789abcdef01234567',
        buildNumber: 42,
        publishedAt: '2026-08-03T12:00:00.000Z',
        artifacts: {
          'darwin-arm64': {
            target: 'darwin-arm64',
            file: 'Sotto-arm64.dmg',
            downloadUrl: `${SECURE_ORIGIN}/internal/sotto/Sotto-arm64.dmg`,
            sha256: createHash('sha256').update(artifact).digest('hex'),
            size: artifact.byteLength,
          },
        },
      },
      'test-2026',
      testSigningKeys.privateKey,
    );
    signed.version = '0.2.1';
    const fetcher = vi.fn(async () => Response.json(signed));
    const downloads = await downloadsDirectory();
    const service = new UpdateService({
      manifestUrl: SECURE_MANIFEST_URL,
      trustedManifestKeys: testTrustedKeys,
      currentVersion: '0.1.9',
      platformKey: 'darwin-arm64',
      downloadsDirectory: downloads,
      stagingDirectory: path.join(downloads, 'staging'),
      installedAppPath: null,
      fetcher: fetcher as typeof fetch,
    });

    await expect(service.downloadUpdate()).resolves.toEqual({
      outcome: 'failed',
      reason: 'The update manifest signature is invalid.',
    });
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(readdir(downloads)).resolves.toEqual([]);
  });

  it('reports absent secure update configuration without making a request', async () => {
    const fetcher = vi.fn(async () => Response.json({}));
    const downloads = await downloadsDirectory();
    const service = new UpdateService({
      manifestUrl: null,
      trustedManifestKeys: {},
      currentVersion: '0.1.9',
      platformKey: 'darwin-arm64',
      downloadsDirectory: downloads,
      stagingDirectory: path.join(downloads, 'staging'),
      installedAppPath: null,
      fetcher: fetcher as typeof fetch,
    });

    await expect(service.checkForUpdates()).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'Secure updates are not configured for this Sotto build.',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects an insecure manifest URL before making a request', async () => {
    const fetcher = vi.fn(async () => Response.json({}));
    const downloads = await downloadsDirectory();
    const service = new UpdateService({
      manifestUrl: MANIFEST_URL,
      trustedManifestKeys: testTrustedKeys,
      currentVersion: '0.1.9',
      platformKey: 'darwin-arm64',
      downloadsDirectory: downloads,
      stagingDirectory: path.join(downloads, 'staging'),
      installedAppPath: null,
      fetcher: fetcher as typeof fetch,
    });

    await expect(service.checkForUpdates()).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'The update manifest URL must use HTTPS.',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a credential-bearing manifest URL before making a request', async () => {
    const fetcher = vi.fn(async () => Response.json({}));
    const downloads = await downloadsDirectory();
    const service = new UpdateService({
      manifestUrl:
        'https://release:secret@updates.example.test/internal/sotto/latest.json',
      trustedManifestKeys: testTrustedKeys,
      currentVersion: '0.1.9',
      platformKey: 'darwin-arm64',
      downloadsDirectory: downloads,
      stagingDirectory: path.join(downloads, 'staging'),
      installedAppPath: null,
      fetcher: fetcher as typeof fetch,
    });

    await expect(service.checkForUpdates()).resolves.toEqual({
      outcome: 'unavailable',
      reason:
        'The update manifest URL must not contain credentials, a query, or a fragment.',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports a newer published version as an available update', async () => {
    const artifact = Buffer.from('new-sotto-build');
    const fetcher = vi.fn(async () =>
      Response.json(signedManifest(manifestFor('0.2.0', artifact))),
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

  it('reports the in-place archive size for a replaceable macOS app', async () => {
    const installer = Buffer.from('dmg-installer');
    const archive = Buffer.from('zip-archive');
    const manifest = manifestFor('0.2.0', installer);
    manifest.artifacts['darwin-arm64-archive'] = {
      target: 'darwin-arm64-archive',
      file: 'Sotto-darwin-arm64.zip',
      downloadUrl: `${ORIGIN}/internal/sotto/Sotto-darwin-arm64.zip`,
      sha256: createHash('sha256').update(archive).digest('hex'),
      size: archive.byteLength,
    };
    const fetcher = vi.fn(async () => Response.json(signedManifest(manifest)));
    const service = serviceWith(
      fetcher as typeof fetch,
      await downloadsDirectory(),
      '0.1.9',
      { installedAppPath: '/Applications/Sotto.app' },
    );

    await expect(service.checkForUpdates()).resolves.toEqual({
      outcome: 'update-available',
      update: {
        version: '0.2.0',
        publishedAt: '2026-07-31T12:00:00.000Z',
        size: archive.byteLength,
      },
    });
  });

  it('treats the current and older versions as up to date', async () => {
    const artifact = Buffer.from('same-build');
    const fetcher = vi.fn(async () =>
      Response.json(signedManifest(manifestFor('0.1.9', artifact))),
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
        ? Response.json(signedManifest(manifest))
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

  it('reports download progress', async () => {
    const artifact = Buffer.from('progress-artifact');
    const progress: AppUpdateProgress[] = [];
    const manifest = manifestFor('0.2.0', artifact);
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('latest.json')
        ? Response.json(signedManifest(manifest))
        : new Response(artifact),
    );
    const service = serviceWith(
      fetcher as typeof fetch,
      await downloadsDirectory(),
      '0.1.9',
      { onProgress: (event) => progress.push(event) },
    );

    await expect(service.downloadUpdate()).resolves.toMatchObject({
      outcome: 'downloaded',
      version: '0.2.0',
    });
    expect(progress[0]).toMatchObject({
      phase: 'downloading',
      receivedBytes: 0,
      totalBytes: artifact.byteLength,
    });
    expect(progress.at(-1)).toMatchObject({
      phase: 'downloading',
      receivedBytes: artifact.byteLength,
      totalBytes: artifact.byteLength,
    });
  });

  it('cancels an active download without leaving a partial artifact', async () => {
    const artifact = Buffer.from('cancel-me');
    const manifest = manifestFor('0.2.0', artifact);
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('latest.json')) {
          return Response.json(signedManifest(manifest));
        }
        if (init?.signal?.aborted) {
          throw new TypeError('The update download was canceled.');
        }
        await new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new TypeError('The update download was canceled.')),
            { once: true },
          );
        });
      },
    );
    const downloads = await downloadsDirectory();
    const service = serviceWith(
      fetcher as typeof fetch,
      downloads,
      '0.1.9',
      {
        onProgress: (event) => {
          if (event.phase === 'downloading' && event.receivedBytes === 0) {
            service.cancelDownload();
          }
        },
      },
    );

    await expect(service.downloadUpdate()).resolves.toEqual({
      outcome: 'cancelled',
      version: '0.2.0',
    });
    await expect(readdir(downloads)).resolves.toEqual([]);
  });

  it('discards downloads whose checksum does not match the manifest', async () => {
    const artifact = Buffer.from('published-bytes');
    const manifest = manifestFor('0.2.0', artifact);
    const tampered = Buffer.from('tampered-bytes!');
    manifest.artifacts['darwin-arm64'].size = tampered.byteLength;
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('latest.json')
        ? Response.json(signedManifest(manifest))
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
        ? Response.json(signedManifest(manifest))
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
    const progress: AppUpdateProgress[] = [];
    const manifest = manifestFor('0.2.0', Buffer.from('dmg'));
    manifest.artifacts['darwin-arm64-archive'] = {
      target: 'darwin-arm64-archive',
      file: 'Sotto-darwin-arm64.zip',
      downloadUrl: `${ORIGIN}/internal/sotto/Sotto-darwin-arm64.zip`,
      sha256: createHash('sha256').update(archive).digest('hex'),
      size: archive.byteLength,
    };
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('latest.json')
        ? Response.json(signedManifest(manifest))
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
      trustedManifestKeys: testTrustedKeys,
      currentVersion: '0.1.9',
      platformKey: 'darwin-arm64',
      downloadsDirectory: path.join(root, 'downloads'),
      stagingDirectory: path.join(root, 'staging'),
      installedAppPath,
      fetcher: fetcher as typeof fetch,
      allowInsecureUpdateUrlsForTests: true,
      onProgress: (event) => progress.push(event),
      extractArchive: async (_archivePath, directory) => {
        const bundle = path.join(directory, 'Sotto.app', 'Contents');
        await mkdir(bundle, { recursive: true });
        await writeFile(path.join(bundle, 'marker'), 'new-version');
      },
      readMacAppBundleMetadata: async () => ({
        bundleId: 'com.sotto.desktop',
        version: '0.2.0',
      }),
    });

    await expect(service.downloadUpdate()).resolves.toEqual({
      outcome: 'staged',
      version: '0.2.0',
    });
    expect(progress.at(-1)).toEqual({
      phase: 'preparing',
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

  it('revalidates staged bundle metadata immediately before replacement', async () => {
    const archive = Buffer.from('zip-archive-bytes');
    const manifest = manifestFor('0.2.0', Buffer.from('dmg'));
    manifest.artifacts['darwin-arm64-archive'] = {
      target: 'darwin-arm64-archive',
      file: 'Sotto-darwin-arm64.zip',
      downloadUrl: `${ORIGIN}/internal/sotto/Sotto-darwin-arm64.zip`,
      sha256: createHash('sha256').update(archive).digest('hex'),
      size: archive.byteLength,
    };
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('latest.json')
        ? Response.json(signedManifest(manifest))
        : new Response(archive),
    );
    const root = await downloadsDirectory();
    const installedAppPath = path.join(root, 'Applications', 'Sotto.app');
    await mkdir(path.join(installedAppPath, 'Contents'), { recursive: true });
    await writeFile(
      path.join(installedAppPath, 'Contents', 'marker'),
      'old-version',
    );
    let metadata = { bundleId: 'com.sotto.desktop', version: '0.2.0' };
    const service = new UpdateService({
      manifestUrl: MANIFEST_URL,
      trustedManifestKeys: testTrustedKeys,
      currentVersion: '0.1.9',
      platformKey: 'darwin-arm64',
      downloadsDirectory: path.join(root, 'downloads'),
      stagingDirectory: path.join(root, 'staging'),
      installedAppPath,
      fetcher: fetcher as typeof fetch,
      allowInsecureUpdateUrlsForTests: true,
      extractArchive: async (_archivePath, directory) => {
        await mkdir(path.join(directory, 'Sotto.app'), { recursive: true });
      },
      readMacAppBundleMetadata: async () => metadata,
    });

    await expect(service.downloadUpdate()).resolves.toEqual({
      outcome: 'staged',
      version: '0.2.0',
    });
    metadata = { bundleId: 'com.sotto.desktop', version: '9.9.9' };

    await expect(service.installUpdate()).resolves.toEqual({
      outcome: 'failed',
      reason: 'The downloaded app version does not match the offered version.',
    });
    await expect(
      readFile(path.join(installedAppPath, 'Contents', 'marker'), 'utf8'),
    ).resolves.toBe('old-version');
  });

  it('stages a new update even when old rollback bundles remain', async () => {
    const archive = Buffer.from('zip-archive-bytes');
    const manifest = manifestFor('0.2.0', Buffer.from('dmg'));
    manifest.artifacts['darwin-arm64-archive'] = {
      target: 'darwin-arm64-archive',
      file: 'Sotto-darwin-arm64.zip',
      downloadUrl: `${ORIGIN}/internal/sotto/Sotto-darwin-arm64.zip`,
      sha256: createHash('sha256').update(archive).digest('hex'),
      size: archive.byteLength,
    };
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('latest.json')
        ? Response.json(signedManifest(manifest))
        : new Response(archive),
    );
    const root = await downloadsDirectory();
    const staging = path.join(root, 'staging');
    const leftover = path.join(staging, 'retired-0.1.8.app', 'Contents');
    await mkdir(leftover, { recursive: true });
    await writeFile(path.join(leftover, 'marker'), 'old-rollback');
    const installedAppPath = path.join(root, 'Sotto.app');
    await mkdir(installedAppPath, { recursive: true });
    const service = new UpdateService({
      manifestUrl: MANIFEST_URL,
      trustedManifestKeys: testTrustedKeys,
      currentVersion: '0.1.9',
      platformKey: 'darwin-arm64',
      downloadsDirectory: path.join(root, 'downloads'),
      stagingDirectory: staging,
      installedAppPath,
      fetcher: fetcher as typeof fetch,
      allowInsecureUpdateUrlsForTests: true,
      extractArchive: async (_archivePath, directory) => {
        await mkdir(path.join(directory, 'Sotto.app'), { recursive: true });
      },
      readMacAppBundleMetadata: async () => ({
        bundleId: 'com.sotto.desktop',
        version: '0.2.0',
      }),
    });

    await expect(service.downloadUpdate()).resolves.toEqual({
      outcome: 'staged',
      version: '0.2.0',
    });
    // The old rollback bundle was not required to disappear first.
    await expect(
      readFile(path.join(leftover, 'marker'), 'utf8'),
    ).resolves.toBe('old-rollback');

    await service.cleanupStaleUpdateArtifacts();
    await expect(readFile(path.join(leftover, 'marker'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    // The sweep removes finished-update leftovers but must never touch the
    // actively staged pending update.
    await expect(readdir(staging)).resolves.toEqual(['stage-0.2.0']);
  });

  it('falls back to the Downloads folder when no bundle can be replaced', async () => {
    const artifact = Buffer.from('dmg-bytes');
    const manifest = manifestFor('0.2.0', artifact);
    manifest.artifacts['darwin-arm64-archive'] = {
      target: 'darwin-arm64-archive',
      file: 'Sotto-darwin-arm64.zip',
      downloadUrl: `${ORIGIN}/internal/sotto/Sotto-darwin-arm64.zip`,
      sha256: createHash('sha256').update(Buffer.from('zip')).digest('hex'),
      size: 3,
    };
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('latest.json')
        ? Response.json(signedManifest(manifest))
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
      target: 'darwin-arm64-archive',
      file: 'Sotto-darwin-arm64.zip',
      downloadUrl: `${ORIGIN}/internal/sotto/Sotto-darwin-arm64.zip`,
      sha256: createHash('sha256').update(archive).digest('hex'),
      size: archive.byteLength,
    };
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('latest.json')
        ? Response.json(signedManifest(manifest))
        : new Response(archive),
    );
    const root = await downloadsDirectory();
    const service = new UpdateService({
      manifestUrl: MANIFEST_URL,
      trustedManifestKeys: testTrustedKeys,
      currentVersion: '0.1.9',
      platformKey: 'darwin-arm64',
      downloadsDirectory: path.join(root, 'downloads'),
      stagingDirectory: path.join(root, 'staging'),
      installedAppPath: path.join(root, 'Sotto.app'),
      fetcher: fetcher as typeof fetch,
      allowInsecureUpdateUrlsForTests: true,
      extractArchive: async () => undefined,
    });

    await expect(service.downloadUpdate()).resolves.toEqual({
      outcome: 'failed',
      reason: 'The downloaded update must contain exactly Sotto.app.',
    });
  });

  it.each([
    [
      { bundleId: 'com.attacker.fake', version: '0.2.0' },
      'The downloaded update has an unexpected bundle identifier.',
    ],
    [
      { bundleId: 'com.sotto.desktop', version: '9.9.9' },
      'The downloaded app version does not match the offered version.',
    ],
  ])('rejects mismatched bundle metadata before staging', async (metadata, reason) => {
    const archive = Buffer.from('zip-archive-bytes');
    const manifest = manifestFor('0.2.0', Buffer.from('dmg'));
    manifest.artifacts['darwin-arm64-archive'] = {
      target: 'darwin-arm64-archive',
      file: 'Sotto-darwin-arm64.zip',
      downloadUrl: `${ORIGIN}/internal/sotto/Sotto-darwin-arm64.zip`,
      sha256: createHash('sha256').update(archive).digest('hex'),
      size: archive.byteLength,
    };
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('latest.json')
        ? Response.json(signedManifest(manifest))
        : new Response(archive),
    );
    const root = await downloadsDirectory();
    const service = new UpdateService({
      manifestUrl: MANIFEST_URL,
      trustedManifestKeys: testTrustedKeys,
      currentVersion: '0.1.9',
      platformKey: 'darwin-arm64',
      downloadsDirectory: path.join(root, 'downloads'),
      stagingDirectory: path.join(root, 'staging'),
      installedAppPath: path.join(root, 'Sotto.app'),
      fetcher: fetcher as typeof fetch,
      allowInsecureUpdateUrlsForTests: true,
      extractArchive: async (_archivePath, directory) => {
        await mkdir(path.join(directory, 'Sotto.app'), { recursive: true });
      },
      readMacAppBundleMetadata: async () => metadata,
    });

    await expect(service.downloadUpdate()).resolves.toEqual({
      outcome: 'failed',
      reason,
    });
    await expect(service.installUpdate()).resolves.toEqual({
      outcome: 'failed',
      reason: 'No downloaded update is ready to install.',
    });
  });

  it('refuses to download when already up to date', async () => {
    const artifact = Buffer.from('current');
    const fetcher = vi.fn(async () =>
      Response.json(signedManifest(manifestFor('0.1.9', artifact))),
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
