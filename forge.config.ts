import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';

import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';
import { SOTTO_APP_BUNDLE_ID } from './src/shared/app-identity';
import { createSourceProvenance } from './scripts/source-provenance.cjs';


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

export const createWindowsSquirrelOptions = (configuredThumbprint?: string) => {
  const certificateSha1 = configuredThumbprint?.trim().toUpperCase();
  if (certificateSha1 && !/^[0-9A-F]{40}$/u.test(certificateSha1)) {
    throw new Error(
      'SOTTO_WINDOWS_SIGNING_CERTIFICATE_SHA1 must be a 40-character certificate thumbprint.',
    );
  }
  return {
    // Keep the package name lowercase for stable Squirrel update metadata while
    // productName continues to control the user-facing application name.
    name: 'sotto',
    setupIcon: './resources/Sotto.ico',
    ...(certificateSha1 ? { certificateSha1 } : {}),
  };
};

export const createMacDmgOptions = (configuredIdentity?: string) => {
  const identity = configuredIdentity?.trim();
  return {
    format: 'ULFO' as const,
    icon: './resources/Sotto.icns',
    iconSize: 128,
    ...(identity
      ? {
          additionalDMGOptions: {
            'code-sign': {
              'signing-identity': identity,
              identifier: SOTTO_APP_BUNDLE_ID,
            },
          },
        }
      : {}),
  };
};

const resolveExternalUpdateResource = (
  configuredFile: string | undefined,
  environmentName: string,
  expectedName: string,
  projectRoot: string,
): string[] => {
  const suppliedPath = configuredFile?.trim();
  if (!suppliedPath) return [];
  if (!path.isAbsolute(suppliedPath)) {
    throw new Error(`${environmentName} must be an absolute path.`);
  }
  const suppliedFile = path.resolve(suppliedPath);
  if (path.basename(suppliedFile) !== expectedName) {
    throw new Error(`${environmentName} must be named ${expectedName}.`);
  }
  if (!statSync(suppliedFile).isFile()) {
    throw new Error(`${environmentName} must name a regular file.`);
  }
  const resolvedFile = realpathSync(suppliedFile);
  const resolvedRoot = realpathSync(projectRoot);
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`${environmentName} must stay outside the repository.`);
  }
  return [resolvedFile];
};

export const resolveUpdateConfigExtraResources = (
  configuredFile?: string,
  projectRoot = process.cwd(),
): string[] =>
  resolveExternalUpdateResource(
    configuredFile,
    'SOTTO_UPDATE_CONFIG_FILE',
    'sotto-update-config.json',
    projectRoot,
  );

export const resolveUpdateCaExtraResources = (
  configuredFile?: string,
  projectRoot = process.cwd(),
): string[] =>
  resolveExternalUpdateResource(
    configuredFile,
    'SOTTO_UPDATE_CA_FILE',
    'ca.crt',
    projectRoot,
  );

export type PackageBuildReceipt = Readonly<{
  schemaVersion: 2;
  app: 'sotto';
  bundleId: typeof SOTTO_APP_BUNDLE_ID;
  version: string;
  commit: string;
  sourceState: 'clean' | 'dirty';
  sourceDigest: string;
  lockfileSha256: string;
  nodeVersion: string;
}>;

export const createPackageBuildReceipt = (
  version: string,
  provenance: Readonly<{
    commit: string;
    sourceState: 'clean' | 'dirty';
    sourceDigest: string;
  }>,
  lockfileSha256: string,
  nodeVersion: string,
): PackageBuildReceipt => {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error('The package build receipt version is invalid.');
  }
  if (!/^[0-9a-f]{40}$/u.test(provenance.commit)) {
    throw new Error('The package build receipt commit is invalid.');
  }
  if (!/^[0-9a-f]{64}$/u.test(provenance.sourceDigest)) {
    throw new Error('The package build receipt source digest is invalid.');
  }
  if (!/^[0-9a-f]{64}$/u.test(lockfileSha256)) {
    throw new Error('The package build receipt lockfile digest is invalid.');
  }
  if (!/^v\d+\.\d+\.\d+$/u.test(nodeVersion)) {
    throw new Error('The package build receipt Node version is invalid.');
  }

  return {
    schemaVersion: 2,
    app: 'sotto',
    bundleId: SOTTO_APP_BUNDLE_ID,
    version,
    commit: provenance.commit,
    sourceState: provenance.sourceState,
    sourceDigest: provenance.sourceDigest,
    lockfileSha256,
    nodeVersion,
  };
};

export const createWritePackageBuildReceiptHook = (
  receipt: PackageBuildReceipt,
) =>
  (
    buildPath: string,
    _electronVersion: string,
    platform: string,
    arch: string,
    callback: (error?: Error | null) => void,
  ): void => {
    void Promise.resolve()
      .then(() =>
        writeFile(
          path.join(
            resolvePackagedResourcesPath(buildPath, platform, arch),
            'sotto-build.json',
          ),
          `${JSON.stringify(receipt, null, 2)}\n`,
          { mode: 0o644 },
        ),
      )
      .then(
        () => callback(),
        (error: unknown) =>
          callback(
            error instanceof Error
              ? error
              : new Error('Could not write the package build receipt.'),
          ),
      );
  };

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

const staleBundledModelPaths = async (resourcesPath: string): Promise<string[]> => {
  let entries: string[];
  try {
    entries = await readdir(path.join(resourcesPath, 'models'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  return entries
    .filter((entry) => /^ggml-[a-z0-9][a-z0-9.-]*\.bin$/u.test(entry))
    .map((entry) => path.join(resourcesPath, 'models', entry));
};

export const pruneUnusedNativeResources = (
  buildPath: string,
  _electronVersion: string,
  platform: string,
  arch: string,
  callback: (error?: Error | null) => void,
): void => {
  void Promise.resolve()
    .then(async () => {
      const resourcesPath = resolvePackagedResourcesPath(buildPath, platform, arch);
      const [unusedPaths, staleModels] = await Promise.all([
        Promise.resolve(unusedNativeResourcePaths(platform, arch)),
        staleBundledModelPaths(resourcesPath),
      ]);
      await Promise.all([
        ...unusedPaths.map((resourcePath) =>
          rm(path.join(resourcesPath, resourcePath), {
            force: true,
            recursive: true,
          }),
        ),
        ...staleModels.map((modelPath) => rm(modelPath, { force: true })),
      ]);
    })
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
const updateConfigExtraResources = resolveUpdateConfigExtraResources(
  process.env.SOTTO_UPDATE_CONFIG_FILE,
);
const updateCaExtraResources = resolveUpdateCaExtraResources(
  process.env.SOTTO_UPDATE_CA_FILE,
);
const sourcePackage = JSON.parse(
  readFileSync(path.join(__dirname, 'package.json'), 'utf8'),
) as { version: string };
const projectSourceProvenance = createSourceProvenance(__dirname);
if (
  process.env.SOTTO_REQUIRE_CLEAN_SOURCE === '1' &&
  projectSourceProvenance.sourceState !== 'clean'
) {
  throw new Error('Release packaging requires a clean source checkout.');
}
const packageBuildReceipt = createPackageBuildReceipt(
  sourcePackage.version,
  projectSourceProvenance,
  createHash('sha256')
    .update(readFileSync(path.join(__dirname, 'package-lock.json')))
    .digest('hex'),
  process.version,
);
const writePackageBuildReceipt =
  createWritePackageBuildReceiptHook(packageBuildReceipt);

assertMacReleaseConfiguration({
  releaseRequested: process.env.SOTTO_MAC_RELEASE === '1',
  signingIdentity: macSigningIdentity,
  notaryKeychainProfile: macNotaryKeychainProfile,
});

const config: ForgeConfig = {
  packagerConfig: {
    appBundleId: SOTTO_APP_BUNDLE_ID,
    appCategoryType: 'public.app-category.productivity',
    asar: true,
    // Electron Packager selects Sotto.icns on macOS and Sotto.ico on Windows
    // when the extension is omitted.
    icon: './resources/Sotto',
    extendInfo: {
      NSAudioCaptureUsageDescription:
        'Sotto captures system audio only when you start a live meeting recording.',
      NSMicrophoneUsageDescription:
        'Sotto captures your microphone only when you start a meeting recording or dictation.',
      NSScreenCaptureUsageDescription:
        'Sotto captures the screen only to receive system audio when you start a live meeting recording.',
    },
    // Local packages are ad-hoc signed. Set SOTTO_MAC_SIGNING_IDENTITY to a
    // Developer ID Application identity for hardened distribution builds.
    osxSign: createMacSignOptions(macSigningIdentity),
    // Public releases use a named notarytool credential profile stored in the
    // macOS Keychain. Local ad-hoc packages deliberately skip notarization.
    osxNotarize: createMacNotarizeOptions(macNotaryKeychainProfile),
    extraResource: [
      './resources/diarization',
      './resources/sidecars',
      './resources/speaker-runtime',
      './scripts/speaker-diarization-child.cjs',
      ...updateConfigExtraResources,
      ...updateCaExtraResources,
    ],
    // Flip the copied Electron binary before ASAR finalization and before the
    // platform packager signs or notarizes the completed application.
    afterCopy: [flipElectronFusesAfterCopy],
    afterCopyExtraResources: [
      pruneUnusedNativeResources,
      writePackageBuildReceipt,
    ],
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel(
      createWindowsSquirrelOptions(
        process.env.SOTTO_WINDOWS_SIGNING_CERTIFICATE_SHA1,
      ),
    ),
    // ZIP has no host-specific tooling, so it is also the portable Windows
    // artifact that can be assembled from a macOS development machine.
    new MakerZIP({}, ['darwin', 'win32']),
    // The DMG is the primary macOS download: users open it and drag Sotto
    // into Applications. Keep the ZIP as an alternate/update artifact.
    new MakerDMG(
      createMacDmgOptions(macSigningIdentity),
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
