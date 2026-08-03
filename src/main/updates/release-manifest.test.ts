import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  canonicalizeJson,
  signReleaseManifest,
  verifyReleaseManifest,
} from './release-manifest.cjs';

const releaseFixture = () => ({
  schemaVersion: 2,
  app: 'sotto',
  channel: 'internal',
  releaseKind: 'internal-ad-hoc',
  version: '0.2.0',
  bundleId: 'com.sotto.desktop',
  commit: '0123456789abcdef0123456789abcdef01234567',
  buildNumber: 42,
  publishedAt: '2026-08-03T12:00:00.000Z',
  artifacts: {
    'darwin-arm64': {
      target: 'darwin-arm64',
      file: 'Sotto-arm64.dmg',
      downloadUrl: 'https://updates.example.test/internal/sotto/Sotto-arm64.dmg',
      sha256: 'a'.repeat(64),
      size: 123,
    },
  },
});

describe('canonicalizeJson', () => {
  it('sorts every object level while preserving array order', () => {
    expect(canonicalizeJson({ z: [3, { b: 2, a: 1 }], a: 'first' })).toBe(
      '{"a":"first","z":[3,{"a":1,"b":2}]}',
    );
  });
});

describe('signed release manifests', () => {
  it('verifies a valid Ed25519 manifest and returns authenticated fields', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signed = signReleaseManifest(releaseFixture(), 'test-2026', privateKey);

    expect(
      verifyReleaseManifest(
        signed,
        {
          'test-2026': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        },
        'https://updates.example.test/internal/sotto/latest.json',
      ),
    ).toMatchObject({
      version: '0.2.0',
      bundleId: 'com.sotto.desktop',
      artifacts: {
        'darwin-arm64': {
          target: 'darwin-arm64',
          size: 123,
        },
      },
    });
  });

  it.each([
    ['version', (manifest: Record<string, unknown>) => {
      manifest.version = '0.2.1';
    }],
    ['URL', (manifest: Record<string, unknown>) => {
      const artifacts = manifest.artifacts as Record<string, Record<string, unknown>>;
      artifacts['darwin-arm64'].downloadUrl =
        'https://updates.example.test/internal/sotto/Other.dmg';
    }],
    ['SHA-256', (manifest: Record<string, unknown>) => {
      const artifacts = manifest.artifacts as Record<string, Record<string, unknown>>;
      artifacts['darwin-arm64'].sha256 = 'b'.repeat(64);
    }],
    ['size', (manifest: Record<string, unknown>) => {
      const artifacts = manifest.artifacts as Record<string, Record<string, unknown>>;
      artifacts['darwin-arm64'].size = 124;
    }],
    ['target', (manifest: Record<string, unknown>) => {
      const artifacts = manifest.artifacts as Record<string, Record<string, unknown>>;
      artifacts['darwin-arm64'].target = 'win32-x64';
    }],
    ['bundle identity', (manifest: Record<string, unknown>) => {
      manifest.bundleId = 'com.attacker.fake';
    }],
  ])('rejects a signed manifest with an altered %s', (_field, alter) => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signed = signReleaseManifest(
      releaseFixture(),
      'test-2026',
      privateKey,
    );
    alter(signed);

    expect(() =>
      verifyReleaseManifest(
        signed,
        {
          'test-2026': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        },
        'https://updates.example.test/internal/sotto/latest.json',
      ),
    ).toThrow('The update manifest signature is invalid.');
  });

  it('rejects an unsigned manifest without a legacy fallback', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    expect(() =>
      verifyReleaseManifest(
        { ...releaseFixture(), schemaVersion: 1 },
        {
          'test-2026': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        },
        'https://updates.example.test/internal/sotto/latest.json',
      ),
    ).toThrow('The update manifest signature is missing.');
  });

  it('rejects a valid signature from a different key', () => {
    const signer = generateKeyPairSync('ed25519');
    const other = generateKeyPairSync('ed25519');
    const signed = signReleaseManifest(
      releaseFixture(),
      'test-2026',
      signer.privateKey,
    );

    expect(() =>
      verifyReleaseManifest(
        signed,
        {
          'test-2026': other.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        },
        'https://updates.example.test/internal/sotto/latest.json',
      ),
    ).toThrow('The update manifest signature is invalid.');
  });

  it('rejects a malformed signature encoding', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signed = signReleaseManifest(
      releaseFixture(),
      'test-2026',
      privateKey,
    ) as Record<string, unknown>;
    signed.signature = {
      algorithm: 'ed25519',
      keyId: 'test-2026',
      value: 'not base64!',
    };

    expect(() =>
      verifyReleaseManifest(
        signed,
        {
          'test-2026': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        },
        'https://updates.example.test/internal/sotto/latest.json',
      ),
    ).toThrow('The update manifest signature is malformed.');
  });

  it('rejects malformed authenticated release fields', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const malformed = { ...releaseFixture(), bundleId: 'com.attacker.fake' };
    const signed = signReleaseManifest(malformed, 'test-2026', privateKey);

    expect(() =>
      verifyReleaseManifest(
        signed,
        {
          'test-2026': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        },
        'https://updates.example.test/internal/sotto/latest.json',
      ),
    ).toThrow('The update manifest is invalid.');
  });

  it('rejects an authenticated HTTP manifest and artifact by default', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const release = releaseFixture();
    release.artifacts['darwin-arm64'].downloadUrl =
      'http://updates.example.test/internal/sotto/Sotto-arm64.dmg';
    const signed = signReleaseManifest(release, 'test-2026', privateKey);

    expect(() =>
      verifyReleaseManifest(
        signed,
        {
          'test-2026': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        },
        'http://updates.example.test/internal/sotto/latest.json',
      ),
    ).toThrow('The update manifest URL must use HTTPS.');
  });

  it('rejects an authenticated HTTP artifact URL on an HTTPS manifest', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const release = releaseFixture();
    release.artifacts['darwin-arm64'].downloadUrl =
      'http://updates.example.test/internal/sotto/Sotto-arm64.dmg';
    const signed = signReleaseManifest(release, 'test-2026', privateKey);

    expect(() =>
      verifyReleaseManifest(
        signed,
        {
          'test-2026': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        },
        'https://updates.example.test/internal/sotto/latest.json',
      ),
    ).toThrow('The update artifact URL must use HTTPS.');
  });

  it('rejects an authenticated artifact from another origin', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const release = releaseFixture();
    release.artifacts['darwin-arm64'].downloadUrl =
      'https://attacker.example/Sotto-arm64.dmg';
    const signed = signReleaseManifest(release, 'test-2026', privateKey);

    expect(() =>
      verifyReleaseManifest(
        signed,
        {
          'test-2026': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        },
        'https://updates.example.test/internal/sotto/latest.json',
      ),
    ).toThrow('must come from the manifest origin');
  });

  it.each([
    'https://release:secret@updates.example.test/internal/sotto/Sotto-arm64.dmg',
    'https://updates.example.test/internal/sotto/Sotto-arm64.dmg?token=secret',
    'https://updates.example.test/internal/sotto/Sotto-arm64.dmg#release',
  ])('rejects an artifact URL containing credentials or suffix data: %s', (url) => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const release = releaseFixture();
    release.artifacts['darwin-arm64'].downloadUrl = url;
    const signed = signReleaseManifest(release, 'test-2026', privateKey);

    expect(() =>
      verifyReleaseManifest(
        signed,
        {
          'test-2026': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        },
        'https://updates.example.test/internal/sotto/latest.json',
      ),
    ).toThrow('must not contain credentials, a query, or a fragment');
  });

  it('rejects a manifest URL containing a query before trusting its origin', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signed = signReleaseManifest(
      releaseFixture(),
      'test-2026',
      privateKey,
    );

    expect(() =>
      verifyReleaseManifest(
        signed,
        {
          'test-2026': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        },
        'https://updates.example.test/internal/sotto/latest.json?token=secret',
      ),
    ).toThrow('must not contain credentials, a query, or a fragment');
  });

  it('allows HTTP only when a caller explicitly enables the test fixture path', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const release = releaseFixture();
    release.artifacts['darwin-arm64'].downloadUrl =
      'http://127.0.0.1:9876/internal/sotto/Sotto-arm64.dmg';
    const signed = signReleaseManifest(release, 'test-2026', privateKey);

    expect(
      verifyReleaseManifest(
        signed,
        {
          'test-2026': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        },
        'http://127.0.0.1:9876/internal/sotto/latest.json',
        { allowInsecureHttpForTests: true },
      ),
    ).toMatchObject({ version: '0.2.0' });
  });
});
