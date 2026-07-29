import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  requestMacScreenRecordingAccess,
  resolveMacScreenPermissionHelperPath,
} from './macos-screen-recording-access';

describe('macOS screen recording access', () => {
  it('resolves the helper from packaged resources', () => {
    expect(resolveMacScreenPermissionHelperPath({
      appPath: '/Applications/Sotto.app/Contents/Resources/app.asar',
      isPackaged: true,
      resourcesPath: '/Applications/Sotto.app/Contents/Resources',
    })).toBe(path.join(
      '/Applications/Sotto.app/Contents/Resources',
      'sidecars',
      'darwin-arm64',
      'sotto-screen-permission-request',
    ));
  });

  it('resolves the helper from the source tree during development', () => {
    expect(resolveMacScreenPermissionHelperPath({
      appPath: '/work/sotto',
      isPackaged: false,
      resourcesPath: '/Electron.app/Contents/Resources',
    })).toBe(path.join(
      '/work/sotto/resources',
      'sidecars',
      'darwin-arm64',
      'sotto-screen-permission-request',
    ));
  });

  it('returns the native permission decision', async () => {
    const runHelper = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(2);
    const options = {
      appPath: '/work/sotto',
      isPackaged: false,
      platform: 'darwin' as const,
      resourcesPath: '/resources',
      runHelper,
    };

    await expect(requestMacScreenRecordingAccess(options)).resolves.toBe(true);
    await expect(requestMacScreenRecordingAccess(options)).resolves.toBe(false);
    expect(runHelper).toHaveBeenCalledWith(
      '/work/sotto/resources/sidecars/darwin-arm64/sotto-screen-permission-request',
      [],
    );
  });

  it('does not run the macOS helper on other platforms', async () => {
    const runHelper = vi.fn();
    await expect(requestMacScreenRecordingAccess({
      appPath: '/work/sotto',
      isPackaged: false,
      platform: 'win32',
      resourcesPath: '/resources',
      runHelper,
    })).resolves.toBe(false);
    expect(runHelper).not.toHaveBeenCalled();
  });

  it('rejects unexpected helper failures', async () => {
    await expect(requestMacScreenRecordingAccess({
      appPath: '/work/sotto',
      isPackaged: false,
      platform: 'darwin',
      resourcesPath: '/resources',
      runHelper: vi.fn().mockResolvedValue(9),
    })).rejects.toThrow('exited with code 9');
  });
});
