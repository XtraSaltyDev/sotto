import { constants as fsConstants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_TRANSCRIPTION_MODEL } from '../../shared/default-transcription-model';
import { resolveWhisperSidecarTarget } from '../sidecars/sidecar-resolver';

export const ENGINE_OVERRIDE_ENVIRONMENT = {
  ffmpeg: 'SOTTO_FFMPEG_PATH',
  model: 'SOTTO_MODEL_PATH',
  speakerChild: 'SOTTO_SPEAKER_CHILD_PATH',
  speakerEmbeddingModel: 'SOTTO_SPEAKER_EMBEDDING_MODEL_PATH',
  speakerModule: 'SOTTO_SPEAKER_MODULE_PATH',
  speakerSegmentationModel: 'SOTTO_SPEAKER_SEGMENTATION_MODEL_PATH',
  whisper: 'SOTTO_WHISPER_PATH',
} as const;

export interface SpeakerDiarizationRuntime {
  readonly childPath: string;
  readonly embeddingModelPath: string;
  readonly modulePath: string;
  readonly segmentationModelPath: string;
}

export interface EngineRuntime {
  readonly ffmpegPath: string;
  readonly modelPath: string;
  /** Speaker labels are an optional enhancement and never gate Whisper. */
  readonly speakerDiarization: SpeakerDiarizationRuntime | null;
  readonly whisperPath: string;
}

export type EngineComponentState =
  | 'ready'
  | 'missing'
  | 'not-a-file'
  | 'empty'
  | 'not-readable'
  | 'not-executable'
  | 'invalid-override'
  | 'unsupported-platform';

export interface EngineComponentStatus {
  readonly path: string | null;
  readonly state: EngineComponentState;
  readonly source: 'bundled' | 'managed' | 'override';
}

export interface EngineComponentsStatus {
  readonly ffmpeg: EngineComponentStatus;
  readonly model: EngineComponentStatus;
  readonly speakerChild: EngineComponentStatus;
  readonly speakerEmbeddingModel: EngineComponentStatus;
  readonly speakerModule: EngineComponentStatus;
  readonly speakerSegmentationModel: EngineComponentStatus;
  readonly whisper: EngineComponentStatus;
}

export type EngineStatus =
  | {
      readonly ready: true;
      readonly state: 'ready';
      readonly resourcesRoot: string;
      readonly runtime: EngineRuntime;
      readonly components: EngineComponentsStatus;
    }
  | {
      readonly ready: false;
      readonly state: 'unavailable';
      readonly reason: 'unsupported-platform' | 'runtime-files-unavailable';
      readonly resourcesRoot: string;
      readonly runtime: null;
      readonly components: EngineComponentsStatus;
    };

export interface ResolveEngineRuntimeOptions {
  readonly isPackaged: boolean;
  readonly appPath: string;
  readonly resourcesPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly managedModelPath?: string;
}

type EngineComponentName = keyof EngineComponentsStatus;

interface CandidatePath {
  readonly path: string;
  readonly source: 'bundled' | 'managed' | 'override';
  readonly invalidOverride: boolean;
}

const unavailableComponent = (
  state: EngineComponentState,
  filePath: string | null = null,
  source: 'bundled' | 'managed' | 'override' = 'bundled',
): EngineComponentStatus => ({ path: filePath, source, state });

const resolveCandidate = (
  component: EngineComponentName,
  bundledPath: string,
  options: ResolveEngineRuntimeOptions,
  platform: NodeJS.Platform,
): CandidatePath => {
  const override = options.environment?.[
    ENGINE_OVERRIDE_ENVIRONMENT[component]
  ] ?? (options.environment === undefined
    ? process.env[ENGINE_OVERRIDE_ENVIRONMENT[component]]
    : undefined);

  // Packaged applications always use files inside process.resourcesPath.
  if (options.isPackaged || override === undefined || override.length === 0) {
    return {
      path: bundledPath,
      source: 'bundled',
      invalidOverride: false,
    };
  }

  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  return {
    path: override,
    source: 'override',
    invalidOverride: !platformPath.isAbsolute(override),
  };
};

const inspectComponent = async (
  candidate: CandidatePath,
  executable: boolean,
): Promise<EngineComponentStatus> => {
  if (candidate.invalidOverride) {
    return unavailableComponent(
      'invalid-override',
      candidate.path,
      candidate.source,
    );
  }

  let stats;
  try {
    stats = await lstat(candidate.path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return unavailableComponent(
      code === 'ENOENT' ? 'missing' : 'not-readable',
      candidate.path,
      candidate.source,
    );
  }

  // Reject directories and symbolic links. Runtime files must be the regular
  // files staged into the trusted resources tree (or explicit dev files).
  if (!stats.isFile()) {
    return unavailableComponent(
      'not-a-file',
      candidate.path,
      candidate.source,
    );
  }

  if (stats.size === 0) {
    return unavailableComponent('empty', candidate.path, candidate.source);
  }

  try {
    await access(candidate.path, fsConstants.R_OK);
  } catch {
    return unavailableComponent(
      'not-readable',
      candidate.path,
      candidate.source,
    );
  }

  if (executable) {
    try {
      await access(candidate.path, fsConstants.X_OK);
    } catch {
      return unavailableComponent(
        'not-executable',
        candidate.path,
        candidate.source,
      );
    }
  }

  return {
    path: candidate.path,
    source: candidate.source,
    state: 'ready',
  };
};

const assertAbsoluteRoot = (root: string, label: string): void => {
  if (!path.isAbsolute(root)) {
    throw new TypeError(`${label} must be an absolute path.`);
  }
};

/**
 * Resolves and validates the complete local engine runtime. Development uses
 * `<appPath>/resources`; packaged builds use `process.resourcesPath` supplied
 * by the caller. SOTTO_* overrides are considered only in development.
 */
export const resolveEngineRuntime = async (
  options: ResolveEngineRuntimeOptions,
): Promise<EngineStatus> => {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const electronResourcesPath = (
    process as NodeJS.Process & { resourcesPath?: string }
  ).resourcesPath;
  const resourcesRoot = options.isPackaged
    ? (options.resourcesPath ?? electronResourcesPath)
    : path.join(options.appPath, 'resources');

  assertAbsoluteRoot(options.appPath, 'appPath');
  if (resourcesRoot === undefined) {
    throw new TypeError(
      'resourcesPath is required outside an Electron packaged process.',
    );
  }
  assertAbsoluteRoot(resourcesRoot, 'resourcesPath');

  const target = resolveWhisperSidecarTarget(platform, arch);
  if (!target) {
    const components: EngineComponentsStatus = {
      ffmpeg: unavailableComponent('unsupported-platform'),
      model: unavailableComponent('unsupported-platform'),
      speakerChild: unavailableComponent('unsupported-platform'),
      speakerEmbeddingModel: unavailableComponent('unsupported-platform'),
      speakerModule: unavailableComponent('unsupported-platform'),
      speakerSegmentationModel: unavailableComponent('unsupported-platform'),
      whisper: unavailableComponent('unsupported-platform'),
    };

    return {
      ready: false,
      state: 'unavailable',
      reason: 'unsupported-platform',
      resourcesRoot,
      runtime: null,
      components,
    };
  }

  const sidecarDirectory = path.join(resourcesRoot, target.resourceDirectory);
  const bundledPaths = {
    ffmpegPath: path.join(
      sidecarDirectory,
      platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
    ),
    modelPath: path.join(
      resourcesRoot,
      'models',
      DEFAULT_TRANSCRIPTION_MODEL.fileName,
    ),
    speakerChildPath: options.isPackaged
      ? path.join(resourcesRoot, 'speaker-diarization-child.cjs')
      : path.join(options.appPath, 'scripts', 'speaker-diarization-child.cjs'),
    speakerEmbeddingModelPath: path.join(
      resourcesRoot,
      'diarization',
      '3dspeaker-eres2net-base.onnx',
    ),
    speakerModulePath: path.join(
      resourcesRoot,
      'speaker-runtime',
      'sherpa-onnx-node',
      'sherpa-onnx.js',
    ),
    speakerSegmentationModelPath: path.join(
      resourcesRoot,
      'diarization',
      'pyannote-segmentation-3.0.onnx',
    ),
    whisperPath: path.join(sidecarDirectory, target.executableName),
  };

  const candidates = {
    ffmpeg: resolveCandidate(
      'ffmpeg',
      bundledPaths.ffmpegPath,
      options,
      platform,
    ),
    model: options.managedModelPath
      ? {
          path: options.managedModelPath,
          source: 'managed' as const,
          invalidOverride: !path.isAbsolute(options.managedModelPath),
        }
      : resolveCandidate('model', bundledPaths.modelPath, options, platform),
    speakerChild: resolveCandidate(
      'speakerChild',
      bundledPaths.speakerChildPath,
      options,
      platform,
    ),
    speakerEmbeddingModel: resolveCandidate(
      'speakerEmbeddingModel',
      bundledPaths.speakerEmbeddingModelPath,
      options,
      platform,
    ),
    speakerModule: resolveCandidate(
      'speakerModule',
      bundledPaths.speakerModulePath,
      options,
      platform,
    ),
    speakerSegmentationModel: resolveCandidate(
      'speakerSegmentationModel',
      bundledPaths.speakerSegmentationModelPath,
      options,
      platform,
    ),
    whisper: resolveCandidate(
      'whisper',
      bundledPaths.whisperPath,
      options,
      platform,
    ),
  } as const;

  const [
    ffmpeg,
    model,
    speakerChild,
    speakerEmbeddingModel,
    speakerModule,
    speakerSegmentationModel,
    whisper,
  ] = await Promise.all([
    inspectComponent(candidates.ffmpeg, true),
    inspectComponent(candidates.model, false),
    inspectComponent(candidates.speakerChild, false),
    inspectComponent(candidates.speakerEmbeddingModel, false),
    inspectComponent(candidates.speakerModule, false),
    inspectComponent(candidates.speakerSegmentationModel, false),
    inspectComponent(candidates.whisper, true),
  ]);
  const components: EngineComponentsStatus = {
    ffmpeg,
    model,
    speakerChild,
    speakerEmbeddingModel,
    speakerModule,
    speakerSegmentationModel,
    whisper,
  };

  if (
    ffmpeg.state !== 'ready' ||
    model.state !== 'ready' ||
    whisper.state !== 'ready' ||
    ffmpeg.path === null ||
    model.path === null ||
    whisper.path === null
  ) {
    return {
      ready: false,
      state: 'unavailable',
      reason: 'runtime-files-unavailable',
      resourcesRoot,
      runtime: null,
      components,
    };
  }

  const speakerDiarization =
    speakerChild.state === 'ready' &&
    speakerEmbeddingModel.state === 'ready' &&
    speakerModule.state === 'ready' &&
    speakerSegmentationModel.state === 'ready' &&
    speakerChild.path !== null &&
    speakerEmbeddingModel.path !== null &&
    speakerModule.path !== null &&
    speakerSegmentationModel.path !== null
      ? {
          childPath: speakerChild.path,
          embeddingModelPath: speakerEmbeddingModel.path,
          modulePath: speakerModule.path,
          segmentationModelPath: speakerSegmentationModel.path,
        }
      : null;

  return {
    ready: true,
    state: 'ready',
    resourcesRoot,
    runtime: {
      ffmpegPath: ffmpeg.path,
      modelPath: model.path,
      speakerDiarization,
      whisperPath: whisper.path,
    },
    components,
  };
};
