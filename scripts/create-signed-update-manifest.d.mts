import type { ReleaseArtifactTarget } from '../src/main/updates/release-manifest.cjs';

interface PublisherArtifact {
  file: string;
  localPath: string;
  downloadUrl: string;
}

export function createSignedUpdateManifest(options: {
  projectRoot: string;
  privateKeyFile: string;
  updateConfigFile: string;
  keyId: string;
  version: string;
  commit: string;
  buildNumber: number;
  publishedAt: string;
  releaseKind?: 'internal-ad-hoc' | 'internal-developer-id';
  artifacts: Partial<Record<ReleaseArtifactTarget, PublisherArtifact>>;
}): Promise<Record<string, unknown>>;
