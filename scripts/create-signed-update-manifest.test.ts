import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { verifyReleaseManifest } from '../src/main/updates/release-manifest.cjs';
import { createSignedUpdateManifest } from './create-signed-update-manifest.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sotto-publisher-'));
  temporaryDirectories.push(directory);
  return directory;
};

const publisherOptions = async ({
  configUrl = 'https://updates.example.test/internal/sotto/latest.json',
  configuredPublicKey,
  keyInsideProject = false,
}: {
  configUrl?: string;
  configuredPublicKey?: string;
  keyInsideProject?: boolean;
} = {}) => {
  const root = await temporaryDirectory();
  const projectRoot = path.join(root, 'checkout');
  await mkdir(projectRoot);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyFile = keyInsideProject
    ? path.join(projectRoot, 'signing-key.pem')
    : path.join(root, 'signing-key.pem');
  const updateConfigFile = path.join(root, 'sotto-update-config.json');
  const artifactFile = path.join(root, 'Sotto-arm64.dmg');
  await writeFile(
    privateKeyFile,
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  );
  await chmod(privateKeyFile, 0o600);
  await writeFile(
    updateConfigFile,
    JSON.stringify({
      schemaVersion: 1,
      manifestUrl: configUrl,
      keys: [
        {
          algorithm: 'ed25519',
          keyId: 'test-2026',
          publicKey:
            configuredPublicKey ??
            publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        },
      ],
    }),
  );
  await writeFile(artifactFile, 'artifact bytes');
  return {
    projectRoot,
    privateKeyFile,
    updateConfigFile,
    keyId: 'test-2026',
    version: '0.2.0',
    commit: '0123456789abcdef0123456789abcdef01234567',
    buildNumber: 42,
    publishedAt: '2026-08-03T12:00:00.000Z',
    artifacts: {
      'darwin-arm64': {
        file: 'Sotto-arm64.dmg',
        localPath: artifactFile,
        downloadUrl: `${new URL(configUrl).origin}/internal/sotto/Sotto-arm64.dmg`,
      },
    },
  } as const;
};

describe('createSignedUpdateManifest', () => {
  it('hashes release artifacts and signs the authenticated manifest with a test key', async () => {
    const root = await temporaryDirectory();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyFile = path.join(root, 'signing-key.pem');
    const updateConfigFile = path.join(root, 'sotto-update-config.json');
    const artifactFile = path.join(root, 'Sotto-arm64.dmg');
    const projectRoot = path.join(root, 'checkout');
    await mkdir(projectRoot);
    const publicKeyPem = publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    await writeFile(
      privateKeyFile,
      privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { mode: 0o600 },
    );
    await chmod(privateKeyFile, 0o600);
    await writeFile(
      updateConfigFile,
      JSON.stringify({
        schemaVersion: 1,
        manifestUrl:
          'https://updates.example.test/internal/sotto/latest.json',
        keys: [
          {
            algorithm: 'ed25519',
            keyId: 'test-2026',
            publicKey: publicKeyPem,
          },
        ],
      }),
    );
    await writeFile(artifactFile, 'artifact bytes');

    const signed = await createSignedUpdateManifest({
      projectRoot,
      privateKeyFile,
      updateConfigFile,
      keyId: 'test-2026',
      version: '0.2.0',
      commit: '0123456789abcdef0123456789abcdef01234567',
      buildNumber: 42,
      publishedAt: '2026-08-03T12:00:00.000Z',
      artifacts: {
        'darwin-arm64': {
          file: 'Sotto-arm64.dmg',
          localPath: artifactFile,
          downloadUrl:
            'https://updates.example.test/internal/sotto/Sotto-arm64.dmg',
        },
      },
    });

    expect(
      verifyReleaseManifest(
        signed,
        { 'test-2026': publicKeyPem },
        'https://updates.example.test/internal/sotto/latest.json',
      ),
    ).toMatchObject({
      version: '0.2.0',
      artifacts: {
        'darwin-arm64': {
          size: 14,
          sha256:
            '4659fc0570122b0e0aa14f4ff7c261b1fe51795a01ba79963f462ebf40d7520d',
        },
      },
    });
  });

  it('rejects a signing key ID that is absent from the embedded configuration', async () => {
    const options = await publisherOptions();
    await expect(
      createSignedUpdateManifest({ ...options, keyId: 'missing-key' }),
    ).rejects.toThrow('is not embedded in the package configuration');
  });

  it('rejects a private key that does not match the embedded public key', async () => {
    const other = generateKeyPairSync('ed25519');
    const options = await publisherOptions({
      configuredPublicKey: other.publicKey
        .export({ type: 'spki', format: 'pem' })
        .toString(),
    });
    await expect(createSignedUpdateManifest(options)).rejects.toThrow(
      'does not match the embedded verification key',
    );
  });

  it('rejects an HTTP update configuration', async () => {
    const options = await publisherOptions({
      configUrl: 'http://127.0.0.1:8090/internal/sotto/latest.json',
    });
    await expect(createSignedUpdateManifest(options)).rejects.toThrow(
      'must use HTTPS',
    );
  });

  it('rejects a private key stored inside the repository', async () => {
    const options = await publisherOptions({ keyInsideProject: true });
    await expect(createSignedUpdateManifest(options)).rejects.toThrow(
      'must stay outside the repository',
    );
  });
});
