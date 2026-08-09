import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_TRANSCRIPTION_MODEL } from '../../shared/default-transcription-model';

type ModelIdentity = Readonly<{
  fileName: string;
  sha256: string;
  size: number;
}>;

const sha256 = async (filePath: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
};

const isVerifiedModel = async (
  filePath: string,
  identity: ModelIdentity,
): Promise<boolean> => {
  try {
    const details = await stat(filePath);
    return (
      details.isFile() &&
      details.size === identity.size &&
      (await sha256(filePath)) === identity.sha256
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

export const provisionManagedDefaultModel = async ({
  bundledModelPath,
  managedModelsDirectory,
  identity = DEFAULT_TRANSCRIPTION_MODEL,
}: {
  bundledModelPath: string;
  managedModelsDirectory: string;
  identity?: ModelIdentity;
}): Promise<string> => {
  if (!path.isAbsolute(bundledModelPath) || !path.isAbsolute(managedModelsDirectory)) {
    throw new TypeError('Managed model paths must be absolute.');
  }
  const destination = path.join(managedModelsDirectory, identity.fileName);
  if (await isVerifiedModel(destination, identity)) return destination;
  if (!(await isVerifiedModel(bundledModelPath, identity))) {
    throw new Error('The bundled default transcription model failed verification.');
  }

  await mkdir(managedModelsDirectory, { recursive: true });
  const pending = `${destination}.pending-${process.pid}`;
  await rm(pending, { force: true });
  try {
    await copyFile(bundledModelPath, pending);
    if (!(await isVerifiedModel(pending, identity))) {
      throw new Error('The managed transcription model copy failed verification.');
    }
    await rm(destination, { force: true });
    await rename(pending, destination);
  } finally {
    await rm(pending, { force: true });
  }
  return destination;
};
