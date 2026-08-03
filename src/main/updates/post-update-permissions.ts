import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * An in-place update replaces the ad-hoc-signed bundle, so macOS treats the
 * relaunched app as new and drops its Screen & System Audio Recording
 * grant. A marker written just before the update relaunch lets the next
 * launch run the permission repair on its own; the only remaining user step
 * is the operating system's approval prompt.
 */
const MARKER_FILE_NAME = 'pending-permission-repair.json';

const markerPath = (userDataDirectory: string): string =>
  path.join(userDataDirectory, MARKER_FILE_NAME);

export const markPendingPermissionRepair = async (
  userDataDirectory: string,
): Promise<void> => {
  await mkdir(userDataDirectory, { recursive: true });
  await writeFile(
    markerPath(userDataDirectory),
    `${JSON.stringify({ schemaVersion: 1 })}\n`,
  );
};

/**
 * Removes the marker and reports whether it existed. Deleting before the
 * repair runs guarantees a single attempt per update even if the repair
 * itself relaunches the app.
 */
export const consumePendingPermissionRepair = async (
  userDataDirectory: string,
): Promise<boolean> => {
  try {
    await unlink(markerPath(userDataDirectory));
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return false;
    }
    throw error;
  }
};
