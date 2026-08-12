import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_TRANSCRIPTION_MODEL } from '../../shared/default-transcription-model';

export type ModelIdentity = Readonly<{
  fileName: string;
  revision?: string;
  sha256: string;
  size: number;
}>;

export type ModelProvisioningStatus =
  | { state: 'checking'; message: string }
  | { state: 'required'; message: string }
  | {
      state: 'downloading';
      message: string;
      receivedBytes: number;
      totalBytes: number;
    }
  | { state: 'verifying'; message: string }
  | { state: 'ready'; message: string }
  | { state: 'failed'; message: string }
  | { state: 'cancelled'; message: string };

export type ModelFetcher = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface ManagedModelProvisionerOptions {
  managedModelsDirectory: string;
  modelUrl?: string;
  tlsCa?: string | Buffer;
  identity?: ModelIdentity;
  fetcher?: ModelFetcher;
  onStatus?: (status: ModelProvisioningStatus) => void;
}

const MAX_MODEL_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const MODEL_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const ACTIVE_MODEL_DIRECTORY_RETENTION = 2;

const defaultIdentity: ModelIdentity = DEFAULT_TRANSCRIPTION_MODEL;

const assertIdentity = (identity: ModelIdentity): void => {
  if (
    !MODEL_FILE_NAME_PATTERN.test(identity.fileName) ||
    identity.fileName.includes('..') ||
    !/^[0-9a-f]{64}$/u.test(identity.sha256) ||
    !Number.isSafeInteger(identity.size) ||
    identity.size <= 0 ||
    (identity.revision !== undefined && !REVISION_PATTERN.test(identity.revision))
  ) {
    throw new TypeError('The managed model identity is invalid.');
  }
};

const assertAbsoluteDirectory = (directory: string, label: string): void => {
  if (!path.isAbsolute(directory)) {
    throw new TypeError(`${label} must be absolute.`);
  }
};

const sha256 = async (filePath: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
};

export const isVerifiedModel = async (
  filePath: string,
  identity: ModelIdentity,
): Promise<boolean> => {
  try {
    const details = await lstat(filePath);
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

const writeChunk = async (
  output: ReturnType<typeof createWriteStream>,
  chunk: Uint8Array,
): Promise<void> => {
  if (output.write(chunk)) return;
  await once(output, 'drain');
};

const writeVerifiedStream = async (
  stream: AsyncIterable<Uint8Array>,
  destination: string,
  identity: ModelIdentity,
  onBytes: (receivedBytes: number) => void,
): Promise<void> => {
  const output = createWriteStream(destination, {
    flags: 'wx',
    mode: 0o600,
  });
  output.on('error', () => undefined);
  let outputClosed = false;
  const outputClose = new Promise<void>((resolve) => {
    output.once('close', () => {
      outputClosed = true;
      resolve();
    });
  });
  const hash = createHash('sha256');
  let receivedBytes = 0;
  let failure: unknown;
  try {
    for await (const chunk of stream) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      receivedBytes += bytes.byteLength;
      if (receivedBytes > identity.size) {
        throw new Error('The downloaded model exceeds its pinned maximum size.');
      }
      hash.update(bytes);
      await writeChunk(output, bytes);
      onBytes(receivedBytes);
    }
    await new Promise<void>((resolve, reject) => {
      output.end(() => resolve());
      output.once('error', reject);
    });
    if (receivedBytes !== identity.size || hash.digest('hex') !== identity.sha256) {
      throw new Error('The downloaded model failed size or SHA-256 verification.');
    }
  } catch (error) {
    failure = error;
    output.destroy();
  } finally {
    if (!output.destroyed) output.destroy();
    if (failure) {
      if (!outputClosed) await outputClose;
      await rm(destination, { force: true });
    }
  }
  if (failure) throw failure;
};

const fsyncFile = async (filePath: string): Promise<void> => {
  const file = await open(filePath, 'r+');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
};

const destinationFor = (
  managedModelsDirectory: string,
  identity: ModelIdentity,
): string => {
  assertAbsoluteDirectory(managedModelsDirectory, 'Managed model directory');
  assertIdentity(identity);
  const destination = path.join(managedModelsDirectory, identity.fileName);
  if (path.dirname(destination) !== managedModelsDirectory) {
    throw new TypeError('The managed model destination escaped its directory.');
  }
  return destination;
};

const quarantineInvalidModel = async (filePath: string): Promise<void> => {
  try {
    await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const quarantinePath = `${filePath}.corrupt-${Date.now()}-${process.pid}`;
  await rename(filePath, quarantinePath);
};

const activateVerifiedModel = async (
  temporaryPath: string,
  destination: string,
  identity: ModelIdentity,
): Promise<string> => {
  if (await isVerifiedModel(destination, identity)) {
    await rm(temporaryPath, { force: true });
    return destination;
  }
  await quarantineInvalidModel(destination);
  await rename(temporaryPath, destination);
  if (!(await isVerifiedModel(destination, identity))) {
    await quarantineInvalidModel(destination).catch(() => undefined);
    throw new Error('The activated managed transcription model failed verification.');
  }
  return destination;
};

const copyVerifiedSource = async (
  sourcePath: string,
  destination: string,
  identity: ModelIdentity,
): Promise<string> => {
  const sourceStats = await lstat(sourcePath);
  if (!sourceStats.isFile()) throw new Error('Choose a regular model file.');
  if (!(await isVerifiedModel(sourcePath, identity))) {
    throw new Error('The selected model failed verification against the expected Sotto model.');
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporaryPath = `${destination}.part-${process.pid}-${Date.now()}`;
  await rm(temporaryPath, { force: true });
  await writeVerifiedStream(
    (async function* () {
      for await (const chunk of createReadStream(sourcePath)) yield chunk;
    })(),
    temporaryPath,
    identity,
    () => undefined,
  );
  await fsyncFile(temporaryPath);
  return activateVerifiedModel(temporaryPath, destination, identity);
};

export const pruneManagedModelRevisions = async ({
  managedModelsRoot,
  currentRevision,
  selectedModelPaths = [],
  activeModelPaths = [],
  retainRevisions = ACTIVE_MODEL_DIRECTORY_RETENTION,
}: {
  managedModelsRoot: string;
  currentRevision: string;
  selectedModelPaths?: readonly string[];
  activeModelPaths?: readonly string[];
  retainRevisions?: number;
}): Promise<string[]> => {
  assertAbsoluteDirectory(managedModelsRoot, 'Managed models root');
  if (!REVISION_PATTERN.test(currentRevision)) {
    throw new TypeError('The current managed model revision is invalid.');
  }
  if (!Number.isSafeInteger(retainRevisions) || retainRevisions < 1) {
    throw new TypeError('Managed model retention must be a positive integer.');
  }
  const entries = await readdir(managedModelsRoot, { withFileTypes: true }).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    },
  );
  const candidates = [] as Array<{ name: string; modifiedAt: number }>;
  for (const entry of entries) {
    if (!entry.isDirectory() || !REVISION_PATTERN.test(entry.name)) continue;
    const details = await stat(path.join(managedModelsRoot, entry.name));
    candidates.push({ name: entry.name, modifiedAt: details.mtimeMs });
  }
  candidates.sort((left, right) =>
    left.name === currentRevision
      ? -1
      : right.name === currentRevision
        ? 1
        : right.modifiedAt - left.modifiedAt,
  );
  const keep = new Set(candidates.slice(0, retainRevisions).map((entry) => entry.name));
  keep.add(currentRevision);
  const protectedPaths = [...selectedModelPaths, ...activeModelPaths].map((value) =>
    path.resolve(value),
  );
  const removed: string[] = [];
  for (const candidate of candidates) {
    if (keep.has(candidate.name)) continue;
    const directory = path.join(managedModelsRoot, candidate.name);
    const resolvedDirectory = path.resolve(directory);
    if (protectedPaths.some((value) => value === resolvedDirectory || value.startsWith(`${resolvedDirectory}${path.sep}`))) continue;
    await rm(directory, { recursive: true, force: true });
    removed.push(candidate.name);
  }
  return removed;
};

const verifiedProvisioning = new Map<string, Promise<string>>();

export class ManagedModelProvisioner {
  private status: ModelProvisioningStatus = {
    state: 'checking',
    message: 'Checking for a verified local transcription model…',
  };
  private active: Promise<string> | null = null;
  private abortController: AbortController | null = null;
  private statusListener: ((status: ModelProvisioningStatus) => void) | null = null;

  constructor(private readonly options: ManagedModelProvisionerOptions) {
    assertAbsoluteDirectory(options.managedModelsDirectory, 'Managed model directory');
    assertIdentity(options.identity ?? defaultIdentity);
    if (options.modelUrl !== undefined) validateModelUrl(options.modelUrl);
  }

  getStatus(): ModelProvisioningStatus {
    return { ...this.status };
  }

  subscribe(listener: (status: ModelProvisioningStatus) => void): () => void {
    this.statusListener = listener;
    return () => {
      if (this.statusListener === listener) this.statusListener = null;
    };
  }

  async provision(): Promise<string> {
    if (this.active) return this.active;
    const identity = this.options.identity ?? defaultIdentity;
    const destination = destinationFor(this.options.managedModelsDirectory, identity);
    const existing = verifiedProvisioning.get(destination);
    if (existing) return existing;
    const work = this.provisionInternal(destination, identity);
    this.active = work;
    verifiedProvisioning.set(destination, work);
    try {
      return await work;
    } finally {
      if (verifiedProvisioning.get(destination) === work) verifiedProvisioning.delete(destination);
      this.active = null;
      this.abortController = null;
    }
  }

  cancel(): void {
    this.abortController?.abort();
  }

  async importFromPath(sourcePath: string): Promise<string> {
    if (!path.isAbsolute(sourcePath)) throw new TypeError('The model path must be absolute.');
    const previous = this.active;
    if (previous) {
      this.cancel();
      await previous.catch(() => undefined);
    }
    const identity = this.options.identity ?? defaultIdentity;
    const destination = destinationFor(this.options.managedModelsDirectory, identity);
    this.setStatus({ state: 'verifying', message: 'Verifying the selected local model…' });
    try {
      const result = await copyVerifiedSource(sourcePath, destination, identity);
      this.setStatus({ state: 'ready', message: 'The private local transcription model is ready.' });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The selected model could not be adopted.';
      this.setStatus({ state: 'failed', message });
      throw error;
    }
  }

  private async provisionInternal(destination: string, identity: ModelIdentity): Promise<string> {
    const controller = new AbortController();
    this.abortController = controller;
    this.setStatus({ state: 'checking', message: 'Checking for a verified local transcription model…' });
    if (await isVerifiedModel(destination, identity)) {
      this.setStatus({ state: 'ready', message: 'The private local transcription model is ready.' });
      return destination;
    }
    if (!this.options.modelUrl) {
      this.setStatus({
        state: 'required',
        message: 'Model setup is required. Connect to the approved update host or import the matching model file from Settings.',
      });
      throw new Error(this.status.message);
    }

    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temporaryPath = `${destination}.part-${process.pid}-${Date.now()}`;
    await rm(temporaryPath, { force: true });
    const timeout = setTimeout(() => controller.abort(), MAX_MODEL_DOWNLOAD_TIMEOUT_MS);
    try {
      const fetcher = this.options.fetcher ?? fetch;
      this.setStatus({ state: 'downloading', message: 'Downloading the private local model to this computer…', receivedBytes: 0, totalBytes: identity.size });
      if (controller.signal.aborted) throw new Error('The model download was cancelled.');
      const response = await fetcher(this.options.modelUrl, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: { Accept: 'application/octet-stream' },
      });
      if (!response.ok || response.body === null) {
        throw new Error(`The model download returned HTTP ${response.status}.`);
      }
      const contentLength = response.headers.get('content-length');
      if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > identity.size)) {
        throw new Error('The model server advertised more bytes than the pinned model size.');
      }
      await writeVerifiedStream(
        response.body as unknown as AsyncIterable<Uint8Array>,
        temporaryPath,
        identity,
        (receivedBytes) => this.setStatus({ state: 'downloading', message: 'Downloading the private local model to this computer…', receivedBytes, totalBytes: identity.size }),
      );
      this.setStatus({ state: 'verifying', message: 'Verifying the downloaded local model…' });
      await fsyncFile(temporaryPath);
      const result = await activateVerifiedModel(temporaryPath, destination, identity);
      this.setStatus({ state: 'ready', message: 'The private local transcription model is ready.' });
      return result;
    } catch (error) {
      await rm(temporaryPath, { force: true });
      if (controller.signal.aborted) {
        this.setStatus({ state: 'cancelled', message: 'Model setup was cancelled. Retry or import the matching model file.' });
      } else {
        this.setStatus({ state: 'failed', message: error instanceof Error ? error.message : 'The model could not be provisioned.' });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private setStatus(status: ModelProvisioningStatus): void {
    this.status = status;
    this.options.onStatus?.(status);
    this.statusListener?.(status);
  }
}

export const validateModelUrl = (value: string, manifestUrl?: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('The model URL is invalid.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new TypeError('The model URL must use HTTPS without credentials, a query, or a fragment.');
  }
  if (manifestUrl && url.origin !== new URL(manifestUrl).origin) {
    throw new TypeError('The model URL must use the signed update origin.');
  }
  return url.href;
};

export const provisionManagedDefaultModel = async ({
  bundledModelPath,
  managedModelsDirectory,
  identity = defaultIdentity,
}: {
  bundledModelPath: string;
  managedModelsDirectory: string;
  identity?: ModelIdentity;
}): Promise<string> => {
  if (!path.isAbsolute(bundledModelPath)) throw new TypeError('Managed model paths must be absolute.');
  const destination = destinationFor(managedModelsDirectory, identity);
  if (await isVerifiedModel(destination, identity)) return destination;
  return copyVerifiedSource(bundledModelPath, destination, identity);
};
