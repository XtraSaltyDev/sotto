import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

export interface RecordingExportOperations {
  copyFile: typeof copyFile;
  rename: typeof rename;
  chmod: typeof chmod;
  unlink: typeof unlink;
}

const defaultOperations: RecordingExportOperations = {
  chmod,
  copyFile,
  rename,
  unlink,
};

export const copyRecordingForExport = async (
  sourcePath: string,
  destinationPath: string,
  operations: RecordingExportOperations = defaultOperations,
  platform: NodeJS.Platform = process.platform,
): Promise<void> => {
  if (!path.isAbsolute(sourcePath) || !path.isAbsolute(destinationPath)) {
    throw new TypeError('Recording export paths must be absolute.');
  }

  const temporaryPath = path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.${randomUUID()}.sotto-export.tmp`,
  );
  try {
    await operations.copyFile(sourcePath, temporaryPath);
    if (platform !== 'win32') await operations.chmod(temporaryPath, 0o600);
    await operations.rename(temporaryPath, destinationPath);
  } catch (error) {
    await operations.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};
