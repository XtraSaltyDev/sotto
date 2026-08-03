import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  readMacAppBundleMetadata,
  validateExtractedMacApp,
} from './mac-app-bundle';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const extractedDirectory = async (...appNames: string[]): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sotto-app-bundle-'));
  temporaryDirectories.push(directory);
  await Promise.all(
    appNames.map((name) =>
      mkdir(path.join(directory, name, 'Contents'), { recursive: true }),
    ),
  );
  return directory;
};

describe('validateExtractedMacApp', () => {
  it('accepts exactly Sotto.app with the expected identity and version', async () => {
    const directory = await extractedDirectory('Sotto.app');
    await expect(
      validateExtractedMacApp(
        directory,
        'com.sotto.desktop',
        '0.2.0',
        async () => ({ bundleId: 'com.sotto.desktop', version: '0.2.0' }),
      ),
    ).resolves.toBe(path.join(directory, 'Sotto.app'));
  });

  it.each([
    [['Other.app'], 'an app with the wrong name'],
    [['Sotto.app', 'Other.app'], 'more than one app bundle'],
  ])('rejects %s (%s)', async (appNames) => {
    const directory = await extractedDirectory(...appNames);
    await expect(
      validateExtractedMacApp(
        directory,
        'com.sotto.desktop',
        '0.2.0',
        async () => ({ bundleId: 'com.sotto.desktop', version: '0.2.0' }),
      ),
    ).rejects.toThrow('exactly Sotto.app');
  });

  it('rejects a bundle identifier other than Sotto', async () => {
    const directory = await extractedDirectory('Sotto.app');
    await expect(
      validateExtractedMacApp(
        directory,
        'com.sotto.desktop',
        '0.2.0',
        async () => ({ bundleId: 'com.attacker.fake', version: '0.2.0' }),
      ),
    ).rejects.toThrow('bundle identifier');
  });

  it('rejects a bundle version different from the authenticated offer', async () => {
    const directory = await extractedDirectory('Sotto.app');
    await expect(
      validateExtractedMacApp(
        directory,
        'com.sotto.desktop',
        '0.2.0',
        async () => ({ bundleId: 'com.sotto.desktop', version: '9.9.9' }),
      ),
    ).rejects.toThrow('offered version');
  });
});

describe('readMacAppBundleMetadata', () => {
  it.runIf(process.platform === 'darwin')(
    'reads the bundle identifier and short version from Info.plist',
    async () => {
      const directory = await extractedDirectory('Sotto.app');
      await writeFile(
        path.join(directory, 'Sotto.app', 'Contents', 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.sotto.desktop</string>
<key>CFBundleShortVersionString</key><string>0.2.0</string>
</dict></plist>`,
      );

      await expect(
        readMacAppBundleMetadata(path.join(directory, 'Sotto.app')),
      ).resolves.toEqual({
        bundleId: 'com.sotto.desktop',
        version: '0.2.0',
      });
    },
  );
});
