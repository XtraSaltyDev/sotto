#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import releaseManifest from '../src/main/updates/release-manifest.cjs';
import updateConfig from '../src/main/updates/update-config.cjs';

const { signReleaseManifest, verifyReleaseManifest } = releaseManifest;
const { parseUpdateConfiguration } = updateConfig;

const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

const isRecord = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const assertPrivateKeyLocation = async (privateKeyFile, projectRoot) => {
  const privateKeyPath = await realpath(privateKeyFile);
  const rootPath = await realpath(projectRoot);
  const relative = path.relative(rootPath, privateKeyPath);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new TypeError('The update signing private key must stay outside the repository.');
  }
  const fileStat = await stat(privateKeyPath);
  if (!fileStat.isFile()) {
    throw new TypeError('The update signing private key path is not a file.');
  }
  if (process.platform !== 'win32' && (fileStat.mode & 0o077) !== 0) {
    throw new TypeError(
      'The update signing private key file must not be accessible to group or other users.',
    );
  }
  return privateKeyPath;
};

const hashArtifact = async (filePath) => {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size <= 0) {
    throw new TypeError(`The update artifact is missing or empty: ${filePath}`);
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return { sha256: hash.digest('hex'), size: fileStat.size };
};

export const createSignedUpdateManifest = async ({
  projectRoot,
  privateKeyFile,
  updateConfigFile,
  keyId,
  version,
  commit,
  buildNumber,
  publishedAt,
  releaseKind = 'internal-developer-id',
  artifacts,
}) => {
  const configuration = parseUpdateConfiguration(
    JSON.parse(await readFile(updateConfigFile, 'utf8')),
  );
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) {
    throw new TypeError('The update signing key ID is invalid.');
  }
  const configuredPublicKey = configuration.trustedManifestKeys[keyId];
  if (!configuredPublicKey) {
    throw new TypeError('The update signing key ID is not embedded in the package configuration.');
  }
  const privateKeyPath = await assertPrivateKeyLocation(
    privateKeyFile,
    projectRoot,
  );
  let privateKey;
  try {
    privateKey = createPrivateKey(await readFile(privateKeyPath, 'utf8'));
  } catch {
    throw new TypeError('The update signing private key is invalid.');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('The update signing private key must use Ed25519.');
  }
  const derivedPublicKey = createPublicKey(privateKey).export({
    type: 'spki',
    format: 'der',
  });
  const embeddedPublicKey = createPublicKey(configuredPublicKey).export({
    type: 'spki',
    format: 'der',
  });
  if (!derivedPublicKey.equals(embeddedPublicKey)) {
    throw new TypeError(
      'The update signing private key does not match the embedded verification key.',
    );
  }
  if (!isRecord(artifacts) || Object.keys(artifacts).length === 0) {
    throw new TypeError('At least one update artifact is required.');
  }
  const authenticatedArtifacts = {};
  for (const [target, artifact] of Object.entries(artifacts)) {
    if (
      !isRecord(artifact) ||
      typeof artifact.file !== 'string' ||
      typeof artifact.localPath !== 'string' ||
      typeof artifact.downloadUrl !== 'string'
    ) {
      throw new TypeError(`The ${target} update artifact description is invalid.`);
    }
    const digest = await hashArtifact(artifact.localPath);
    authenticatedArtifacts[target] = {
      target,
      file: artifact.file,
      downloadUrl: artifact.downloadUrl,
      ...digest,
    };
  }
  const unsignedManifest = {
    schemaVersion: 2,
    app: 'sotto',
    channel: 'internal',
    releaseKind,
    version,
    bundleId: 'com.sotto.desktop',
    commit,
    buildNumber,
    publishedAt,
    artifacts: authenticatedArtifacts,
  };
  const signedManifest = signReleaseManifest(
    unsignedManifest,
    keyId,
    privateKey,
  );
  verifyReleaseManifest(
    signedManifest,
    configuration.trustedManifestKeys,
    configuration.manifestUrl,
  );
  return signedManifest;
};

const run = async () => {
  const [draftFile, outputFile] = process.argv.slice(2);
  const privateKeyFile = process.env.SOTTO_UPDATE_SIGNING_KEY_FILE;
  const updateConfigFile = process.env.SOTTO_UPDATE_CONFIG_FILE;
  const keyId = process.env.SOTTO_UPDATE_SIGNING_KEY_ID;
  if (
    !draftFile ||
    !outputFile ||
    !privateKeyFile ||
    !updateConfigFile ||
    !keyId
  ) {
    throw new Error(
      'Usage: SOTTO_UPDATE_SIGNING_KEY_FILE=/outside/repo/key.pem SOTTO_UPDATE_SIGNING_KEY_ID=key-id SOTTO_UPDATE_CONFIG_FILE=/path/sotto-update-config.json node scripts/create-signed-update-manifest.mjs <draft.json> <latest.json>',
    );
  }
  const draft = JSON.parse(await readFile(draftFile, 'utf8'));
  const manifest = await createSignedUpdateManifest({
    ...draft,
    projectRoot: process.cwd(),
    privateKeyFile,
    updateConfigFile,
    keyId,
  });
  await writeFile(outputFile, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o644,
  });
  console.log(`Wrote signed Sotto update manifest to ${outputFile}.`);
};

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  await run();
}
