import type { KeyLike } from 'node:crypto';

export type ReleaseArtifactTarget =
  | 'darwin-arm64'
  | 'darwin-arm64-archive'
  | 'win32-x64';

export interface ReleaseManifestArtifact {
  target: ReleaseArtifactTarget;
  file: string;
  downloadUrl: string;
  sha256: string;
  size: number;
}

export interface ParsedReleaseManifest {
  schemaVersion: 2;
  app: 'sotto';
  channel: 'internal';
  releaseKind: 'internal-ad-hoc' | 'internal-developer-id';
  version: string;
  bundleId: 'com.sotto.desktop';
  commit: string;
  buildNumber: number;
  publishedAt: string;
  artifacts: Partial<
    Record<ReleaseArtifactTarget, ReleaseManifestArtifact>
  >;
}

export type TrustedReleaseKeys = Readonly<Record<string, string>>;

export function canonicalizeJson(value: unknown): string;

export function signReleaseManifest(
  unsignedManifest: Record<string, unknown>,
  keyId: string,
  privateKey: KeyLike,
): Record<string, unknown>;

export function verifyReleaseManifest(
  value: unknown,
  trustedKeys: TrustedReleaseKeys,
  manifestUrl: string,
  options?: { allowInsecureHttpForTests?: boolean },
): ParsedReleaseManifest;
