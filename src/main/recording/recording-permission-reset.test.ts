import { describe, expect, it, vi } from 'vitest';

import {
  RECORDING_PERMISSION_SERVICES,
  RecordingPermissionResetError,
  SOTTO_MAC_BUNDLE_ID,
  TCCUTIL_PATH,
  resetSottoRecordingPermissions,
} from './recording-permission-reset';

describe('resetSottoRecordingPermissions', () => {
  it('resets only Sotto recording services with fixed tccutil arguments', async () => {
    const runCommand = vi.fn(async () => undefined);

    await expect(resetSottoRecordingPermissions({
      platform: 'darwin',
      runCommand,
    })).resolves.toEqual(RECORDING_PERMISSION_SERVICES);
    expect(runCommand.mock.calls).toEqual(
      RECORDING_PERMISSION_SERVICES.map((service) => [
        TCCUTIL_PATH,
        ['reset', service, SOTTO_MAC_BUNDLE_ID],
      ]),
    );
  });

  it('accepts a ScreenCapture reset when newer optional services are unavailable', async () => {
    const runCommand = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[1] !== 'ScreenCapture') throw new Error('unsupported service');
    });

    await expect(resetSottoRecordingPermissions({
      platform: 'darwin',
      runCommand,
    })).resolves.toEqual(['ScreenCapture']);
  });

  it('fails safely off macOS or when ScreenCapture cannot be reset', async () => {
    await expect(resetSottoRecordingPermissions({
      platform: 'win32',
      runCommand: async () => undefined,
    })).rejects.toBeInstanceOf(RecordingPermissionResetError);
    await expect(resetSottoRecordingPermissions({
      platform: 'darwin',
      runCommand: async () => {
        throw new Error('reset failed');
      },
    })).rejects.toThrow('remove the old Sotto entry manually');
  });
});
