export type PackageBuildReceipt = Readonly<{
  schemaVersion: 2;
  app: 'sotto';
  bundleId: 'com.sotto.desktop';
  version: string;
  commit: string;
  sourceState: 'clean' | 'dirty';
  sourceDigest: string;
  lockfileSha256: string;
  nodeVersion: string;
}>;

export function validatePackageBuildReceipt(
  value: unknown,
  expected: Readonly<{
    version: string;
    commit: string;
    sourceState: 'clean' | 'dirty';
    sourceDigest: string;
    lockfileSha256: string;
    nodeVersion: string;
    bundleId?: string;
  }>,
): PackageBuildReceipt;
