import { describe, expect, it } from 'vitest';

import {
  resolveRuntimeIntegrationTarget,
  SUPPORTED_RUNTIME_INTEGRATION_TARGETS,
} from './runtime-integration-target';

describe('resolveRuntimeIntegrationTarget', () => {
  it.each(SUPPORTED_RUNTIME_INTEGRATION_TARGETS)(
    'selects the $id runtime on its native host',
    (target) => {
      expect(
        resolveRuntimeIntegrationTarget(target.platform, target.arch),
      ).toEqual(target);
    },
  );

  it.each([
    ['darwin', 'x64'],
    ['win32', 'arm64'],
    ['linux', 'x64'],
  ] as const)('declines unsupported host %s-%s', (platform, arch) => {
    expect(resolveRuntimeIntegrationTarget(platform, arch)).toBeNull();
  });
});
