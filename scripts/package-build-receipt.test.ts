import { describe, expect, it } from 'vitest';

import { validatePackageBuildReceipt } from './package-build-receipt.cjs';

const expected = {
  version: '0.2.0',
  commit: '0123456789abcdef0123456789abcdef01234567',
};

const receipt = () => ({
  schemaVersion: 1 as const,
  app: 'sotto' as const,
  bundleId: 'com.sotto.desktop' as const,
  version: expected.version,
  commit: expected.commit,
});

describe('validatePackageBuildReceipt', () => {
  it('accepts an exact package receipt from the current source', () => {
    expect(validatePackageBuildReceipt(receipt(), expected)).toEqual(receipt());
  });

  it.each([
    ['version', { version: '0.1.9' }],
    ['commit', { commit: 'f'.repeat(40) }],
    ['bundle identity', { bundleId: 'com.attacker.fake' }],
  ])('rejects a release archive with a stale or wrong %s', (_field, changes) => {
    expect(() =>
      validatePackageBuildReceipt({ ...receipt(), ...changes }, expected),
    ).toThrow('does not match this Sotto source checkout');
  });
});
