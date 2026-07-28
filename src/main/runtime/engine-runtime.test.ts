import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveEngineRuntime } from './engine-runtime';

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sotto-runtime-'));
  temporaryDirectories.push(directory);
  return directory;
};

const writeRuntime = async (resourcesRoot: string): Promise<void> => {
  const sidecarDirectory = path.join(
    resourcesRoot,
    'sidecars',
    'darwin-arm64',
  );
  await mkdir(sidecarDirectory, { recursive: true });
  await mkdir(path.join(resourcesRoot, 'models'), { recursive: true });

  const whisperPath = path.join(sidecarDirectory, 'whisper-cli');
  const ffmpegPath = path.join(sidecarDirectory, 'ffmpeg');
  await writeFile(whisperPath, 'whisper');
  await writeFile(ffmpegPath, 'ffmpeg');
  await chmod(whisperPath, 0o755);
  await chmod(ffmpegPath, 0o755);
  await writeFile(
    path.join(resourcesRoot, 'models', 'ggml-small.en.bin'),
    'model',
  );
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('resolveEngineRuntime', () => {
  it('resolves the complete development runtime from app resources', async () => {
    const appPath = await makeTemporaryDirectory();
    const resourcesRoot = path.join(appPath, 'resources');
    await writeRuntime(resourcesRoot);

    const status = await resolveEngineRuntime({
      appPath,
      isPackaged: false,
      platform: 'darwin',
      arch: 'arm64',
      environment: {},
    });

    expect(status.ready).toBe(true);
    expect(status.runtime).toEqual({
      ffmpegPath: path.join(
        resourcesRoot,
        'sidecars',
        'darwin-arm64',
        'ffmpeg',
      ),
      modelPath: path.join(resourcesRoot, 'models', 'ggml-small.en.bin'),
      whisperPath: path.join(
        resourcesRoot,
        'sidecars',
        'darwin-arm64',
        'whisper-cli',
      ),
    });
  });

  it('accepts absolute overrides only during development', async () => {
    const appPath = await makeTemporaryDirectory();
    const overridesRoot = await makeTemporaryDirectory();
    const whisperPath = path.join(overridesRoot, 'whisper-cli');
    const ffmpegPath = path.join(overridesRoot, 'ffmpeg');
    const modelPath = path.join(overridesRoot, 'model.bin');
    await Promise.all([
      writeFile(whisperPath, 'whisper'),
      writeFile(ffmpegPath, 'ffmpeg'),
      writeFile(modelPath, 'model'),
    ]);
    await Promise.all([chmod(whisperPath, 0o755), chmod(ffmpegPath, 0o755)]);

    const status = await resolveEngineRuntime({
      appPath,
      isPackaged: false,
      platform: 'darwin',
      arch: 'arm64',
      environment: {
        SOTTO_WHISPER_PATH: whisperPath,
        SOTTO_FFMPEG_PATH: ffmpegPath,
        SOTTO_MODEL_PATH: modelPath,
      },
    });

    expect(status.ready).toBe(true);
    expect(status.runtime).toEqual({ ffmpegPath, modelPath, whisperPath });
    expect(status.components.whisper.source).toBe('override');
  });

  it('ignores overrides and uses process resources in packaged mode', async () => {
    const appPath = await makeTemporaryDirectory();
    const resourcesPath = await makeTemporaryDirectory();
    await writeRuntime(resourcesPath);

    const status = await resolveEngineRuntime({
      appPath,
      resourcesPath,
      isPackaged: true,
      platform: 'darwin',
      arch: 'arm64',
      environment: {
        SOTTO_WHISPER_PATH: '/untrusted/whisper-cli',
        SOTTO_FFMPEG_PATH: '/untrusted/ffmpeg',
        SOTTO_MODEL_PATH: '/untrusted/model.bin',
      },
    });

    expect(status.ready).toBe(true);
    expect(status.resourcesRoot).toBe(resourcesPath);
    expect(status.components.whisper.source).toBe('bundled');
    expect(status.runtime?.whisperPath.startsWith(resourcesPath)).toBe(true);
  });

  it('reports a relative development override without falling back silently', async () => {
    const appPath = await makeTemporaryDirectory();
    await writeRuntime(path.join(appPath, 'resources'));

    const status = await resolveEngineRuntime({
      appPath,
      isPackaged: false,
      platform: 'darwin',
      arch: 'arm64',
      environment: { SOTTO_FFMPEG_PATH: 'tools/ffmpeg' },
    });

    expect(status.ready).toBe(false);
    expect(status.components.ffmpeg).toEqual({
      path: 'tools/ffmpeg',
      source: 'override',
      state: 'invalid-override',
    });
  });

  it('reports missing and non-executable runtime components', async () => {
    const appPath = await makeTemporaryDirectory();
    const resourcesRoot = path.join(appPath, 'resources');
    await writeRuntime(resourcesRoot);
    const ffmpegPath = path.join(
      resourcesRoot,
      'sidecars',
      'darwin-arm64',
      'ffmpeg',
    );
    await chmod(ffmpegPath, fsConstants.S_IRUSR | fsConstants.S_IWUSR);
    await rm(path.join(resourcesRoot, 'models', 'ggml-small.en.bin'));

    const status = await resolveEngineRuntime({
      appPath,
      isPackaged: false,
      platform: 'darwin',
      arch: 'arm64',
      environment: {},
    });

    expect(status.ready).toBe(false);
    expect(status.components.ffmpeg.state).toBe('not-executable');
    expect(status.components.model.state).toBe('missing');
  });

  it('reports unsupported platform targets', async () => {
    const appPath = await makeTemporaryDirectory();

    const status = await resolveEngineRuntime({
      appPath,
      isPackaged: false,
      platform: 'linux',
      arch: 'x64',
      environment: {},
    });

    expect(status).toMatchObject({
      ready: false,
      reason: 'unsupported-platform',
      runtime: null,
    });
  });
});
