import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export type TranscriptExportContent = string | Uint8Array;

export interface TranscriptExportFileHandle {
  close(): Promise<void>;
  sync(): Promise<void>;
  write(content: TranscriptExportContent): Promise<void>;
}

export interface TranscriptExportOperations {
  openExclusive(filePath: string, mode: number): Promise<TranscriptExportFileHandle>;
  rename(sourcePath: string, destinationPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
}

const defaultOperations: TranscriptExportOperations = {
  openExclusive: async (filePath, mode) => {
    const file = await open(filePath, 'wx', mode);
    return {
      close: () => file.close(),
      sync: () => file.sync(),
      write: (content) =>
        typeof content === 'string'
          ? file.writeFile(content, { encoding: 'utf8' })
          : file.writeFile(content),
    };
  },
  rename,
  unlink,
};

/**
 * Writes beside the destination first so a failed export never truncates an
 * existing user file. The final rename is the only destination mutation.
 */
export const writeTranscriptExport = async (
  destinationPath: string,
  content: TranscriptExportContent,
  operations: TranscriptExportOperations = defaultOperations,
): Promise<void> => {
  if (!path.isAbsolute(destinationPath)) {
    throw new TypeError('Transcript export path must be absolute.');
  }

  const temporaryPath = path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.${randomUUID()}.sotto-export.tmp`,
  );
  let file: TranscriptExportFileHandle | null = null;

  try {
    file = await operations.openExclusive(temporaryPath, 0o600);
    await file.write(content);
    await file.sync();
    await file.close();
    file = null;
    await operations.rename(temporaryPath, destinationPath);
  } catch (error) {
    await file?.close().catch(() => undefined);
    await operations.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};
