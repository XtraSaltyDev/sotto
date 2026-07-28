import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';

export const createMacSignOptions = (configuredIdentity?: string) => {
  const identity = configuredIdentity?.trim();
  const hasDeveloperIdentity = Boolean(identity);

  return {
    identity: identity || '-',
    identityValidation: hasDeveloperIdentity,
    // macOS 26 enforces library validation for Hardened Runtime processes.
    // Separately ad-hoc-signed Electron components have no shared Apple Team
    // ID, so a hardened local build cannot load Electron Framework. A real
    // Developer ID signs every component with one team and keeps the runtime.
    optionsForFile: () => ({ hardenedRuntime: hasDeveloperIdentity }),
  };
};

const config: ForgeConfig = {
  packagerConfig: {
    appBundleId: 'com.sotto.desktop',
    appCategoryType: 'public.app-category.productivity',
    asar: true,
    icon: './resources/Sotto.icns',
    extendInfo: {
      NSAudioCaptureUsageDescription:
        'Sotto captures meeting audio only when you start a live recording.',
      NSMicrophoneUsageDescription:
        'Sotto captures your microphone only when you start a live recording.',
    },
    // Local packages are ad-hoc signed. Set SOTTO_MAC_SIGNING_IDENTITY to a
    // Developer ID Application identity for hardened distribution builds.
    osxSign: createMacSignOptions(process.env.SOTTO_MAC_SIGNING_IDENTITY),
    extraResource: [
      './resources/diarization',
      './resources/models',
      './resources/sidecars',
      './resources/speaker-runtime',
      './scripts/speaker-diarization-child.cjs',
    ],
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
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
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
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
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      resetAdHocDarwinSignature: true,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
    }),
  ],
};

export default config;
