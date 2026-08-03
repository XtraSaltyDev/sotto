export type PackageBuildReceipt = Readonly<{
  schemaVersion: 1;
  app: 'sotto';
  bundleId: 'com.sotto.desktop';
  version: string;
  commit: string;
}>;

export function validatePackageBuildReceipt(
  value: unknown,
  expected: Readonly<{
    version: string;
    commit: string;
    bundleId?: string;
  }>,
): PackageBuildReceipt;
