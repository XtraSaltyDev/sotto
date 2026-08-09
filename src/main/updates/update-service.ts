import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { mkdir, readdir, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { rootCertificates } from 'node:tls';

import type {
  AvailableAppUpdate,
  AppUpdateProgress,
  CheckForAppUpdateResult,
  DownloadAppUpdateResult,
  InstallAppUpdateResult,
} from '../../shared/contracts';

type UpdateServiceDownloadResult =
  | Exclude<DownloadAppUpdateResult, { outcome: 'downloaded' }>
  | (Extract<DownloadAppUpdateResult, { outcome: 'downloaded' }> & {
      filePath: string;
    });
import {
  verifyReleaseManifest,
} from './release-manifest.cjs';
import type { MacUpdateInstaller } from './mac-update-installer';
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

// Squirrel.Mac's legacy URL loader buffers the complete archive in memory.
// Core Foundation grows that buffer geometrically and aborts while handling
// Sotto's 1.6 GB package. Keep a conservative ceiling here as a second line of
// defense even though the publisher also omits oversized archives.
export const MAX_SQUIRREL_MAC_ARCHIVE_BYTES = 900 * 1024 * 1024;

export type UpdatePlatformKey = 'darwin-arm64' | 'win32-x64';

/**
 * 'darwin-arm64' and 'win32-x64' are user-facing installers saved to the
 * Downloads folder. 'darwin-arm64-archive' is the ZIP handed to Squirrel.Mac;
 * clients that predate it ignore the key.
 */
export interface UpdateServiceOptions {
  manifestUrl: string | null;
  trustedManifestKeys: TrustedReleaseKeys;
  currentVersion: string;
  /** Exact source commit in the installed signed package receipt, when available. */
  currentCommit?: string;
  platformKey: UpdatePlatformKey | null;
  downloadsDirectory: string;
  /** Private scratch directory for verified updater artifacts. */
  stagingDirectory: string;
  /** The installed .app bundle to replace, or null when not replaceable. */
  installedAppPath: string | null;
  /** Additional public CA used only for the configured HTTPS update origin. */
  tlsCa?: string | Buffer;
  fetcher?: typeof fetch;
  /** Test hook; production artifact downloads use native Node HTTP streams. */
  downloadFetcher?: typeof fetch;
  onProgress?: (progress: AppUpdateProgress) => void;
  /** Electron's Squirrel.Mac bridge. Required for automatic macOS installs. */
  macUpdateInstaller?: MacUpdateInstaller;
  /** Explicit test-fixture escape hatch; production never enables HTTP. */
  allowInsecureUpdateUrlsForTests?: boolean;
}

const requestArtifactStream = (
  url: string,
  signal: AbortSignal,
  tlsCa?: string | Buffer,
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

    const requestOptions: https.RequestOptions = {
      headers: { Accept: 'application/octet-stream' },
    };
    if (parsedUrl.protocol === 'https:' && tlsCa !== undefined) {
      requestOptions.ca = [...rootCertificates, tlsCa];
    }
    const request: ClientRequest = client.get(
      parsedUrl,
      requestOptions,
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

  private stagedUpdate: {
    version: string;
    stageDirectory: string;
  } | null = null;

  private activeDownloadController: AbortController | null = null;

  private downloadInProgress = false;

  private cancelRequested = false;

  constructor(private readonly options: UpdateServiceOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.downloadFetcher = options.downloadFetcher ?? options.fetcher ?? null;
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
    if (
      platformKey === 'darwin-arm64' &&
      this.options.installedAppPath &&
      this.options.macUpdateInstaller
    ) {
      return (
        this.safeMacArchive(manifest) ??
        manifest.artifacts[platformKey]
      );
    }
    return manifest.artifacts[platformKey];
  }

  private safeMacArchive(
    manifest: ParsedReleaseManifest,
  ): ReleaseManifestArtifact | undefined {
    const archive = manifest.artifacts['darwin-arm64-archive'];
    return archive && archive.size <= MAX_SQUIRREL_MAC_ARCHIVE_BYTES
      ? archive
      : undefined;
  }

  async checkForUpdates(): Promise<CheckForAppUpdateResult> {
    try {
      const manifest = await this.fetchManifest();
      this.assertCurrentReleaseIdentity(manifest);
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

  async downloadUpdate(): Promise<UpdateServiceDownloadResult> {
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
      this.assertCurrentReleaseIdentity(manifest);
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
        platformKey === 'darwin-arm64' &&
        this.options.installedAppPath &&
        this.options.macUpdateInstaller
          ? this.safeMacArchive(manifest)
          : undefined;
      if (archive) {
        return await this.stageInPlaceUpdate(
          manifest.version,
          manifest.publishedAt,
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

  async installUpdate(): Promise<InstallAppUpdateResult> {
    const staged = this.stagedUpdate;
    const macUpdateInstaller = this.options.macUpdateInstaller;
    if (!staged || !macUpdateInstaller) {
      return {
        outcome: 'failed',
        reason: 'No downloaded update is ready to install.',
      };
    }
    try {
      macUpdateInstaller.installUpdate(staged.version);
    } catch (error) {
      return {
        outcome: 'failed',
        reason:
          error instanceof Error
            ? error.message
            : 'Sotto could not start the macOS update installer.',
      };
    }
    this.stagedUpdate = null;
    return { outcome: 'installed', version: staged.version };
  }

  private async stageInPlaceUpdate(
    version: string,
    publishedAt: string,
    artifact: ReleaseManifestArtifact,
  ): Promise<Extract<DownloadAppUpdateResult, { outcome: 'staged' }>> {
    const macUpdateInstaller = this.options.macUpdateInstaller;
    if (!macUpdateInstaller) {
      throw new TypeError('The macOS update installer is not available.');
    }
    const staging = this.options.stagingDirectory;
    await mkdir(staging, { recursive: true });
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
    try {
      await macUpdateInstaller.prepareUpdate({
        version,
        publishedAt,
        archivePath,
      });
    } catch (error) {
      await rm(stageDirectory, RM_RETRY_OPTIONS).catch(() => undefined);
      throw error;
    }
    this.stagedUpdate = { version, stageDirectory };
    return { outcome: 'staged', version };
  }

  /**
   * Best-effort removal of finished Squirrel staging and legacy custom-updater
   * leftovers. Failures never block a later update.
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
      ? path.basename(this.stagedUpdate.stageDirectory)
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
  ): Promise<UpdateServiceDownloadResult> {
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
            this.options.tlsCa,
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

  private assertCurrentReleaseIdentity(
    manifest: ParsedReleaseManifest,
  ): void {
    const currentCommit = this.options.currentCommit;
    if (
      currentCommit &&
      manifest.version === this.options.currentVersion &&
      manifest.commit !== currentCommit
    ) {
      throw new TypeError(
        'The published release reuses this version with a different source commit.',
      );
    }
  }
}
