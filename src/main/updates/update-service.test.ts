import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { createServer as createHttpsServer } from 'node:https';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  compareAppVersions,
  MAX_SQUIRREL_MAC_ARCHIVE_BYTES,
  UpdateService,
  updatePlatformKey,
} from './update-service';
import type { AppUpdateProgress } from '../../shared/contracts';
import type { MacUpdateInstaller } from './mac-update-installer';
import { signReleaseManifest } from './release-manifest.cjs';
import { createTrustedUpdateFetcher } from './update-tls';

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
    currentCommit?: string;
    installedAppPath?: string | null;
    macUpdateInstaller?: MacUpdateInstaller;
    onProgress?: (progress: AppUpdateProgress) => void;
  } = {},
): UpdateService =>
  new UpdateService({
    manifestUrl: MANIFEST_URL,
    trustedManifestKeys: testTrustedKeys,
    currentVersion,
    currentCommit: options.currentCommit,
    platformKey: 'darwin-arm64',
    downloadsDirectory: downloads,
    stagingDirectory: path.join(downloads, 'staging'),
    installedAppPath: options.installedAppPath ?? null,
    macUpdateInstaller: options.macUpdateInstaller,
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
  it('uses an embedded private CA for the manifest and native artifact stream', async () => {
    const directory = await downloadsDirectory();
    const certificate = path.join(directory, 'test-ca.crt');
    const privateKey = path.join(directory, 'test-ca.key');
    const opensslConfig = path.join(directory, 'openssl.cnf');
    await writeFile(
      opensslConfig,
      `[req]
distinguished_name=subject
x509_extensions=extensions
prompt=no
[subject]
CN=127.0.0.1
[extensions]
subjectAltName=IP:127.0.0.1
`,
    );
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', privateKey, '-out', certificate, '-days', '1',
      '-config', opensslConfig,
    ], { stdio: 'ignore' });
    const ca = await readFile(certificate);
    const artifact = Buffer.from('private-ca-update');
    const published: { manifest?: Record<string, unknown> } = {};
    const server = createHttpsServer(
      { cert: ca, key: await readFile(privateKey) },
      (request, response) => {
        if (request.url?.endsWith('/latest.json')) {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(published.manifest));
          return;
        }
        response.end(artifact);
      },
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No TLS port');
    const origin = `https://127.0.0.1:${address.port}`;
    published.manifest = signReleaseManifest(
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
            downloadUrl: `${origin}/internal/sotto/Sotto-arm64.dmg`,
            sha256: createHash('sha256').update(artifact).digest('hex'),
            size: artifact.byteLength,
          },
        },
      },
      'test-2026',
      testSigningKeys.privateKey,
    );
    const service = new UpdateService({
      manifestUrl: `${origin}/internal/sotto/latest.json`,
      trustedManifestKeys: testTrustedKeys,
      tlsCa: ca,
      currentVersion: '0.1.9',
      platformKey: 'darwin-arm64',
      downloadsDirectory: directory,
      stagingDirectory: path.join(directory, 'staging'),
      installedAppPath: null,
      fetcher: createTrustedUpdateFetcher(ca),
    });

    try {
      await expect(service.downloadUpdate()).resolves.toMatchObject({
        outcome: 'downloaded',
        version: '0.2.0',
      });
      await expect(
        readFile(path.join(directory, 'Sotto-0.2.0-arm64.dmg')),
      ).resolves.toEqual(artifact);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
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

  it('cancels an oversized manifest stream before buffering the full response', async () => {
    let cancelled = false;
    let pulls = 0;
    const chunk = new Uint8Array(40 * 1024);
    const fetcher = vi.fn(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      ),
    );
    const service = serviceWith(
      fetcher as typeof fetch,
      await downloadsDirectory(),
    );

    await expect(service.checkForUpdates()).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'The update manifest is too large.',
    });
    expect(pulls).toBeLessThanOrEqual(3);
    expect(cancelled).toBe(true);
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

  it('rejects a same-version manifest from a different source commit', async () => {
    const artifact = Buffer.from('replacement-build');
    const fetcher = vi.fn(async () =>
      Response.json(signedManifest(manifestFor('0.1.9', artifact))),
    );
    const service = serviceWith(
      fetcher as typeof fetch,
      await downloadsDirectory(),
      '0.1.9',
      { currentCommit: 'f'.repeat(40) },
    );

    await expect(service.checkForUpdates()).resolves.toEqual({
      outcome: 'unavailable',
      reason:
        'The published release reuses this version with a different source commit.',
    });
  });

  it('reports the Squirrel archive size for an updatable macOS app', async () => {
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
      {
        installedAppPath: '/Applications/Sotto.app',
        macUpdateInstaller: {
          prepareUpdate: async () => undefined,
          installUpdate: vi.fn(),
        },
      },
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

  it('falls back to the DMG when a Squirrel archive exceeds the safe size', async () => {
    const dmg = Buffer.from('safe-dmg-installer');
    const archive = Buffer.from('oversized-archive-placeholder');
    const manifest = manifestFor('0.2.0', dmg);
    manifest.artifacts['darwin-arm64-archive'] = {
      target: 'darwin-arm64-archive',
      file: 'Sotto-darwin-arm64.zip',
      downloadUrl: `${ORIGIN}/internal/sotto/Sotto-darwin-arm64.zip`,
      sha256: createHash('sha256').update(archive).digest('hex'),
      size: MAX_SQUIRREL_MAC_ARCHIVE_BYTES + 1,
    };
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('latest.json')
        ? Response.json(signedManifest(manifest))
        : new Response(dmg),
    );
    const root = await downloadsDirectory();
    const prepareUpdate = vi.fn(async () => undefined);
    const service = serviceWith(fetcher as typeof fetch, root, '0.1.9', {
      installedAppPath: '/Applications/Sotto.app',
      macUpdateInstaller: {
        prepareUpdate,
        installUpdate: vi.fn(),
      },
    });

    await expect(service.checkForUpdates()).resolves.toEqual({
      outcome: 'update-available',
      update: {
        version: '0.2.0',
        publishedAt: '2026-07-31T12:00:00.000Z',
        size: dmg.byteLength,
      },
    });
    await expect(service.downloadUpdate()).resolves.toMatchObject({
      outcome: 'downloaded',
      fileName: 'Sotto-0.2.0-arm64.dmg',
    });
    expect(prepareUpdate).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.map(([input]) => String(input))).not.toContain(
      `${ORIGIN}/internal/sotto/Sotto-darwin-arm64.zip`,
    );
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

  it('hands a verified archive to Squirrel.Mac and installs through the framework', async () => {
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
    const prepareUpdate = vi.fn(async () => undefined);
    const installUpdate = vi.fn();
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
      macUpdateInstaller: { prepareUpdate, installUpdate },
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
    expect(prepareUpdate).toHaveBeenCalledOnce();
    expect(prepareUpdate).toHaveBeenCalledWith({
      version: '0.2.0',
      publishedAt: '2026-07-31T12:00:00.000Z',
      archivePath: path.join(root, 'staging', 'stage-0.2.0', 'Sotto-0.2.0.zip'),
    });
    await expect(
      readFile(
        path.join(root, 'staging', 'stage-0.2.0', 'Sotto-0.2.0.zip'),
      ),
    ).resolves.toEqual(archive);
    expect(installUpdate).toHaveBeenCalledWith('0.2.0');
    // A second install without a staged update is refused.
    await expect(service.installUpdate()).resolves.toMatchObject({
      outcome: 'failed',
    });
  });

  it('surfaces framework code-signature rejection without staging an update', async () => {
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
      macUpdateInstaller: {
        prepareUpdate: async () => {
          throw new Error('code signature did not pass validation');
        },
        installUpdate: vi.fn(),
      },
    });

    await expect(service.downloadUpdate()).resolves.toEqual({
      outcome: 'failed',
      reason: 'code signature did not pass validation',
    });
    await expect(service.installUpdate()).resolves.toMatchObject({
      outcome: 'failed',
    });
  });

  it('stages a new framework update even when old custom-updater bundles remain', async () => {
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
      macUpdateInstaller: {
        prepareUpdate: async () => undefined,
        installUpdate: vi.fn(),
      },
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

  it('falls back to the DMG when the framework installer is unavailable', async () => {
    const archive = Buffer.from('zip-archive-bytes');
    const dmg = Buffer.from('dmg');
    const manifest = manifestFor('0.2.0', dmg);
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
        : new Response(
            String(input).endsWith('Sotto-arm64.dmg') ? dmg : archive,
          ),
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
    });

    await expect(service.downloadUpdate()).resolves.toMatchObject({
      outcome: 'downloaded',
      fileName: 'Sotto-0.2.0-arm64.dmg',
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
