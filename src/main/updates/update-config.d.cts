import type { TrustedReleaseKeys } from './release-manifest.cjs';

export interface UpdateConfiguration {
  manifestUrl: string;
  modelUrl?: string;
  trustedManifestKeys: TrustedReleaseKeys;
}

export function parseUpdateConfiguration(value: unknown): UpdateConfiguration;

export function loadUpdateConfiguration(
  filePath: string | null,
): Promise<UpdateConfiguration | null>;
