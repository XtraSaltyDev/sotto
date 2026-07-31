import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
  AvailableAppUpdate,
  CheckForAppUpdateResult,
  DownloadAppUpdateResult,
  InstallAppUpdateResult,
} from '../../shared/contracts';

export const DEFAULT_SOTTO_UPDATE_MANIFEST_URL =
  'http://10.1.2.3:8090/internal/sotto/latest.json';

const MANIFEST_TIMEOUT_MS = 8_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;

export type UpdatePlatformKey = 'darwin-arm64' | 'win32-x64';

/**
 * 'darwin-arm64' and 'win32-x64' are user-facing installers saved to the
 * Downloads folder. 'darwin-arm64-archive' is the ZIP build the in-place
 * installer stages and swaps; clients that predate it ignore the key.
 */
type ManifestArtifactKey = UpdatePlatformKey | 'darwin-arm64-archive';

const MANIFEST_ARTIFACT_KEYS: readonly ManifestArtifactKey[] = [
  'darwin-arm64',
  'win32-x64',
  'darwin-arm64-archive',
];

interface ManifestArtifact {
  downloadUrl: string;
  sha256: string;
  size: number;
}

interface ParsedUpdateManifest {
  version: string;
  publishedAt: string | null;
  artifacts: Partial<Record<ManifestArtifactKey, ManifestArtifact>>;
}

export interface UpdateServiceOptions {
  manifestUrl: string;
  currentVersion: string;
  platformKey: UpdatePlatformKey | null;
  downloadsDirectory: string;
  /** Private scratch directory for staged in-place updates. */
  stagingDirectory: string;
  /** The installed .app bundle to replace, or null when not replaceable. */
  installedAppPath: string | null;
  fetcher?: typeof fetch;
  extractArchive?: (archivePath: string, directory: string) => Promise<void>;
}

const execFileAsync = promisify(execFile);

const dittoExtract = async (
  archivePath: string,
  directory: string,
): Promise<void> => {
  // ditto preserves the bundle's extended attributes and symlinks, which
  // unzip implementations frequently mangle for .app bundles.
  await execFileAsync('/usr/bin/ditto', ['-xk', archivePath, directory]);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const compareAppVersions = (left: string, right: string): number => {
  if (!VERSION_PATTERN.test(left) || !VERSION_PATTERN.test(right)) {
    throw new TypeError('App versions must use the numeric x.y.z form.');
  }
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
};

export const updatePlatformKey = (
  platform: string,
  architecture: string,
): UpdatePlatformKey | null => {
  if (platform === 'darwin' && architecture === 'arm64') return 'darwin-arm64';
  if (platform === 'win32' && architecture === 'x64') return 'win32-x64';
  return null;
};

const parseArtifact = (
  value: unknown,
  manifestOrigin: string,
): ManifestArtifact => {
  if (!isRecord(value)) {
    throw new TypeError('The update manifest artifact is invalid.');
  }
  const { downloadUrl, sha256, size } = value;
  if (typeof downloadUrl !== 'string') {
    throw new TypeError('The update manifest download URL is invalid.');
  }
  const parsedUrl = new URL(downloadUrl);
  if (parsedUrl.origin !== manifestOrigin) {
    throw new TypeError(
      'The update artifact must come from the manifest origin.',
    );
  }
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    throw new TypeError('The update manifest digest is invalid.');
  }
  if (
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > MAX_ARTIFACT_BYTES
  ) {
    throw new TypeError('The update manifest artifact size is invalid.');
  }
  return { downloadUrl, sha256, size };
};

export const parseUpdateManifest = (
  value: unknown,
  manifestOrigin: string,
): ParsedUpdateManifest => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.app !== 'sotto' ||
    typeof value.version !== 'string' ||
    !VERSION_PATTERN.test(value.version) ||
    !isRecord(value.artifacts)
  ) {
    throw new TypeError('The update manifest is invalid.');
  }
  const artifacts: ParsedUpdateManifest['artifacts'] = {};
  for (const key of MANIFEST_ARTIFACT_KEYS) {
    if (value.artifacts[key] !== undefined) {
      artifacts[key] = parseArtifact(value.artifacts[key], manifestOrigin);
    }
  }
  const publishedAt =
    typeof value.publishedAt === 'string' &&
    Number.isFinite(new Date(value.publishedAt).getTime())
      ? new Date(value.publishedAt).toISOString()
      : null;
  return { version: value.version, publishedAt, artifacts };
};

const artifactFileName = (
  version: string,
  platformKey: UpdatePlatformKey,
): string =>
  platformKey === 'darwin-arm64'
    ? `Sotto-${version}-arm64.dmg`
    : `Sotto-win32-x64-${version}.zip`;

const findAppBundle = async (directory: string): Promise<string | null> => {
  const entries = await readdir(directory);
  const bundleName = entries.find((entry) => entry.endsWith('.app'));
  if (!bundleName) return null;
  const bundlePath = path.join(directory, bundleName);
  const bundleStat = await stat(bundlePath);
  return bundleStat.isDirectory() ? bundlePath : null;
};

export class UpdateService {
  private readonly fetcher: typeof fetch;

  private readonly extractArchive: (
    archivePath: string,
    directory: string,
  ) => Promise<void>;

  private stagedUpdate: { version: string; appPath: string } | null = null;

  constructor(private readonly options: UpdateServiceOptions) {
    new URL(options.manifestUrl);
    this.fetcher = options.fetcher ?? fetch;
    this.extractArchive = options.extractArchive ?? dittoExtract;
  }

  async checkForUpdates(): Promise<CheckForAppUpdateResult> {
    try {
      const manifest = await this.fetchManifest();
      if (
        compareAppVersions(manifest.version, this.options.currentVersion) <= 0
      ) {
        return { outcome: 'up-to-date', version: this.options.currentVersion };
      }
      const artifact = this.options.platformKey
        ? manifest.artifacts[this.options.platformKey]
        : undefined;
      if (!artifact) {
        return { outcome: 'up-to-date', version: this.options.currentVersion };
      }
      const update: AvailableAppUpdate = {
        version: manifest.version,
        publishedAt: manifest.publishedAt,
        size: artifact.size,
      };
      return { outcome: 'update-available', update };
    } catch (error) {
      return {
        outcome: 'unavailable',
        reason:
          error instanceof Error
            ? error.message
            : 'Sotto could not check for updates.',
      };
    }
  }

  async downloadUpdate(): Promise<DownloadAppUpdateResult> {
    try {
      const manifest = await this.fetchManifest();
      if (
        compareAppVersions(manifest.version, this.options.currentVersion) <= 0
      ) {
        return { outcome: 'failed', reason: 'Sotto is already up to date.' };
      }
      const platformKey = this.options.platformKey;
      if (!platformKey) {
        return {
          outcome: 'failed',
          reason: 'No update is published for this platform.',
        };
      }

      const archive =
        platformKey === 'darwin-arm64' && this.options.installedAppPath
          ? manifest.artifacts['darwin-arm64-archive']
          : undefined;
      if (archive) {
        return await this.stageInPlaceUpdate(manifest.version, archive);
      }

      const installer = manifest.artifacts[platformKey];
      if (!installer) {
        return {
          outcome: 'failed',
          reason: 'No update is published for this platform.',
        };
      }
      return await this.downloadToDownloadsFolder(
        manifest.version,
        platformKey,
        installer,
      );
    } catch (error) {
      return {
        outcome: 'failed',
        reason:
          error instanceof Error
            ? error.message
            : 'Sotto could not download the update.',
      };
    }
  }

  /**
   * Swap the staged bundle into the installed location. The caller relaunches
   * the app afterwards; the swap itself is safe while the app is running
   * because macOS keeps the old bundle's mapped files alive.
   */
  async installUpdate(): Promise<InstallAppUpdateResult> {
    const staged = this.stagedUpdate;
    const installedAppPath = this.options.installedAppPath;
    if (!staged || !installedAppPath) {
      return {
        outcome: 'failed',
        reason: 'No downloaded update is ready to install.',
      };
    }
    const retiredPath = path.join(
      this.options.stagingDirectory,
      `retired-${this.options.currentVersion}.app`,
    );
    await rm(retiredPath, { force: true, recursive: true });
    try {
      await rename(installedAppPath, retiredPath);
    } catch (error) {
      return {
        outcome: 'failed',
        reason:
          error instanceof Error && 'code' in error && error.code === 'EPERM'
            ? 'Sotto does not have permission to replace its installed copy.'
            : 'Sotto could not move its installed copy aside.',
      };
    }
    try {
      await rename(staged.appPath, installedAppPath);
    } catch {
      await rename(retiredPath, installedAppPath).catch(() => undefined);
      return {
        outcome: 'failed',
        reason: 'Sotto could not move the new version into place.',
      };
    }
    this.stagedUpdate = null;
    return { outcome: 'installed', version: staged.version };
  }

  private async stageInPlaceUpdate(
    version: string,
    artifact: ManifestArtifact,
  ): Promise<DownloadAppUpdateResult> {
    const staging = this.options.stagingDirectory;
    await rm(staging, { force: true, recursive: true });
    await mkdir(staging, { recursive: true });
    const archivePath = path.join(staging, `Sotto-${version}.zip`);
    await this.downloadVerified(artifact, archivePath);
    const extractedDirectory = path.join(staging, 'extracted');
    await mkdir(extractedDirectory, { recursive: true });
    await this.extractArchive(archivePath, extractedDirectory);
    await unlink(archivePath).catch(() => undefined);
    const appPath = await findAppBundle(extractedDirectory);
    if (!appPath) {
      await rm(staging, { force: true, recursive: true });
      return {
        outcome: 'failed',
        reason: 'The downloaded update did not contain the Sotto app.',
      };
    }
    this.stagedUpdate = { version, appPath };
    return { outcome: 'staged', version };
  }

  private async downloadToDownloadsFolder(
    version: string,
    platformKey: UpdatePlatformKey,
    artifact: ManifestArtifact,
  ): Promise<DownloadAppUpdateResult> {
    await mkdir(this.options.downloadsDirectory, { recursive: true });
    const fileName = artifactFileName(version, platformKey);
    const filePath = path.join(this.options.downloadsDirectory, fileName);
    await this.downloadVerified(artifact, filePath);
    return { outcome: 'downloaded', fileName, filePath, version };
  }

  private async downloadVerified(
    artifact: ManifestArtifact,
    filePath: string,
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    const temporaryPath = `${filePath}.sotto-download`;
    try {
      const response = await this.fetcher(artifact.downloadUrl, {
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new TypeError(
          `The update download returned HTTP ${response.status}.`,
        );
      }

      const hash = createHash('sha256');
      let received = 0;
      const stream = createWriteStream(temporaryPath, { flags: 'w' });
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > artifact.size) {
            throw new TypeError(
              'The update download exceeded its published size.',
            );
          }
          hash.update(value);
          await new Promise<void>((resolveWrite, rejectWrite) => {
            stream.write(value, (writeError) =>
              writeError ? rejectWrite(writeError) : resolveWrite(),
            );
          });
        }
        await new Promise<void>((resolveEnd, rejectEnd) => {
          stream.end((endError: unknown) =>
            endError ? rejectEnd(endError as Error) : resolveEnd(),
          );
        });
      } catch (error) {
        // Wait for the lazily opened file descriptor to close before the
        // cleanup below unlinks the partial file, or the unlink can lose
        // the race against the stream's asynchronous open.
        stream.destroy();
        await once(stream, 'close').catch(() => undefined);
        throw error;
      }

      if (received !== artifact.size) {
        throw new TypeError('The update download ended early.');
      }
      if (hash.digest('hex') !== artifact.sha256) {
        throw new TypeError(
          'The update download did not match its published checksum.',
        );
      }
      await rename(temporaryPath, filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchManifest(): Promise<ParsedUpdateManifest> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher(this.options.manifestUrl, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new TypeError(
          `The update manifest returned HTTP ${response.status}.`,
        );
      }
      const body = await response.text();
      if (Buffer.byteLength(body, 'utf8') > MAX_MANIFEST_BYTES) {
        throw new TypeError('The update manifest is too large.');
      }
      return parseUpdateManifest(
        JSON.parse(body) as unknown,
        new URL(this.options.manifestUrl).origin,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        throw new TypeError('The update server did not respond in time.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
