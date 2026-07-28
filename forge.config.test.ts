import { describe, expect, it } from 'vitest';

import { createMacSignOptions } from './forge.config';

describe('macOS package signing', () => {
  it('keeps ad-hoc local packages launchable without library validation', () => {
    const options = createMacSignOptions();

    expect(options).toMatchObject({
      identity: '-',
      identityValidation: false,
    });
    expect(options.optionsForFile()).toEqual({ hardenedRuntime: false });
  });

  it('keeps Hardened Runtime for a real Developer ID build', () => {
    const options = createMacSignOptions(
      '  Developer ID Application: Example Company (ABCDE12345)  ',
    );

    expect(options).toMatchObject({
      identity: 'Developer ID Application: Example Company (ABCDE12345)',
      identityValidation: true,
    });
    expect(options.optionsForFile()).toEqual({ hardenedRuntime: true });
  });
});
