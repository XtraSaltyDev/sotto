import { describe, expect, it } from 'vitest';

import { validatePackageBuildReceipt } from './package-build-receipt.cjs';

const expected = {
  version: '0.2.0',
  commit: '0123456789abcdef0123456789abcdef01234567',
  sourceState: 'clean' as const,
  sourceDigest: 'a'.repeat(64),
  lockfileSha256: 'b'.repeat(64),
  nodeVersion: 'v24.19.0',
};

const receipt = () => ({
  schemaVersion: 2 as const,
  app: 'sotto' as const,
  bundleId: 'com.sotto.desktop' as const,
  version: expected.version,
  commit: expected.commit,
  sourceState: expected.sourceState,
  sourceDigest: expected.sourceDigest,
  lockfileSha256: expected.lockfileSha256,
  nodeVersion: expected.nodeVersion,
});

describe('validatePackageBuildReceipt', () => {
  it('accepts an exact package receipt from the current source', () => {
    expect(validatePackageBuildReceipt(receipt(), expected)).toEqual(receipt());
  });

  it.each([
    ['version', { version: '0.1.9' }],
    ['commit', { commit: 'f'.repeat(40) }],
    ['source digest', { sourceDigest: 'f'.repeat(64) }],
    ['source state', { sourceState: 'dirty' }],
    ['lockfile', { lockfileSha256: 'f'.repeat(64) }],
    ['Node version', { nodeVersion: 'v24.18.0' }],
    ['bundle identity', { bundleId: 'com.attacker.fake' }],
  ])('rejects a release archive with a stale or wrong %s', (_field, changes) => {
    expect(() =>
      validatePackageBuildReceipt({ ...receipt(), ...changes }, expected),
    ).toThrow('does not match this Sotto source checkout');
  });
});
