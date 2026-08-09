import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ELECTRON_FUSE_V1_OPTIONS,
  assertMacReleaseConfiguration,
  assertSupportedPackageTarget,
  createElectronFuseConfig,
  createFlipElectronFusesAfterCopyHook,
  createMacNotarizeOptions,
  createMacDmgOptions,
  createMacSignOptions,
  createPackageBuildReceipt,
  createWritePackageBuildReceiptHook,
  createWindowsSquirrelOptions,
  pruneUnusedNativeResources,
  resolveElectronExecutablePath,
  resolvePackagedResourcesPath,
  resolveUpdateCaExtraResources,
  resolveUpdateConfigExtraResources,
  unusedNativeResourcePaths,
} from './forge.config';

describe('secure update package configuration', () => {
  it('keeps ordinary local packages usable without update configuration', () => {
    expect(resolveUpdateConfigExtraResources(undefined, '/checkout/sotto')).toEqual([]);
  });

  it('includes only an external, predictably named real file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-config-'));
    const projectRoot = path.join(root, 'checkout');
    const externalRoot = path.join(root, 'external');
    const internalFile = path.join(projectRoot, 'sotto-update-config.json');
    const externalFile = path.join(externalRoot, 'sotto-update-config.json');
    const externalSymlink = path.join(
      externalRoot,
      'linked',
      'sotto-update-config.json',
    );

    try {
      await mkdir(path.dirname(externalSymlink), { recursive: true });
      await mkdir(projectRoot, { recursive: true });
      await writeFile(internalFile, '{}');
      await writeFile(externalFile, '{}');
      await symlink(internalFile, externalSymlink);

      expect(
        resolveUpdateConfigExtraResources(externalFile, projectRoot),
      ).toEqual([await realpath(externalFile)]);
      expect(() =>
        resolveUpdateConfigExtraResources(internalFile, projectRoot),
      ).toThrow(/outside the repository/u);
      expect(() =>
        resolveUpdateConfigExtraResources(externalSymlink, projectRoot),
      ).toThrow(/outside the repository/u);
      expect(() =>
        resolveUpdateConfigExtraResources(
          path.join(externalRoot, 'keys.json'),
          projectRoot,
        ),
      ).toThrow(/sotto-update-config\.json/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('embeds only an external, predictably named public update CA', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-ca-'));
    const projectRoot = path.join(root, 'checkout');
    const externalRoot = path.join(root, 'external');
    const externalFile = path.join(externalRoot, 'ca.crt');
    const internalFile = path.join(projectRoot, 'ca.crt');

    try {
      await mkdir(projectRoot, { recursive: true });
      await mkdir(externalRoot, { recursive: true });
      await writeFile(externalFile, 'public CA certificate');
      await writeFile(internalFile, 'public CA certificate');

      expect(resolveUpdateCaExtraResources(externalFile, projectRoot)).toEqual([
        await realpath(externalFile),
      ]);
      expect(() =>
        resolveUpdateCaExtraResources(internalFile, projectRoot),
      ).toThrow(/outside the repository/u);
      expect(() =>
        resolveUpdateCaExtraResources(
          path.join(externalRoot, 'trust.pem'),
          projectRoot,
        ),
      ).toThrow(/ca\.crt/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe('package build receipt', () => {
  it('writes authenticated source identity into the packaged resources', async () => {
    const buildPath = await mkdtemp(path.join(os.tmpdir(), 'sotto-receipt-'));
    const resourcesPath = resolvePackagedResourcesPath(
      buildPath,
      'darwin',
      'arm64',
    );
    await mkdir(resourcesPath, { recursive: true });
    const receipt = createPackageBuildReceipt(
      '0.2.0',
      {
        commit: '0123456789abcdef0123456789abcdef01234567',
        sourceState: 'clean',
        sourceDigest: 'a'.repeat(64),
      },
      'b'.repeat(64),
      'v24.19.0',
    );
    const hook = createWritePackageBuildReceiptHook(receipt);

    try {
      await new Promise<void>((resolve, reject) => {
        hook(buildPath, '43.2.0', 'darwin', 'arm64', (error) => {
          if (error) reject(error);
          else resolve();
        });
      });

      await expect(
        readFile(path.join(resourcesPath, 'sotto-build.json'), 'utf8'),
      ).resolves.toBe(`${JSON.stringify(receipt, null, 2)}\n`);
    } finally {
      await rm(buildPath, { force: true, recursive: true });
    }
  });
});

describe('macOS package signing', () => {
  it('signs the release DMG with the same Developer ID identity', () => {
    expect(createMacDmgOptions()).not.toHaveProperty('additionalDMGOptions');
    expect(
      createMacDmgOptions(
        '  Developer ID Application: Example Company (ABCDE12345)  ',
      ),
    ).toMatchObject({
      additionalDMGOptions: {
        'code-sign': {
          'signing-identity':
            'Developer ID Application: Example Company (ABCDE12345)',
          identifier: 'com.sotto.desktop',
        },
      },
    });
  });

  it('keeps ad-hoc local packages launchable without library validation', () => {
    const options = createMacSignOptions();

    expect(options).toMatchObject({
      continueOnError: false,
      identity: '-',
      identityValidation: false,
    });
    expect(options.optionsForFile()).toEqual({ hardenedRuntime: false });
  });

  it('keeps Hardened Runtime for a real Developer ID build', () => {
    const options = createMacSignOptions(
      '  Developer ID Application: Example Company (ABCDE12345)  ',
    );

    expect(options).toMatchObject({
      continueOnError: false,
      identity: 'Developer ID Application: Example Company (ABCDE12345)',
      identityValidation: true,
    });
    expect(options.optionsForFile()).toEqual({ hardenedRuntime: true });
  });

  it('only enables notarization for a named Keychain profile', () => {
    expect(createMacNotarizeOptions()).toBeUndefined();
    expect(createMacNotarizeOptions('   ')).toBeUndefined();
    expect(createMacNotarizeOptions('  sotto-release  ')).toEqual({
      keychainProfile: 'sotto-release',
    });
  });

  it('fails closed when release signing or notarization is missing', () => {
    expect(() =>
      assertMacReleaseConfiguration({ releaseRequested: false }),
    ).not.toThrow();
    expect(() =>
      assertMacReleaseConfiguration({
        releaseRequested: true,
        signingIdentity: 'Developer ID Application: Example Company (ABCDE12345)',
      }),
    ).toThrow(/SOTTO_MAC_NOTARY_KEYCHAIN_PROFILE/u);
    expect(() =>
      assertMacReleaseConfiguration({
        releaseRequested: true,
        notaryKeychainProfile: 'sotto-release',
      }),
    ).toThrow(/SOTTO_MAC_SIGNING_IDENTITY/u);
    expect(() =>
      assertMacReleaseConfiguration({
        releaseRequested: true,
        signingIdentity: 'Apple Development: Example Company (ABCDE12345)',
        notaryKeychainProfile: 'sotto-release',
      }),
    ).toThrow(/Developer ID Application/u);
    expect(() =>
      assertMacReleaseConfiguration({
        releaseRequested: true,
        signingIdentity: 'Developer ID Application: Example Company (ABCDE12345)',
        notaryKeychainProfile: 'sotto-release',
      }),
    ).not.toThrow();
  });
});

describe('Windows packaging', () => {
  it('uses the Sotto icon and a stable lowercase Squirrel package name', () => {
    expect(createWindowsSquirrelOptions()).toEqual({
      name: 'sotto',
      setupIcon: './resources/Sotto.ico',
    });
    expect(
      createWindowsSquirrelOptions(
        '0123456789abcdef0123456789abcdef01234567',
      ),
    ).toMatchObject({
      certificateSha1: '0123456789ABCDEF0123456789ABCDEF01234567',
    });
    expect(() => createWindowsSquirrelOptions('not-a-thumbprint')).toThrow(
      /40-character certificate thumbprint/u,
    );
  });

  it('removes native payloads for the other operating system', () => {
    expect(unusedNativeResourcePaths('win32', 'x64')).toEqual([
      'sidecars/darwin-arm64',
      'sidecars/darwin-x64',
      'speaker-runtime/sherpa-onnx-darwin-arm64',
    ]);
    expect(unusedNativeResourcePaths('darwin', 'arm64')).toEqual([
      'sidecars/darwin-x64',
      'sidecars/win32-x64',
      'speaker-runtime/sherpa-onnx-win-x64',
    ]);
  });

  it('resolves each platform package resource directory', () => {
    expect(
      resolvePackagedResourcesPath('/tmp/Sotto.app', 'darwin', 'arm64'),
    ).toBe(
      path.join('/tmp/Sotto.app', 'Sotto.app', 'Contents', 'Resources'),
    );
    expect(resolvePackagedResourcesPath('/tmp/Sotto', 'win32', 'x64')).toBe(
      path.join('/tmp/Sotto', 'resources'),
    );
  });

  it('prunes foreign runtimes from the macOS bundle resource directory', async () => {
    const buildPath = await mkdtemp(path.join(os.tmpdir(), 'sotto-prune-'));
    const resourcesPath = resolvePackagedResourcesPath(
      buildPath,
      'darwin',
      'arm64',
    );
    const nativeMacRuntime = path.join(
      resourcesPath,
      'sidecars',
      'darwin-arm64',
    );
    const foreignWindowsRuntime = path.join(
      resourcesPath,
      'sidecars',
      'win32-x64',
    );

    try {
      await Promise.all([
        mkdir(nativeMacRuntime, { recursive: true }),
        mkdir(foreignWindowsRuntime, { recursive: true }),
        mkdir(path.join(resourcesPath, 'models'), { recursive: true }),
      ]);
      await writeFile(
        path.join(resourcesPath, 'models', 'ggml-large-v3-turbo.bin'),
        'bundled turbo',
      );
      await writeFile(
        path.join(resourcesPath, 'models', 'ggml-small.en.bin'),
        'stale small',
      );

      await new Promise<void>((resolve, reject) => {
        pruneUnusedNativeResources(
          buildPath,
          '43.2.0',
          'darwin',
          'arm64',
          (error) => {
            if (error) reject(error);
            else resolve();
          },
        );
      });

      await expect(access(nativeMacRuntime)).resolves.toBeUndefined();
      await expect(access(foreignWindowsRuntime)).rejects.toThrow();
      await expect(
        access(path.join(resourcesPath, 'models', 'ggml-large-v3-turbo.bin')),
      ).resolves.toBeUndefined();
      await expect(
        access(path.join(resourcesPath, 'models', 'ggml-small.en.bin')),
      ).rejects.toThrow();
    } finally {
      await rm(buildPath, { force: true, recursive: true });
    }
  });

  it('fails closed for package targets without a qualified runtime', () => {
    expect(() => assertSupportedPackageTarget('darwin', 'arm64')).not.toThrow();
    expect(() => assertSupportedPackageTarget('win32', 'x64')).not.toThrow();
    expect(() => assertSupportedPackageTarget('darwin', 'x64')).toThrow(
      /Unsupported Sotto package target: darwin-x64/u,
    );
    expect(() => assertSupportedPackageTarget('win32', 'arm64')).toThrow(
      /Unsupported Sotto package target: win32-arm64/u,
    );
    expect(() => assertSupportedPackageTarget('linux', 'x64')).toThrow(
      /Unsupported Sotto package target: linux-x64/u,
    );
  });

  it('reports an unsupported package target through the Forge hook callback', async () => {
    await expect(
      new Promise<void>((resolve, reject) => {
        pruneUnusedNativeResources(
          '/unused/build/path',
          '43.2.0',
          'linux',
          'x64',
          (error) => {
            if (error) reject(error);
            else resolve();
          },
        );
      }),
    ).rejects.toThrow(/Unsupported Sotto package target: linux-x64/u);
  });
});

describe('Electron package fuses', () => {
  it('defines every Electron 43 fuse and fails on future schema changes', () => {
    expect(ELECTRON_FUSE_V1_OPTIONS).toEqual({
      RunAsNode: 0,
      EnableCookieEncryption: 1,
      EnableNodeOptionsEnvironmentVariable: 2,
      EnableNodeCliInspectArguments: 3,
      EnableEmbeddedAsarIntegrityValidation: 4,
      OnlyLoadAppFromAsar: 5,
      LoadBrowserProcessSpecificV8Snapshot: 6,
      GrantFileProtocolExtraPrivileges: 7,
      WasmTrapHandlers: 8,
    });
    expect(createElectronFuseConfig()).toEqual({
      version: '1',
      strictlyRequireAllFuses: true,
      [ELECTRON_FUSE_V1_OPTIONS.RunAsNode]: false,
      [ELECTRON_FUSE_V1_OPTIONS.EnableCookieEncryption]: true,
      [ELECTRON_FUSE_V1_OPTIONS.EnableNodeOptionsEnvironmentVariable]: false,
      [ELECTRON_FUSE_V1_OPTIONS.EnableNodeCliInspectArguments]: false,
      [ELECTRON_FUSE_V1_OPTIONS.EnableEmbeddedAsarIntegrityValidation]: true,
      [ELECTRON_FUSE_V1_OPTIONS.OnlyLoadAppFromAsar]: true,
      [ELECTRON_FUSE_V1_OPTIONS.LoadBrowserProcessSpecificV8Snapshot]: false,
      [ELECTRON_FUSE_V1_OPTIONS.GrantFileProtocolExtraPrivileges]: true,
      [ELECTRON_FUSE_V1_OPTIONS.WasmTrapHandlers]: true,
    });
  });

  it('resolves the copied Electron executable for each supported target', () => {
    const buildPath = path.join('/temporary', 'Electron.app', 'Contents', 'Resources', 'app');
    const bundleRoot = path.resolve(buildPath, '..', '..');

    expect(resolveElectronExecutablePath(buildPath, 'darwin', 'arm64')).toBe(
      path.join(bundleRoot, 'MacOS', 'Electron'),
    );
    expect(resolveElectronExecutablePath(buildPath, 'win32', 'x64')).toBe(
      path.join(bundleRoot, 'electron.exe'),
    );
  });

  it('flips the copied Electron binary and completes the Forge callback', async () => {
    const fuseFlipper = vi.fn(async () => 1);
    const hook = createFlipElectronFusesAfterCopyHook(fuseFlipper);
    const buildPath = path.join('/temporary', 'Sotto-win32-x64', 'resources', 'app');

    await new Promise<void>((resolve, reject) => {
      hook(buildPath, '43.2.0', 'win32', 'x64', (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    expect(fuseFlipper).toHaveBeenCalledOnce();
    expect(fuseFlipper).toHaveBeenCalledWith(
      path.join(path.resolve(buildPath, '..', '..'), 'electron.exe'),
      createElectronFuseConfig(),
    );
  });

  it('propagates fuse failures through the Forge callback', async () => {
    const expectedError = new Error('Fuse write failed.');
    const hook = createFlipElectronFusesAfterCopyHook(async () => {
      throw expectedError;
    });

    await expect(
      new Promise<void>((resolve, reject) => {
        hook(
          path.join('/temporary', 'Electron.app', 'Contents', 'Resources', 'app'),
          '43.2.0',
          'darwin',
          'arm64',
          (error) => {
            if (error) reject(error);
            else resolve();
          },
        );
      }),
    ).rejects.toBe(expectedError);
  });
});
