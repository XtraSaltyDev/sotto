import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface MacAppBundleMetadata {
  bundleId: string;
  version: string;
}

export type ReadMacAppBundleMetadata = (
  appPath: string,
) => Promise<MacAppBundleMetadata>;

const plistValue = async (
  plistPath: string,
  key: string,
): Promise<string> => {
  try {
    const { stdout } = await execFileAsync('/usr/bin/plutil', [
      '-extract',
      key,
      'raw',
      '-o',
      '-',
      plistPath,
    ]);
    return stdout.trim();
  } catch {
    throw new TypeError('Sotto could not read the downloaded app identity.');
  }
};

export const readMacAppBundleMetadata: ReadMacAppBundleMetadata = async (
  appPath,
) => {
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
  const [bundleId, version] = await Promise.all([
    plistValue(infoPlist, 'CFBundleIdentifier'),
    plistValue(infoPlist, 'CFBundleShortVersionString'),
  ]);
  return { bundleId, version };
};

export const validateExtractedMacApp = async (
  extractedDirectory: string,
  expectedBundleId: string,
  expectedVersion: string,
  readMetadata: ReadMacAppBundleMetadata = readMacAppBundleMetadata,
): Promise<string> => {
  const entries = await readdir(extractedDirectory, { withFileTypes: true });
  const appBundles = entries.filter(
    (entry) => entry.isDirectory() && entry.name.endsWith('.app'),
  );
  if (appBundles.length !== 1 || appBundles[0].name !== 'Sotto.app') {
    throw new TypeError(
      'The downloaded update must contain exactly Sotto.app.',
    );
  }
  const appPath = path.join(extractedDirectory, appBundles[0].name);
  const metadata = await readMetadata(appPath);
  if (metadata.bundleId !== expectedBundleId) {
    throw new TypeError(
      'The downloaded update has an unexpected bundle identifier.',
    );
  }
  if (metadata.version !== expectedVersion) {
    throw new TypeError(
      'The downloaded app version does not match the offered version.',
    );
  }
  return appPath;
};
