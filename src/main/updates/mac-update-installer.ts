import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export interface MacUpdateInstaller {
  prepareUpdate(input: {
    version: string;
    publishedAt: string;
    archivePath: string;
  }): Promise<void>;
  installUpdate(version: string): void;
}

interface ElectronAutoUpdater {
  setFeedURL(options: { url: string }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
  once(event: 'update-downloaded', listener: (...args: unknown[]) => void): this;
  once(event: 'error', listener: (...args: unknown[]) => void): this;
  removeListener(
    event: 'update-downloaded' | 'error',
    listener: (...args: unknown[]) => void,
  ): this;
}

const PREPARE_TIMEOUT_MS = 10 * 60_000;

/**
 * Hands a locally verified ZIP to Electron's supported macOS updater.
 * Squirrel.Mac validates the replacement's Apple code requirement, waits for
 * the running app to quit, swaps the bundle, and launches the new version.
 */
export class SquirrelMacUpdateInstaller implements MacUpdateInstaller {
  private readyVersion: string | null = null;

  constructor(
    private readonly updater: ElectronAutoUpdater,
    private readonly prepareTimeoutMs = PREPARE_TIMEOUT_MS,
  ) {}

  async prepareUpdate({
    version,
    publishedAt,
    archivePath,
  }: {
    version: string;
    publishedAt: string;
    archivePath: string;
  }): Promise<void> {
    this.readyVersion = null;
    const feedPath = `${archivePath}.json`;
    await writeFile(
      feedPath,
      `${JSON.stringify({
        url: pathToFileURL(archivePath).href,
        name: version,
        pub_date: publishedAt,
      })}\n`,
      { mode: 0o600 },
    );

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timeout);
        this.updater.removeListener('update-downloaded', onDownloaded);
        this.updater.removeListener('error', onError);
      };
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onDownloaded = (): void => {
        this.readyVersion = version;
        finish();
      };
      const onError = (...args: unknown[]): void => {
        const error = args.find((value): value is Error => value instanceof Error);
        finish(error ?? new Error('The macOS update installer rejected the update.'));
      };
      const timeout = setTimeout(
        () => finish(new Error('The macOS update installer did not become ready in time.')),
        this.prepareTimeoutMs,
      );

      this.updater.once('update-downloaded', onDownloaded);
      this.updater.once('error', onError);
      try {
        this.updater.setFeedURL({ url: pathToFileURL(feedPath).href });
        this.updater.checkForUpdates();
      } catch (error) {
        finish(
          error instanceof Error
            ? error
            : new Error('The macOS update installer could not start.'),
        );
      }
    });
  }

  installUpdate(version: string): void {
    if (this.readyVersion !== version) {
      throw new Error('The macOS update is not ready to install.');
    }
    this.readyVersion = null;
    this.updater.quitAndInstall();
  }
}
