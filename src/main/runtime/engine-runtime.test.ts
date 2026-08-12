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

// Some cases below assert behaviour that only exists on POSIX hosts and cannot
// be reproduced on Windows:
//
//   - chmod(0o000) and stripping the execute bit are no-ops there. Windows
//     chmod only toggles the read-only attribute, and access(X_OK) is treated
//     as access(F_OK), so a file the test intends to be unreadable or
//     non-executable still resolves as 'ready'.
//   - cases that pin `platform: 'darwin'` while pointing at host temp paths.
//     resolveEngineRuntime validates overrides with path.posix on darwin, and a
//     Windows absolute path ("C:\...") is correctly not POSIX-absolute.
//
// Skipping keeps the Windows gate honest instead of asserting behaviour the
// platform does not have. See the executability note in the Windows gate.
const skipOnWindows = process.platform === 'win32';

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sotto-runtime-'));
  temporaryDirectories.push(directory);
  return directory;
};

const writeRuntime = async (
  resourcesRoot: string,
  speakerChildPath = path.join(
    path.dirname(resourcesRoot),
    'scripts',
    'speaker-diarization-child.cjs',
  ),
): Promise<void> => {
  const sidecarDirectory = path.join(
    resourcesRoot,
    'sidecars',
    'darwin-arm64',
  );
  await mkdir(sidecarDirectory, { recursive: true });
  await mkdir(path.join(resourcesRoot, 'models'), { recursive: true });
  await mkdir(path.join(resourcesRoot, 'diarization'), { recursive: true });
  await mkdir(
    path.join(resourcesRoot, 'speaker-runtime', 'sherpa-onnx-node'),
    { recursive: true },
  );
  await mkdir(path.dirname(speakerChildPath), { recursive: true });

  const whisperPath = path.join(sidecarDirectory, 'whisper-cli');
  const ffmpegPath = path.join(sidecarDirectory, 'ffmpeg');
  await writeFile(whisperPath, 'whisper');
  await writeFile(ffmpegPath, 'ffmpeg');
  await chmod(whisperPath, 0o755);
  await chmod(ffmpegPath, 0o755);
  await writeFile(
    path.join(resourcesRoot, 'models', 'ggml-large-v3-turbo.bin'),
    'model',
  );
  await writeFile(
    path.join(resourcesRoot, 'diarization', 'pyannote-segmentation-3.0.onnx'),
    'speaker segmentation model',
  );
  await writeFile(
    path.join(resourcesRoot, 'diarization', '3dspeaker-eres2net-base.onnx'),
    'speaker embedding model',
  );
  await writeFile(
    path.join(
      resourcesRoot,
      'speaker-runtime',
      'sherpa-onnx-node',
      'sherpa-onnx.js',
    ),
    'speaker module',
  );
  await writeFile(speakerChildPath, 'speaker child process');
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
      modelPath: path.join(resourcesRoot, 'models', 'ggml-large-v3-turbo.bin'),
      speakerDiarization: {
        childPath: path.join(appPath, 'scripts', 'speaker-diarization-child.cjs'),
        embeddingModelPath: path.join(
          resourcesRoot,
          'diarization',
          '3dspeaker-eres2net-base.onnx',
        ),
        modulePath: path.join(
          resourcesRoot,
          'speaker-runtime',
          'sherpa-onnx-node',
          'sherpa-onnx.js',
        ),
        segmentationModelPath: path.join(
          resourcesRoot,
          'diarization',
          'pyannote-segmentation-3.0.onnx',
        ),
      },
      whisperPath: path.join(
        resourcesRoot,
        'sidecars',
        'darwin-arm64',
        'whisper-cli',
      ),
    });
  });

  it.skipIf(skipOnWindows)('accepts absolute overrides only during development', async () => {
    const appPath = await makeTemporaryDirectory();
    const overridesRoot = await makeTemporaryDirectory();
    const whisperPath = path.join(overridesRoot, 'whisper-cli');
    const ffmpegPath = path.join(overridesRoot, 'ffmpeg');
    const modelPath = path.join(overridesRoot, 'model.bin');
    const speakerChildPath = path.join(overridesRoot, 'speaker-child.cjs');
    const speakerEmbeddingModelPath = path.join(overridesRoot, 'embedding.onnx');
    const speakerModulePath = path.join(overridesRoot, 'sherpa-onnx.js');
    const speakerSegmentationModelPath = path.join(overridesRoot, 'segmentation.onnx');
    await Promise.all([
      writeFile(whisperPath, 'whisper'),
      writeFile(ffmpegPath, 'ffmpeg'),
      writeFile(modelPath, 'model'),
      writeFile(speakerChildPath, 'child'),
      writeFile(speakerEmbeddingModelPath, 'embedding'),
      writeFile(speakerModulePath, 'module'),
      writeFile(speakerSegmentationModelPath, 'segmentation'),
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
        SOTTO_SPEAKER_CHILD_PATH: speakerChildPath,
        SOTTO_SPEAKER_EMBEDDING_MODEL_PATH: speakerEmbeddingModelPath,
        SOTTO_SPEAKER_MODULE_PATH: speakerModulePath,
        SOTTO_SPEAKER_SEGMENTATION_MODEL_PATH: speakerSegmentationModelPath,
      },
    });

    expect(status.ready).toBe(true);
    expect(status.runtime).toEqual({
      ffmpegPath,
      modelPath,
      speakerDiarization: {
        childPath: speakerChildPath,
        embeddingModelPath: speakerEmbeddingModelPath,
        modulePath: speakerModulePath,
        segmentationModelPath: speakerSegmentationModelPath,
      },
      whisperPath,
    });
    expect(status.components.whisper.source).toBe('override');
  });

  it('ignores overrides and uses process resources in packaged mode', async () => {
    const appPath = await makeTemporaryDirectory();
    const resourcesPath = await makeTemporaryDirectory();
    await writeRuntime(
      resourcesPath,
      path.join(resourcesPath, 'speaker-diarization-child.cjs'),
    );

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
    expect(status.runtime?.speakerDiarization?.childPath).toBe(
      path.join(resourcesPath, 'speaker-diarization-child.cjs'),
    );
  });

  it('resolves a verified managed model outside packaged resources', async () => {
    const appPath = await makeTemporaryDirectory();
    const resourcesPath = await makeTemporaryDirectory();
    const managedModelPath = path.join(
      await makeTemporaryDirectory(),
      'ggml-large-v3-turbo.bin',
    );
    await writeRuntime(
      resourcesPath,
      path.join(resourcesPath, 'speaker-diarization-child.cjs'),
    );
    await writeFile(managedModelPath, 'managed model');

    const status = await resolveEngineRuntime({
      appPath,
      resourcesPath,
      isPackaged: true,
      platform: 'darwin',
      arch: 'arm64',
      managedModelPath,
    });

    expect(status.ready).toBe(true);
    expect(status.components.model).toEqual({
      path: managedModelPath,
      source: 'managed',
      state: 'ready',
    });
    expect(status.runtime?.modelPath).toBe(managedModelPath);
  });

  it.skipIf(skipOnWindows)('keeps Whisper ready when optional speaker resources are unavailable', async () => {
    const appPath = await makeTemporaryDirectory();
    const resourcesRoot = path.join(appPath, 'resources');
    await writeRuntime(resourcesRoot);
    const embeddingPath = path.join(
      resourcesRoot,
      'diarization',
      '3dspeaker-eres2net-base.onnx',
    );
    const modulePath = path.join(
      resourcesRoot,
      'speaker-runtime',
      'sherpa-onnx-node',
      'sherpa-onnx.js',
    );
    await rm(embeddingPath);
    await chmod(modulePath, 0o000);

    const status = await resolveEngineRuntime({
      appPath,
      isPackaged: false,
      platform: 'darwin',
      arch: 'arm64',
      environment: {},
    });

    expect(status.ready).toBe(true);
    expect(status.runtime?.speakerDiarization).toBeNull();
    expect(status.components.speakerEmbeddingModel.state).toBe('missing');
    expect(status.components.speakerModule.state).toBe('not-readable');
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

  it.skipIf(skipOnWindows)('reports missing and non-executable runtime components', async () => {
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
    await rm(path.join(resourcesRoot, 'models', 'ggml-large-v3-turbo.bin'));

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
