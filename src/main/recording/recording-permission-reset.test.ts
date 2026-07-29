import { describe, expect, it, vi } from 'vitest';

import {
  RECORDING_PERMISSION_SERVICES,
  repairSottoRecordingPermissions,
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

describe('repairSottoRecordingPermissions', () => {
  it('opens System Settings only after Sotto permissions are cleared', async () => {
    const calls: string[] = [];

    await expect(repairSottoRecordingPermissions({
      resetPermissions: async () => {
        calls.push('reset');
        return ['ScreenCapture'];
      },
      openSettings: async () => {
        calls.push('settings');
      },
    })).resolves.toEqual(['ScreenCapture']);

    expect(calls).toEqual(['reset', 'settings']);
  });

  it('does not open System Settings when the reset fails', async () => {
    const openSettings = vi.fn();

    await expect(repairSottoRecordingPermissions({
      resetPermissions: async () => {
        throw new RecordingPermissionResetError();
      },
      openSettings,
    })).rejects.toBeInstanceOf(RecordingPermissionResetError);

    expect(openSettings).not.toHaveBeenCalled();
  });
});
