export const SUPPORTED_RUNTIME_INTEGRATION_TARGETS = [
  {
    arch: 'arm64',
    id: 'darwin-arm64',
    platform: 'darwin',
    setupScript: 'setup:runtime:mac',
  },
  {
    arch: 'x64',
    id: 'win32-x64',
    platform: 'win32',
    setupScript: 'setup:runtime:windows',
  },
] as const;

export type RuntimeIntegrationTarget =
  (typeof SUPPORTED_RUNTIME_INTEGRATION_TARGETS)[number];

export const resolveRuntimeIntegrationTarget = (
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): RuntimeIntegrationTarget | null =>
  SUPPORTED_RUNTIME_INTEGRATION_TARGETS.find(
    (target) => target.platform === platform && target.arch === arch,
  ) ?? null;
