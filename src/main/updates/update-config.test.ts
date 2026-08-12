import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadUpdateConfiguration,
  parseUpdateConfiguration,
} from './update-config.cjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const validConfiguration = () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  return {
    schemaVersion: 1,
    manifestUrl: 'https://updates.example.test/internal/sotto/latest.json',
    keys: [
      {
        algorithm: 'ed25519',
        keyId: 'test-2026',
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      },
    ],
  };
};

describe('parseUpdateConfiguration', () => {
  it('returns an HTTPS manifest URL and an Ed25519 key registry', () => {
    const configuration = validConfiguration();
    expect(parseUpdateConfiguration(configuration)).toEqual({
      manifestUrl: configuration.manifestUrl,
      trustedManifestKeys: {
        'test-2026': configuration.keys[0].publicKey,
      },
    });
  });

  it('rejects an insecure manifest URL', () => {
    const configuration = validConfiguration();
    configuration.manifestUrl =
      'http://127.0.0.1:8090/internal/sotto/latest.json';
    expect(() => parseUpdateConfiguration(configuration)).toThrow(
      'must use HTTPS',
    );
  });

  it.each([
    'https://release:secret@updates.example.test/internal/sotto/latest.json',
    'https://updates.example.test/internal/sotto/latest.json?token=secret',
    'https://updates.example.test/internal/sotto/latest.json#release',
  ])('rejects a manifest URL containing credentials or suffix data: %s', (url) => {
    const configuration = validConfiguration();
    configuration.manifestUrl = url;
    expect(() => parseUpdateConfiguration(configuration)).toThrow(
      'must not contain credentials, a query, or a fragment',
    );
  });

  it('rejects malformed or non-Ed25519 public keys', () => {
    const configuration = validConfiguration();
    configuration.keys[0].publicKey = 'not a public key';
    expect(() => parseUpdateConfiguration(configuration)).toThrow(
      'verification key is invalid',
    );
  });

  it('accepts an optional model URL only on the manifest origin', () => {
    const configuration = {
      ...validConfiguration(),
      modelUrl: 'https://updates.example.test/internal/sotto/model.bin',
    };
    expect(parseUpdateConfiguration(configuration)).toMatchObject({
      manifestUrl: configuration.manifestUrl,
      modelUrl: configuration.modelUrl,
    });
    for (const modelUrl of [
      'http://updates.example.test/internal/sotto/model.bin',
      'https://other.example.test/internal/sotto/model.bin',
      'https://updates.example.test/internal/sotto/model.bin?token=secret',
    ]) {
      expect(() =>
        parseUpdateConfiguration({ ...configuration, modelUrl }),
      ).toThrow(/model URL/u);
    }
  });
});

describe('loadUpdateConfiguration', () => {
  it('leaves secure updates unconfigured when no embedded file is supplied', async () => {
    await expect(loadUpdateConfiguration(null)).resolves.toBeNull();
  });

  it('leaves secure updates unconfigured when a local package has no embedded file', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sotto-config-'));
    temporaryDirectories.push(directory);
    await expect(
      loadUpdateConfiguration(
        path.join(directory, 'sotto-update-config.json'),
      ),
    ).resolves.toBeNull();
  });

  it('loads and validates an embedded configuration file', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sotto-config-'));
    temporaryDirectories.push(directory);
    const configuration = validConfiguration();
    const filePath = path.join(directory, 'sotto-update-config.json');
    await writeFile(filePath, JSON.stringify(configuration));

    await expect(loadUpdateConfiguration(filePath)).resolves.toEqual({
      manifestUrl: configuration.manifestUrl,
      trustedManifestKeys: {
        'test-2026': configuration.keys[0].publicKey,
      },
    });
  });
});
