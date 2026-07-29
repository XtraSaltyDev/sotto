import { rm } from 'node:fs/promises';
import path from 'node:path';

import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';

import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';

export const createMacSignOptions = (configuredIdentity?: string) => {
  const identity = configuredIdentity?.trim();
  const hasDeveloperIdentity = Boolean(identity);

  return {
    // A release must never fall back to an ad-hoc artifact after signing fails.
    continueOnError: false,
    identity: identity || '-',
    identityValidation: hasDeveloperIdentity,
    // macOS 26 enforces library validation for Hardened Runtime processes.
    // Separately ad-hoc-signed Electron components have no shared Apple Team
    // ID, so a hardened local build cannot load Electron Framework. A real
    // Developer ID signs every component with one team and keeps the runtime.
    optionsForFile: () => ({ hardenedRuntime: hasDeveloperIdentity }),
  };
};

export const createMacNotarizeOptions = (configuredProfile?: string) => {
  const keychainProfile = configuredProfile?.trim();
  return keychainProfile ? { keychainProfile } : undefined;
};

export const createWindowsSquirrelOptions = () => ({
  // Keep the package name lowercase for stable Squirrel update metadata while
  // productName continues to control the user-facing application name.
  name: 'sotto',
  setupIcon: './resources/Sotto.ico',
});

export const assertSupportedPackageTarget = (
  platform: string,
  arch: string,
): void => {
  if (
    (platform === 'darwin' && arch === 'arm64') ||
    (platform === 'win32' && arch === 'x64')
  ) {
    return;
  }

  throw new Error(
    `Unsupported Sotto package target: ${platform}-${arch}. Supported targets are darwin-arm64 and win32-x64.`,
  );
};

export const unusedNativeResourcePaths = (
  platform: string,
  arch: string,
): string[] => {
  assertSupportedPackageTarget(platform, arch);

  if (platform === 'win32' && arch === 'x64') {
    return [
      path.join('sidecars', 'darwin-arm64'),
      path.join('sidecars', 'darwin-x64'),
      path.join('speaker-runtime', 'sherpa-onnx-darwin-arm64'),
    ];
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return [
      path.join('sidecars', 'darwin-x64'),
      path.join('sidecars', 'win32-x64'),
      path.join('speaker-runtime', 'sherpa-onnx-win-x64'),
    ];
  }

  // assertSupportedPackageTarget keeps this branch unreachable while retaining
  // an explicit return for TypeScript's control-flow analysis.
  return [];
};

export const resolvePackagedResourcesPath = (
  buildPath: string,
  platform: string,
  arch: string,
): string => {
  assertSupportedPackageTarget(platform, arch);

  // afterCopyExtraResources receives Packager's staging directory. Windows
  // stages its resources directly there; macOS stages the renamed .app bundle
  // one level below it. Keeping this distinction here prevents foreign
  // runtimes from silently surviving in the finished Mac bundle.
  return platform === 'darwin'
    ? path.join(buildPath, 'Sotto.app', 'Contents', 'Resources')
    : path.join(buildPath, 'resources');
};

export const pruneUnusedNativeResources = (
  buildPath: string,
  _electronVersion: string,
  platform: string,
  arch: string,
  callback: (error?: Error | null) => void,
): void => {
  void Promise.resolve()
    .then(() => ({
      resourcesPath: resolvePackagedResourcesPath(buildPath, platform, arch),
      unusedPaths: unusedNativeResourcePaths(platform, arch),
    }))
    .then(({ resourcesPath, unusedPaths }) =>
      Promise.all(
        unusedPaths.map((resourcePath) =>
          rm(path.join(resourcesPath, resourcePath), {
            force: true,
            recursive: true,
          }),
        ),
      ),
    )
    .then(
      () => callback(),
      (error: unknown) =>
        callback(
          error instanceof Error
            ? error
            : new Error('Could not prune unused native package resources.'),
        ),
    );
};

export const ELECTRON_FUSE_V1_OPTIONS = {
  RunAsNode: 0,
  EnableCookieEncryption: 1,
  EnableNodeOptionsEnvironmentVariable: 2,
  EnableNodeCliInspectArguments: 3,
  EnableEmbeddedAsarIntegrityValidation: 4,
  OnlyLoadAppFromAsar: 5,
  LoadBrowserProcessSpecificV8Snapshot: 6,
  GrantFileProtocolExtraPrivileges: 7,
  WasmTrapHandlers: 8,
} as const;

type ElectronFuseV1Index =
  (typeof ELECTRON_FUSE_V1_OPTIONS)[keyof typeof ELECTRON_FUSE_V1_OPTIONS];

export type ElectronFuseV1Config = {
  readonly version: '1';
  readonly strictlyRequireAllFuses: true;
} & Readonly<Record<ElectronFuseV1Index, boolean>>;

type FuseFlipper = (
  electronExecutablePath: string,
  config: ElectronFuseV1Config,
) => Promise<unknown>;

export const createElectronFuseConfig = (): ElectronFuseV1Config => ({
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

export const resolveElectronExecutablePath = (
  buildPath: string,
  platform: string,
  arch: string,
): string => {
  assertSupportedPackageTarget(platform, arch);
  const bundleRoot = path.resolve(buildPath, '..', '..');

  return platform === 'darwin'
    ? path.join(bundleRoot, 'MacOS', 'Electron')
    : path.join(bundleRoot, 'electron.exe');
};

export const createFlipElectronFusesAfterCopyHook = (
  fuseFlipper?: FuseFlipper,
) =>
  (
    buildPath: string,
    _electronVersion: string,
    platform: string,
    arch: string,
    callback: (error?: Error | null) => void,
  ): void => {
    void Promise.resolve()
      .then(async () => {
        const electronExecutablePath = resolveElectronExecutablePath(
          buildPath,
          platform,
          arch,
        );
        if (fuseFlipper) {
          return fuseFlipper(
            electronExecutablePath,
            createElectronFuseConfig(),
          );
        }

        // @electron/fuses 2.x is ESM-only, while Forge loads this TypeScript
        // config as CommonJS. Native dynamic import preserves that boundary.
        // eslint-disable-next-line import/no-unresolved -- The legacy resolver cannot read this ESM package's export map.
        const { flipFuses, FuseVersion } = await import('@electron/fuses');
        return flipFuses(
          electronExecutablePath,
          {
            ...createElectronFuseConfig(),
            version: FuseVersion.V1,
          },
        );
      })
      .then(
        () => callback(),
        (error: unknown) =>
          callback(
            error instanceof Error
              ? error
              : new Error('Could not configure the Electron package fuses.'),
          ),
      );
  };

export const flipElectronFusesAfterCopy =
  createFlipElectronFusesAfterCopyHook();

export const assertMacReleaseConfiguration = ({
  releaseRequested,
  signingIdentity,
  notaryKeychainProfile,
}: {
  releaseRequested: boolean;
  signingIdentity?: string;
  notaryKeychainProfile?: string;
}): void => {
  if (!releaseRequested) return;

  const identity = signingIdentity?.trim();
  const keychainProfile = notaryKeychainProfile?.trim();
  if (!identity || !keychainProfile) {
    throw new Error(
      'A Sotto macOS release requires SOTTO_MAC_SIGNING_IDENTITY and SOTTO_MAC_NOTARY_KEYCHAIN_PROFILE.',
    );
  }
  if (!identity.startsWith('Developer ID Application:')) {
    throw new Error(
      'SOTTO_MAC_SIGNING_IDENTITY must be a Developer ID Application identity.',
    );
  }
};

const macSigningIdentity = process.env.SOTTO_MAC_SIGNING_IDENTITY;
const macNotaryKeychainProfile =
  process.env.SOTTO_MAC_NOTARY_KEYCHAIN_PROFILE;

assertMacReleaseConfiguration({
  releaseRequested: process.env.SOTTO_MAC_RELEASE === '1',
  signingIdentity: macSigningIdentity,
  notaryKeychainProfile: macNotaryKeychainProfile,
});

const config: ForgeConfig = {
  packagerConfig: {
    appBundleId: 'com.sotto.desktop',
    appCategoryType: 'public.app-category.productivity',
    asar: true,
    // Electron Packager selects Sotto.icns on macOS and Sotto.ico on Windows
    // when the extension is omitted.
    icon: './resources/Sotto',
    extendInfo: {
      NSAudioCaptureUsageDescription:
        'Sotto captures meeting audio only when you start a live recording.',
      NSMicrophoneUsageDescription:
        'Sotto captures your microphone only when you start a live recording.',
    },
    // Local packages are ad-hoc signed. Set SOTTO_MAC_SIGNING_IDENTITY to a
    // Developer ID Application identity for hardened distribution builds.
    osxSign: createMacSignOptions(macSigningIdentity),
    // Public releases use a named notarytool credential profile stored in the
    // macOS Keychain. Local ad-hoc packages deliberately skip notarization.
    osxNotarize: createMacNotarizeOptions(macNotaryKeychainProfile),
    extraResource: [
      './resources/diarization',
      './resources/models',
      './resources/sidecars',
      './resources/speaker-runtime',
      './scripts/speaker-diarization-child.cjs',
    ],
    // Flip the copied Electron binary before ASAR finalization and before the
    // platform packager signs or notarizes the completed application.
    afterCopy: [flipElectronFusesAfterCopy],
    afterCopyExtraResources: [pruneUnusedNativeResources],
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel(createWindowsSquirrelOptions()),
    // ZIP has no host-specific tooling, so it is also the portable Windows
    // artifact that can be assembled from a macOS development machine.
    new MakerZIP({}, ['darwin', 'win32']),
    // The DMG is the primary macOS download: users open it and drag Sotto
    // into Applications. Keep the ZIP as an alternate/update artifact.
    new MakerDMG(
      {
        format: 'ULFO',
        icon: './resources/Sotto.icns',
        // 128 px keeps both the app and Applications shortcut legible in the
        // standard 658x498 DMG window without crowding the layout.
        iconSize: 128,
      },
      ['darwin'],
    ),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
      devContentSecurityPolicy:
        "default-src 'self' 'unsafe-inline' data:; script-src 'self' 'unsafe-eval' 'unsafe-inline' data:; media-src 'self' sotto-media:;",
      mainConfig,
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: './src/index.html',
            js: './src/renderer.tsx',
            name: 'main_window',
            preload: {
              js: './src/preload.ts',
            },
          },
        ],
      },
    }),
  ],
};

export default config;
