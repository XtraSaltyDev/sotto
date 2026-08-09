export type SourceProvenance = Readonly<{
  commit: string;
  sourceDigest: string;
  sourceState: 'clean' | 'dirty';
}>;

export function createSourceProvenance(projectRoot: string): SourceProvenance;
