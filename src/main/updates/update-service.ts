import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { mkdir, readdir, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ClientRequest, IncomingMessage } from 'node:http';

import type {
  AvailableAppUpdate,
  AppUpdateProgress,
  CheckForAppUpdateResult,
  DownloadAppUpdateResult,
  InstallAppUpdateResult,
} from '../../shared/contracts';
import {
  verifyReleaseManifest,
} from './release-manifest.cjs';
import {
  readMacAppBundleMetadata,
  validateExtractedMacApp,
} from './mac-app-bundle';
import type { ReadMacAppBundleMetadata } from './mac-app-bundle';
import type {
  ParsedReleaseManifest,
  ReleaseManifestArtifact,
  TrustedReleaseKeys,
} from './release-manifest.cjs';

export const DEFAULT_SOTTO_UPDATE_MANIFEST_URL = null;

const MANIFEST_TIMEOUT_MS = 8_000;
// Transient ENOTEMPTY/EBUSY during large recursive deletes retry briefly.
const RM_RETRY_OPTIONS = {
  force: true,
  recursive: true,
  maxRetries: 3,
  retryDelay: 150,
} as const;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const MAX_MANIFEST_BYTES = 64 * 1024;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;

export type UpdatePlatformKey = 'darwin-arm64' | 'win32-x64';

/**
 * 'darwin-arm64' and 'win32-x64' are user-facing installers saved to the
 * Downloads folder. 'darwin-arm64-archive' is the ZIP build the in-place
 * installer stages and swaps; clients that predate it ignore the key.
 */
export interface UpdateServiceOptions {
  manifestUrl: string | null;
  trustedManifestKeys: TrustedReleaseKeys;
  currentVersion: string;
  platformKey: UpdatePlatformKey | null;
  downloadsDirectory: string;
  /** Private scratch directory for staged in-place updates. */
  stagingDirectory: string;
  /** The installed .app bundle to replace, or null when not replaceable. */
  installedAppPath: string | null;
  fetcher?: typeof fetch;
  /** Test hook; production artifact downloads use native Node HTTP streams. */
  downloadFetcher?: typeof fetch;
  onProgress?: (progress: AppUpdateProgress) => void;
  extractArchive?: (archivePath: string, directory: string) => Promise<void>;
  readMacAppBundleMetadata?: ReadMacAppBundleMetadata;
  /** Explicit test-fixture escape hatch; production never enables HTTP. */
  allowInsecureUpdateUrlsForTests?: boolean;
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

const requestArtifactStream = (
  url: string,
  signal: AbortSignal,
): Promise<IncomingMessage> => {
  const parsedUrl = new URL(url);
  const client =
    parsedUrl.protocol === 'https:'
      ? https
      : parsedUrl.protocol === 'http:'
        ? http
        : null;
  if (!client) {
    return Promise.reject(
      new TypeError('The update artifact URL must use HTTP or HTTPS.'),
    );
  }
  if (signal.aborted) {
    return Promise.reject(new TypeError('The update download was canceled.'));
  }

  return new Promise<IncomingMessage>((resolve, reject) => {
    let response: IncomingMessage | null = null;
    let settled = false;

    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      const error = new TypeError('The update download was canceled.');
      response?.destroy(error);
      request.destroy(error);
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    };

    const request: ClientRequest = client.get(
      parsedUrl,
      { headers: { Accept: 'application/octet-stream' } },
      (incoming) => {
        response = incoming;
        const status = incoming.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          incoming.resume();
          settled = true;
          cleanup();
          reject(
            new TypeError(`The update download returned HTTP ${status}.`),
          );
          return;
        }
        incoming.once('close', cleanup);
        settled = true;
        resolve(incoming);
      },
    );
    request.once('error', (error) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    signal.addEventListener('abort', onAbort, { once: true });
  });
};

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

const artifactFileName = (
  version: string,
  platformKey: UpdatePlatformKey,
): string =>
  platformKey === 'darwin-arm64'
    ? `Sotto-${version}-arm64.dmg`
    : `Sotto-win32-x64-${version}.zip`;

export class UpdateService {
  private readonly fetcher: typeof fetch;

  private readonly downloadFetcher: typeof fetch | null;

  private readonly extractArchive: (
    archivePath: string,
    directory: string,
  ) => Promise<void>;

  private readonly readMacAppBundleMetadata: ReadMacAppBundleMetadata;

  private stagedUpdate: {
    version: string;
    bundleId: string;
    appPath: string;
  } | null = null;

  private activeDownloadController: AbortController | null = null;

  private downloadInProgress = false;

  private cancelRequested = false;

  constructor(private readonly options: UpdateServiceOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.downloadFetcher = options.downloadFetcher ?? options.fetcher ?? null;
    this.extractArchive = options.extractArchive ?? dittoExtract;
    this.readMacAppBundleMetadata =
      options.readMacAppBundleMetadata ?? readMacAppBundleMetadata;
  }

  cancelDownload(): void {
    this.cancelRequested = true;
    this.activeDownloadController?.abort();
  }

  private preferredArtifact(
    manifest: ParsedReleaseManifest,
  ): ReleaseManifestArtifact | undefined {
    const platformKey = this.options.platformKey;
    if (!platformKey) return undefined;
    if (platformKey === 'darwin-arm64' && this.options.installedAppPath) {
      return (
        manifest.artifacts['darwin-arm64-archive'] ??
        manifest.artifacts[platformKey]
      );
    }
    return manifest.artifacts[platformKey];
  }

  async checkForUpdates(): Promise<CheckForAppUpdateResult> {
    try {
      const manifest = await this.fetchManifest();
      if (
        compareAppVersions(manifest.version, this.options.currentVersion) <= 0
      ) {
        return { outcome: 'up-to-date', version: this.options.currentVersion };
      }
      const artifact = this.preferredArtifact(manifest);
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
    if (this.downloadInProgress) {
      return {
        outcome: 'failed',
        reason: 'An update is already being downloaded.',
      };
    }
    this.downloadInProgress = true;
    this.cancelRequested = false;
    let updateVersion: string | null = null;
    try {
      const manifest = await this.fetchManifest();
      updateVersion = manifest.version;
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
        return await this.stageInPlaceUpdate(
          manifest.version,
          manifest.bundleId,
          archive,
        );
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
      if (this.cancelRequested && updateVersion) {
        return { outcome: 'cancelled', version: updateVersion };
      }
      return {
        outcome: 'failed',
        reason:
          error instanceof Error
            ? error.message
            : 'Sotto could not download the update.',
      };
    } finally {
      this.downloadInProgress = false;
      this.activeDownloadController = null;
      this.cancelRequested = false;
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
    try {
      await validateExtractedMacApp(
        path.dirname(staged.appPath),
        staged.bundleId,
        staged.version,
        this.readMacAppBundleMetadata,
      );
    } catch (error) {
      return {
        outcome: 'failed',
        reason:
          error instanceof Error
            ? error.message
            : 'Sotto could not validate the downloaded app.',
      };
    }
    let retiredPath = path.join(
      this.options.stagingDirectory,
      `retired-${this.options.currentVersion}.app`,
    );
    try {
      await rm(retiredPath, RM_RETRY_OPTIONS);
    } catch {
      // A stubborn previous rollback bundle must not block this install;
      // retire the current copy under a unique name instead.
      retiredPath = path.join(
        this.options.stagingDirectory,
        `retired-${this.options.currentVersion}-${Date.now()}.app`,
      );
    }
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
    bundleId: string,
    artifact: ReleaseManifestArtifact,
  ): Promise<DownloadAppUpdateResult> {
    const staging = this.options.stagingDirectory;
    await mkdir(staging, { recursive: true });
    // Stage into a per-version directory so a new update never depends on
    // deleting earlier leftovers. A retired rollback bundle that resists
    // deletion (ENOTEMPTY under load has been observed on APFS) must not
    // block updating; stale artifacts are swept separately, best effort.
    let stageDirectory = path.join(staging, `stage-${version}`);
    try {
      await rm(stageDirectory, RM_RETRY_OPTIONS);
    } catch {
      stageDirectory = path.join(staging, `stage-${version}-${Date.now()}`);
    }
    await mkdir(stageDirectory, { recursive: true });
    const archivePath = path.join(stageDirectory, `Sotto-${version}.zip`);
    await this.downloadVerified(artifact, archivePath, version);
    this.options.onProgress?.({ phase: 'preparing', version });
    const extractedDirectory = path.join(stageDirectory, 'extracted');
    await mkdir(extractedDirectory, { recursive: true });
    let appPath: string;
    try {
      await this.extractArchive(archivePath, extractedDirectory);
      await unlink(archivePath).catch(() => undefined);
      appPath = await validateExtractedMacApp(
        extractedDirectory,
        bundleId,
        version,
        this.readMacAppBundleMetadata,
      );
    } catch (error) {
      await rm(stageDirectory, RM_RETRY_OPTIONS).catch(() => undefined);
      throw error;
    }
    this.stagedUpdate = { version, bundleId, appPath };
    return { outcome: 'staged', version };
  }

  /**
   * Best-effort removal of artifacts from finished updates: retired
   * rollback bundles, staged directories, and legacy layout leftovers.
   * Failures are logged and never surfaced — the next update does not
   * depend on this sweep succeeding.
   */
  async cleanupStaleUpdateArtifacts(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.options.stagingDirectory);
    } catch {
      return;
    }
    const activeStageDirectory = this.stagedUpdate
      ? path.relative(
          this.options.stagingDirectory,
          this.stagedUpdate.appPath,
        ).split(path.sep)[0]
      : null;
    for (const entry of entries) {
      if (entry === activeStageDirectory) continue;
      if (
        !entry.startsWith('retired-') &&
        !entry.startsWith('stage-') &&
        entry !== 'extracted' &&
        !entry.endsWith('.zip') &&
        !entry.endsWith('.sotto-download')
      ) {
        continue;
      }
      await rm(
        path.join(this.options.stagingDirectory, entry),
        RM_RETRY_OPTIONS,
      ).catch((error: unknown) => {
        console.warn(
          `[sotto] Could not remove stale update artifact ${entry}.`,
          error,
        );
      });
    }
  }

  private async downloadToDownloadsFolder(
    version: string,
    platformKey: UpdatePlatformKey,
    artifact: ReleaseManifestArtifact,
  ): Promise<DownloadAppUpdateResult> {
    await mkdir(this.options.downloadsDirectory, { recursive: true });
    const fileName = artifactFileName(version, platformKey);
    const filePath = path.join(this.options.downloadsDirectory, fileName);
    await this.downloadVerified(artifact, filePath, version);
    return { outcome: 'downloaded', fileName, filePath, version };
  }

  private async downloadVerified(
    artifact: ReleaseManifestArtifact,
    filePath: string,
    version: string,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeDownloadController = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, DOWNLOAD_TIMEOUT_MS);
    const temporaryPath = `${filePath}.sotto-download`;
    const stream = createWriteStream(temporaryPath, { flags: 'w' });
    const hash = createHash('sha256');
    let received = 0;
    let lastProgressAt = 0;
    const reportProgress = (force = false): void => {
      const now = Date.now();
      if (!force && now - lastProgressAt < 100) return;
      lastProgressAt = now;
      this.options.onProgress?.({
        phase: 'downloading',
        version,
        receivedBytes: received,
        totalBytes: artifact.size,
      });
    };
    const writeChunk = async (chunk: Uint8Array): Promise<void> => {
      const value = Buffer.from(chunk);
      received += value.byteLength;
      if (received > artifact.size) {
        throw new TypeError('The update download exceeded its published size.');
      }
      hash.update(value);
      await new Promise<void>((resolveWrite, rejectWrite) => {
        stream.write(value, (writeError) =>
          writeError ? rejectWrite(writeError) : resolveWrite(),
        );
      });
      reportProgress();
    };
    const waitForStreamClose = async (): Promise<void> => {
      if (stream.closed) return;
      await once(stream, 'close').catch(() => undefined);
    };
    try {
      reportProgress(true);
      try {
        if (this.downloadFetcher) {
          const response = await this.downloadFetcher(artifact.downloadUrl, {
            redirect: 'error',
            signal: controller.signal,
          });
          if (!response.ok || !response.body) {
            throw new TypeError(
              `The update download returned HTTP ${response.status}.`,
            );
          }
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await writeChunk(value);
          }
        } else {
          const response = await requestArtifactStream(
            artifact.downloadUrl,
            controller.signal,
          );
          for await (const chunk of response) {
            await writeChunk(chunk);
          }
        }
        reportProgress(true);
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
      if (timedOut) {
        throw new TypeError('The update server did not respond in time.');
      }
      if (this.cancelRequested) {
        throw new TypeError('The update download was canceled.');
      }
      throw error;
    } finally {
      await waitForStreamClose();
      clearTimeout(timeout);
      if (this.activeDownloadController === controller) {
        this.activeDownloadController = null;
      }
    }
  }

  private async fetchManifest(): Promise<ParsedReleaseManifest> {
    const manifestUrl = this.options.manifestUrl;
    if (
      manifestUrl === null ||
      Object.keys(this.options.trustedManifestKeys).length === 0
    ) {
      throw new TypeError(
        'Secure updates are not configured for this Sotto build.',
      );
    }
    let parsedManifestUrl: URL;
    try {
      parsedManifestUrl = new URL(manifestUrl);
    } catch {
      throw new TypeError('The update manifest URL is invalid.');
    }
    if (
      parsedManifestUrl.protocol !== 'https:' &&
      !(
        this.options.allowInsecureUpdateUrlsForTests === true &&
        parsedManifestUrl.protocol === 'http:'
      )
    ) {
      throw new TypeError('The update manifest URL must use HTTPS.');
    }
    if (
      parsedManifestUrl.username ||
      parsedManifestUrl.password ||
      parsedManifestUrl.search ||
      parsedManifestUrl.hash
    ) {
      throw new TypeError(
        'The update manifest URL must not contain credentials, a query, or a fragment.',
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher(manifestUrl, {
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
      return verifyReleaseManifest(
        JSON.parse(body) as unknown,
        this.options.trustedManifestKeys,
        manifestUrl,
        {
          allowInsecureHttpForTests:
            this.options.allowInsecureUpdateUrlsForTests === true,
        },
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
