import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SOTTO_APP_BUNDLE_ID } from '../../shared/app-identity';

export const SOTTO_MAC_BUNDLE_ID = SOTTO_APP_BUNDLE_ID;
export const TCCUTIL_PATH = '/usr/bin/tccutil';
export const RECORDING_PERMISSION_SERVICES = [
  'ScreenCapture',
  'AudioCapture',
  'Microphone',
] as const;

type PermissionService = (typeof RECORDING_PERMISSION_SERVICES)[number];
type CommandRunner = (
  file: string,
  args: readonly string[],
) => Promise<void>;
type PermissionResetter = () => Promise<PermissionService[]>;
type RecordingSettingsOpener = () => Promise<void>;

const execFileAsync = promisify(execFile);

const defaultCommandRunner: CommandRunner = async (file, args) => {
  await execFileAsync(file, [...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1_024,
    timeout: 10_000,
    windowsHide: true,
  });
};

export class RecordingPermissionResetError extends Error {
  constructor(
    message = 'Sotto could not clear its old macOS recording permission.',
  ) {
    super(message);
    this.name = 'RecordingPermissionResetError';
  }
}

/**
 * Clears only Sotto's own TCC decisions. This cannot grant permission; the
 * next capture request still shows Apple's consent UI. AudioCapture is newer
 * than ScreenCapture, so it is best-effort on older supported macOS releases.
 */
export const resetSottoRecordingPermissions = async ({
  platform = process.platform,
  runCommand = defaultCommandRunner,
}: {
  platform?: NodeJS.Platform;
  runCommand?: CommandRunner;
} = {}): Promise<PermissionService[]> => {
  if (platform !== 'darwin') {
    throw new RecordingPermissionResetError(
      'Recording permission repair is available only on macOS.',
    );
  }

  const reset: PermissionService[] = [];
  const failures: PermissionService[] = [];
  for (const service of RECORDING_PERMISSION_SERVICES) {
    try {
      await runCommand(TCCUTIL_PATH, [
        'reset',
        service,
        SOTTO_MAC_BUNDLE_ID,
      ]);
      reset.push(service);
    } catch {
      failures.push(service);
    }
  }

  if (!reset.includes('ScreenCapture')) {
    throw new RecordingPermissionResetError(
      'macOS did not clear Sotto’s Screen & System Audio Recording entry. Open System Settings and remove the old Sotto entry manually.',
    );
  }

  // Microphone and AudioCapture service names vary across supported macOS
  // releases. ScreenCapture is the required repair; successful optional
  // resets are returned for diagnostics without turning a useful repair into
  // a failure.
  void failures;
  return reset;
};

/**
 * Clears Sotto's stale decisions before opening Apple's permission page.
 * System Settings owns the protected add/enable steps, so Sotto must remain
 * running while the user authenticates and selects the current app bundle.
 */
export const repairSottoRecordingPermissions = async ({
  resetPermissions = resetSottoRecordingPermissions,
  openSettings,
}: {
  resetPermissions?: PermissionResetter;
  openSettings: RecordingSettingsOpener;
}): Promise<PermissionService[]> => {
  const reset = await resetPermissions();
  await openSettings();
  return reset;
};
