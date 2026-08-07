import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';

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

interface LoopbackFeed {
  url: string;
  close(): void;
}

const startLoopbackFeed = async ({
  version,
  publishedAt,
  archivePath,
}: {
  version: string;
  publishedAt: string;
  archivePath: string;
}): Promise<LoopbackFeed> => {
  const archive = await stat(archivePath);
  let feed = '';
  const server = createServer((request, response) => {
    const method = request.method ?? 'GET';
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    if (pathname === '/feed.json') {
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(feed),
        'Content-Type': 'application/json',
      });
      response.end(method === 'HEAD' ? undefined : feed);
      return;
    }
    if (pathname !== '/Sotto.zip') {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': archive.size,
      'Content-Type': 'application/zip',
    });
    if (method === 'HEAD') {
      response.end();
      return;
    }
    const stream = createReadStream(archivePath);
    stream.once('error', () => response.destroy());
    stream.pipe(response);
  });
  server.on('clientError', (_error, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('The macOS update feed could not bind to localhost.');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  feed = JSON.stringify({
    url: `${baseUrl}/Sotto.zip`,
    name: version,
    pub_date: publishedAt,
  });

  return {
    url: `${baseUrl}/feed.json`,
    close: () => closeServer(server),
  };
};

const closeServer = (server: Server): void => {
  server.close();
  server.closeAllConnections();
};

/**
 * Hands a locally verified ZIP to Electron's supported macOS updater.
 * Squirrel.Mac validates the replacement's Apple code requirement, waits for
 * the running app to quit, swaps the bundle, and launches the new version.
 *
 * The ZIP is streamed from a private loopback server. A file:// feed makes
 * macOS CFURLConnection buffer large archives in memory and crashes near its
 * 2 GB allocation boundary before Squirrel can validate the update.
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
    const feed = await startLoopbackFeed({ version, publishedAt, archivePath });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timeout);
        this.updater.removeListener('update-downloaded', onDownloaded);
        this.updater.removeListener('error', onError);
        feed.close();
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
        this.updater.setFeedURL({ url: feed.url });
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
