#!/usr/bin/env node

import { createHash, X509Certificate } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { extractFile } from '@electron/asar';

import updateConfig from '../src/main/updates/update-config.cjs';
import packageBuildReceipt from './package-build-receipt.cjs';
import sourceProvenance from './source-provenance.cjs';

const { parseUpdateConfiguration } = updateConfig;
const { validatePackageBuildReceipt } = packageBuildReceipt;
const { createSourceProvenance } = sourceProvenance;

const [target, suppliedAppPath] = process.argv.slice(2);
const targets = {
  'darwin-arm64': {
    appPath: 'out/Sotto-darwin-arm64/Sotto.app',
    manifestDirectory: 'darwin-arm64',
    resources: ['Contents', 'Resources'],
    required: [
      'sidecars/darwin-arm64/ffmpeg',
      'sidecars/darwin-arm64/sotto-screen-permission-request',
      'sidecars/darwin-arm64/whisper-cli',
      'speaker-runtime/sherpa-onnx-darwin-arm64/sherpa-onnx.node',
      'speaker-runtime/sherpa-onnx-darwin-arm64/libonnxruntime.dylib',
    ],
    forbidden: [
      'sidecars/darwin-x64',
      'sidecars/win32-x64',
      'speaker-runtime/sherpa-onnx-win-x64',
    ],
  },
  'win32-x64': {
    appPath: 'out/Sotto-win32-x64',
    manifestDirectory: 'win32-x64',
    resources: ['resources'],
    required: [
      'sidecars/win32-x64/ffmpeg.exe',
      'sidecars/win32-x64/whisper-cli.exe',
      'speaker-runtime/sherpa-onnx-win-x64/sherpa-onnx.node',
      'speaker-runtime/sherpa-onnx-win-x64/onnxruntime.dll',
    ],
    forbidden: [
      'sidecars/darwin-arm64',
      'sidecars/darwin-x64',
      'speaker-runtime/sherpa-onnx-darwin-arm64',
    ],
  },
};

const configuration = targets[target];
if (!configuration) {
  throw new Error(
    'Usage: node scripts/verify-packaged-app.mjs <darwin-arm64|win32-x64> [app-path]',
  );
}

const appPath = path.resolve(suppliedAppPath ?? configuration.appPath);
const resourcesPath = path.join(appPath, ...configuration.resources);
const manifestPath = path.join(
  resourcesPath,
  'sidecars',
  configuration.manifestDirectory,
  'runtime-manifest.json',
);
const updateConfigPath = path.join(resourcesPath, 'sotto-update-config.json');
const buildReceiptPath = path.join(resourcesPath, 'sotto-build.json');
const updateCaPath = path.join(resourcesPath, 'ca.crt');

const requirePath = async (relativePath) => {
  await access(path.join(resourcesPath, relativePath));
};

const rejectPath = async (relativePath) => {
  try {
    await access(path.join(resourcesPath, relativePath));
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Foreign package resource was not pruned: ${relativePath}`);
};

const sha256 = async (filePath) =>
  createHash('sha256').update(await readFile(filePath)).digest('hex');

const verifyHash = async (filePath, expectedHash) => {
  const actualHash = await sha256(filePath);
  if (actualHash !== expectedHash) {
    throw new Error(
      `SHA-256 mismatch for ${filePath}: expected ${expectedHash}, received ${actualHash}`,
    );
  }
};

const commonRequiredPaths = [
  'app.asar',
  'sotto-build.json',
  'diarization/3dspeaker-eres2net-base.onnx',
  'diarization/pyannote-segmentation-3.0.onnx',
  'sidecars/PROVENANCE.md',
  'sidecars/THIRD_PARTY_NOTICES.md',
  'sidecars/licenses/3D-Speaker.Apache-2.0.LICENSE',
  'sidecars/licenses/onnxruntime.LICENSE',
  'sidecars/licenses/onnxruntime.ThirdPartyNotices.txt',
  'sidecars/licenses/openai-whisper-model.LICENSE',
  'sidecars/licenses/pyannote-segmentation-3.0.LICENSE',
  'sidecars/licenses/sherpa-onnx.Apache-2.0.LICENSE',
  'speaker-diarization-child.cjs',
  'speaker-runtime/sherpa-onnx-node/package.json',
];

const bundledModelDirectory = path.join(resourcesPath, 'models');
const bundledModelEntries = await readdir(bundledModelDirectory).catch((error) => {
  if (error?.code === 'ENOENT') return [];
  throw error;
});
if (bundledModelEntries.some((entry) => /^ggml-[a-z0-9][a-z0-9.-]*\.bin$/u.test(entry))) {
  throw new Error(
    `The default Whisper model must not be bundled in the application: ${bundledModelEntries.join(', ')}`,
  );
}

await Promise.all([
  ...commonRequiredPaths.map(requirePath),
  ...configuration.required.map(requirePath),
  ...configuration.forbidden.map(rejectPath),
]);

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (
  `${manifest.target.platform}-${manifest.target.architecture}` !== target
) {
  throw new Error(`Runtime manifest target does not match ${target}.`);
}
if (
  manifest.model?.name !== 'ggml-large-v3-turbo' ||
  manifest.model?.revision !== '6034871ec87c84e342efab769d4c5c06cd126db3' ||
  manifest.model?.sha256 !== '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69' ||
  manifest.model?.size !== 1624555275 ||
  Object.prototype.hasOwnProperty.call(manifest.model, 'file')
) {
  throw new Error('The runtime manifest does not contain the compiled external-model identity.');
}

const manifestDirectoryPath = path.dirname(manifestPath);
const platformBinaryHashChecks =
  target === 'win32-x64'
    ? [
        verifyHash(
          path.join(manifestDirectoryPath, manifest.whisperCpp.binary),
          manifest.whisperCpp.binarySha256,
        ),
        verifyHash(
          path.join(manifestDirectoryPath, manifest.ffmpeg.binary),
          manifest.ffmpeg.binarySha256,
        ),
      ]
    : [];

// macOS signing deliberately changes each Mach-O file after the source runtime
// manifest is produced. The outer package check therefore validates those
// files through codesign, while this cross-platform check hashes every
// immutable model and every unsigned Windows native binary.
await Promise.all([
  ...platformBinaryHashChecks,
  verifyHash(
    path.resolve(
      manifestDirectoryPath,
      manifest.speakerDiarization.segmentationModel,
    ),
    manifest.speakerDiarization.segmentationModelSha256,
  ),
  verifyHash(
    path.resolve(
      manifestDirectoryPath,
      manifest.speakerDiarization.embeddingModel,
    ),
    manifest.speakerDiarization.embeddingModelSha256,
  ),
  ...Object.entries(
    manifest.speakerDiarization.nativeBinaries ?? {},
  ).map(([filename, expectedHash]) =>
    verifyHash(
      path.join(
        resourcesPath,
        'speaker-runtime',
        manifest.speakerDiarization.nativePackage,
        filename,
      ),
      expectedHash,
    ),
  ),
]);

const sourcePackage = JSON.parse(
  await readFile(path.resolve('package.json'), 'utf8'),
);
const expectedProvenance = createSourceProvenance(process.cwd());
const buildReceipt = validatePackageBuildReceipt(
  JSON.parse(await readFile(buildReceiptPath, 'utf8')),
  {
    version: sourcePackage.version,
    ...expectedProvenance,
    lockfileSha256: await sha256(path.resolve('package-lock.json')),
    nodeVersion: process.version,
  },
);
let secureUpdateConfiguration = 'not embedded';
try {
  const configuration = parseUpdateConfiguration(
    JSON.parse(await readFile(updateConfigPath, 'utf8')),
  );
  secureUpdateConfiguration = `embedded for ${new URL(configuration.manifestUrl).origin}`;
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  if (process.env.SOTTO_REQUIRE_SECURE_UPDATE_CONFIG === '1') {
    throw new Error(
      `Secure update configuration is required but missing from ${updateConfigPath}.`,
    );
  }
}
let updateCa = 'system trust only';
try {
  const certificate = new X509Certificate(await readFile(updateCaPath));
  updateCa = `${certificate.subject} (${certificate.fingerprint256})`;
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  if (process.env.SOTTO_REQUIRE_UPDATE_CA === '1') {
    throw new Error(
      `The public update CA is required but missing from ${updateCaPath}.`,
    );
  }
}
const packagedPackage = JSON.parse(
  extractFile(path.join(resourcesPath, 'app.asar'), 'package.json'),
);
if (
  packagedPackage.name !== sourcePackage.name ||
  packagedPackage.version !== sourcePackage.version ||
  packagedPackage.version !== buildReceipt.version
) {
  throw new Error(
    `Packaged metadata ${packagedPackage.name}@${packagedPackage.version} does not match ${sourcePackage.name}@${sourcePackage.version}.`,
  );
}

if (target === 'darwin-arm64') {
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
  const bundleId = execFileSync(
    '/usr/bin/plutil',
    ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist],
    { encoding: 'utf8' },
  ).trim();
  const bundleVersion = execFileSync(
    '/usr/bin/plutil',
    ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', infoPlist],
    { encoding: 'utf8' },
  ).trim();
  if (
    bundleId !== buildReceipt.bundleId ||
    bundleVersion !== buildReceipt.version
  ) {
    throw new Error(
      'The packaged macOS bundle identity does not match the build receipt.',
    );
  }

  execFileSync(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', appPath],
    { stdio: 'inherit' },
  );
  if (process.env.SOTTO_REQUIRE_APPLE_DISTRIBUTION === '1') {
    const identity = process.env.SOTTO_MAC_SIGNING_IDENTITY?.trim();
    const expectedTeamId = /\(([A-Z0-9]{10})\)$/u.exec(identity ?? '')?.[1];
    if (!identity?.startsWith('Developer ID Application:') || !expectedTeamId) {
      throw new Error(
        'Apple distribution verification requires SOTTO_MAC_SIGNING_IDENTITY with its Team ID.',
      );
    }
    const signatureResult = spawnSync(
      '/usr/bin/codesign',
      ['--display', '--verbose=4', appPath],
      { encoding: 'utf8' },
    );
    if (signatureResult.status !== 0) {
      throw new Error(signatureResult.stderr || 'Could not inspect code signature.');
    }
    const signature = `${signatureResult.stdout}${signatureResult.stderr}`;
    if (
      !signature.includes(`Authority=${identity}`) ||
      !signature.includes(`TeamIdentifier=${expectedTeamId}`) ||
      !/flags=0x[0-9a-f]*10000\(runtime\)/iu.test(signature)
    ) {
      throw new Error(
        'The macOS app is not signed by the expected Developer ID team with Hardened Runtime.',
      );
    }
    execFileSync('/usr/bin/xcrun', ['stapler', 'validate', appPath], {
      stdio: 'inherit',
    });
    execFileSync(
      '/usr/sbin/spctl',
      ['--assess', '--type', 'execute', '--verbose=4', appPath],
      { stdio: 'inherit' },
    );
  }
}

console.log(
  `Verified ${target} package resources, immutable runtime hashes, licenses, ${packagedPackage.name}@${packagedPackage.version} from ${buildReceipt.commit.slice(0, 12)}, secure update configuration: ${secureUpdateConfiguration}, and update CA: ${updateCa}.`,
);
