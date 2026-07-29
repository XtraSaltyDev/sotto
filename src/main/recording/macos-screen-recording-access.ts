import { spawn } from 'node:child_process';
import path from 'node:path';

export const MACOS_SCREEN_PERMISSION_HELPER =
  'sotto-screen-permission-request';

type HelperRunner = (
  executablePath: string,
  args: readonly string[],
) => Promise<number | null>;

const defaultHelperRunner: HelperRunner = (executablePath, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(executablePath, [...args], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });

export const resolveMacScreenPermissionHelperPath = ({
  appPath,
  isPackaged,
  resourcesPath,
}: {
  appPath: string;
  isPackaged: boolean;
  resourcesPath: string;
}): string =>
  path.join(
    isPackaged ? resourcesPath : path.join(appPath, 'resources'),
    'sidecars',
    'darwin-arm64',
    MACOS_SCREEN_PERMISSION_HELPER,
  );

/**
 * Runs Apple's CGRequestScreenCaptureAccess from a native child of Sotto.
 * macOS attributes this request to the responsible app bundle and owns the
 * protected consent prompt.
 */
export const requestMacScreenRecordingAccess = async ({
  appPath,
  isPackaged,
  platform = process.platform,
  resourcesPath,
  runHelper = defaultHelperRunner,
}: {
  appPath: string;
  isPackaged: boolean;
  platform?: NodeJS.Platform;
  resourcesPath: string;
  runHelper?: HelperRunner;
}): Promise<boolean> => {
  if (platform !== 'darwin') return false;

  const exitCode = await runHelper(
    resolveMacScreenPermissionHelperPath({
      appPath,
      isPackaged,
      resourcesPath,
    }),
    [],
  );
  if (exitCode === 0) return true;
  if (exitCode === 2) return false;
  throw new Error(
    `Sotto's native screen-permission request exited with code ${String(exitCode)}.`,
  );
};
