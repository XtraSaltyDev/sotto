import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SquirrelMacUpdateInstaller } from './mac-update-installer';

class FakeAutoUpdater extends EventEmitter {
  readonly setFeedURL = vi.fn();

  readonly checkForUpdates = vi.fn();

  readonly quitAndInstall = vi.fn();
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('SquirrelMacUpdateInstaller', () => {
  it('streams a local Squirrel feed and installs only after validation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sotto-squirrel-'));
    temporaryDirectories.push(directory);
    const archivePath = path.join(directory, 'Sotto-0.2.0.zip');
    await writeFile(archivePath, 'archive');
    const updater = new FakeAutoUpdater();
    let observedFeed: Promise<{ feedUrl: string; body: unknown }>;
    updater.checkForUpdates.mockImplementation(() => {
      const feedUrl = updater.setFeedURL.mock.calls[0][0].url as string;
      observedFeed = (async () => {
        const feed = await fetch(feedUrl).then(async (response) => response.json());
        const archive = await fetch((feed as { url: string }).url).then(
          async (response) => response.text(),
        );
        expect(archive).toBe('archive');
        return { feedUrl, body: feed };
      })();
      void observedFeed.then(() => updater.emit('update-downloaded'));
    });
    const installer = new SquirrelMacUpdateInstaller(updater);

    await installer.prepareUpdate({
      version: '0.2.0',
      publishedAt: '2026-08-06T12:00:00.000Z',
      archivePath,
    });

    expect(updater.setFeedURL).toHaveBeenCalledOnce();
    const { feedUrl, body } = await observedFeed!;
    expect(feedUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/feed\.json$/u);
    expect(body).toEqual({
      url: feedUrl.replace('/feed.json', '/Sotto.zip'),
      name: '0.2.0',
      pub_date: '2026-08-06T12:00:00.000Z',
    });
    await expect(fetch(feedUrl)).rejects.toThrow();

    installer.installUpdate('0.2.0');
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
    expect(() => installer.installUpdate('0.2.0')).toThrow(/not ready/u);
  });

  it('surfaces Squirrel code-signature rejection and never installs', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sotto-squirrel-'));
    temporaryDirectories.push(directory);
    const archivePath = path.join(directory, 'Sotto-0.2.0.zip');
    await writeFile(archivePath, 'archive');
    const updater = new FakeAutoUpdater();
    updater.checkForUpdates.mockImplementation(() => {
      queueMicrotask(() =>
        updater.emit('error', new Error('code signature did not pass validation')),
      );
    });
    const installer = new SquirrelMacUpdateInstaller(updater);

    await expect(
      installer.prepareUpdate({
        version: '0.2.0',
        publishedAt: '2026-08-06T12:00:00.000Z',
        archivePath,
      }),
    ).rejects.toThrow(/code signature/u);
    expect(() => installer.installUpdate('0.2.0')).toThrow(/not ready/u);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
});
