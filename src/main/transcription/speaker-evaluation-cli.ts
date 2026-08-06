import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { normalizeMediaToWav } from '../media/media-normalizer';
import { resolveEngineRuntime, type EngineRuntime } from '../runtime/engine-runtime';
import { alignTranscriptSpeakers } from './speaker-alignment';
import {
  normalizeDiarizationSegments,
  type SpeakerDiarizationSegment,
} from './speaker-diarization';
import {
  applyExperimentEmbeddingConsolidation,
  applyExperimentFilteredFragmentRecovery,
  applyExperimentNovelSpeakerPreservation,
  applyExperimentSegmentAnchorReassignment,
  buildFirstPackConfigurations,
  compareSpeakerAccuracyMetrics,
  isClusterSimilarityRecoveryMode,
  isEmbeddingConsolidationRecoveryMode,
  isNovelSpeakerRecoveryMode,
  isSegmentAnchorReassignmentRecoveryMode,
  parseSpeakerAnnotation,
  scoreSpeakerAccuracy,
  shiftDiarizationSegments,
  summarizeDiarizationChurn,
  summarizeRawDiarization,
  validateSpeakerEvaluationConfiguration,
  type DiarizationChurnSummary,
  type RawDiarizationSummary,
  type SpeakerAccuracyMetrics,
  type SpeakerClusterSimilarityAnalysis,
  type SpeakerClusterSimilarityMatch,
  type SpeakerEvaluationConfiguration,
  type SpeakerRecoveryDiagnostics,
  type SupportedClusterSimilarity,
  type SupportedClusterSegmentAnchorMatch,
  type SupportedClusterSegmentConsistency,
} from './speaker-evaluation';
import {
  parseWhisperOutputJson,
  type NormalizedWhisperOutput,
} from './whisper-output';
import {
  parseTranscriptionReference,
  scoreTranscriptionAccuracy,
  type TranscriptionAccuracyMetrics,
} from './transcription-evaluation';

const INPUT_SCHEMA_VERSION = 1;
const CHILD_PROTOCOL_VERSION = 1;
const MAX_CHILD_OUTPUT_BYTES = 32 * 1_024 * 1_024;
const MAX_DIAGNOSTIC_BYTES = 1 * 1_024 * 1_024;
const SEGMENT_GUARD_MINIMUM_MEDIAN_SIMILARITY = 0.4;
const EXPERIMENT_CHILD = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'scripts',
  'speaker-accuracy-diarization-child.cjs',
);
const CLUSTER_SIMILARITY_CHILD = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'scripts',
  'speaker-accuracy-cluster-similarity-child.cjs',
);

interface EvaluationInput {
  name: string;
  mediaPath: string | null;
  normalizedWavPath: string | null;
  whisperJsonPath: string | null;
  annotationPath: string | null;
  transcriptReferencePath: string | null;
  outputDirectory: string;
  configurations: SpeakerEvaluationConfiguration[] | null;
}

interface ChildResources {
  wallTimeMs: number;
  userCpuMs: number;
  systemCpuMs: number;
  peakRssBytes: number;
  voluntaryContextSwitches: number;
  involuntaryContextSwitches: number;
  threadSetting: number;
}

interface DiarizationRun {
  segments: SpeakerDiarizationSegment[];
  resources: ChildResources;
  outputBytes: number;
}

interface ClusterSimilarityRun extends SpeakerClusterSimilarityAnalysis {
  embeddingDimension: number;
  maximumSecondsPerCluster: number;
  maximumSegmentsPerCluster: number;
  maximumSecondsPerSegment: number;
  embeddedClusterCount: number;
  skippedClusterCount: number;
  embeddedSegmentCount: number;
  skippedSegmentEmbeddingCount: number;
  segmentConsistency: SupportedClusterSegmentConsistency[];
  segmentAnchorMatches: SupportedClusterSegmentAnchorMatch[];
  resources: ChildResources;
  outputBytes: number;
}

interface ConfigurationResult {
  configuration: SpeakerEvaluationConfiguration;
  rawDiarization: RawDiarizationSummary;
  churn: DiarizationChurnSummary;
  shiftedAlignmentInput: RawDiarizationSummary;
  alignedSpeakerCount: number;
  labeledWordCount: number;
  unclearWordCount: number;
  segmentConsistency: SupportedClusterSegmentConsistency[] | null;
  recovery: SpeakerRecoveryDiagnostics & {
    alignmentWallTimeMs: number;
    similarityCacheReused: boolean | null;
    similarityWallTimeMs: number;
    similarityCpuTimeMs: number;
    similarityPeakRssBytes: number;
  };
  resources: ChildResources & {
    cpuTimeMs: number;
    observedCpuPercent: number;
    realTimeFactor: number | null;
    rawOutputBytes: number;
    diarizationCacheReused: boolean;
  };
  accuracy: SpeakerAccuracyMetrics | null;
  comparison: 'baseline' | 'win' | 'regression' | 'tie' | 'inconclusive';
}

interface ExperimentReport {
  schemaVersion: 1;
  experiment: string;
  generatedAt: string;
  privacy: string;
  inputs: {
    mediaKind: 'local-media' | 'normalized-wav';
    normalizedWavReused: boolean;
    whisperJsonReused: boolean;
    annotationAvailable: boolean;
    transcriptReferenceAvailable: boolean;
    durationMs: number;
  };
  runtime: {
    engine: string;
    segmentationModelBytes: number;
    embeddingModelBytes: number;
    speakerRuntimeBytes: number;
    totalSpeakerArtifactBytes: number;
    perConfigurationArtifactDeltaBytes: number;
  };
  preprocessing: {
    normalizationWallTimeMs: number;
    whisperWallTimeMs: number;
  };
  transcriptionAccuracy: TranscriptionAccuracyMetrics | null;
  configurations: ConfigurationResult[];
  conclusion: {
    wins: string[];
    regressions: string[];
    ties: string[];
    inconclusive: string[];
    productionRecommendation: string;
  };
}

interface SpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
  wallTimeMs: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const fail = (message: string): never => {
  throw new TypeError(message);
};

const resolveOptionalPath = (
  value: unknown,
  baseDirectory: string,
  field: string,
): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    return fail(`${field} must be a non-empty file path when present.`);
  }
  return path.resolve(baseDirectory, value);
};

const parseEvaluationInput = (
  value: unknown,
  configPath: string,
  repositoryRoot: string,
): EvaluationInput => {
  if (!isRecord(value) || value.schemaVersion !== INPUT_SCHEMA_VERSION) {
    return fail('Evaluation input must use schemaVersion 1.');
  }
  const name = value.name;
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(name)) {
    return fail('Evaluation name must be a safe, short identifier.');
  }
  const configDirectory = path.dirname(configPath);
  const mediaPath = resolveOptionalPath(value.mediaPath, configDirectory, 'mediaPath');
  const normalizedWavPath = resolveOptionalPath(
    value.normalizedWavPath,
    configDirectory,
    'normalizedWavPath',
  );
  if ((mediaPath === null) === (normalizedWavPath === null)) {
    return fail('Provide exactly one of mediaPath or normalizedWavPath.');
  }
  if (normalizedWavPath && path.extname(normalizedWavPath).toLowerCase() !== '.wav') {
    return fail('normalizedWavPath must use a .wav extension.');
  }
  const whisperJsonPath = resolveOptionalPath(
    value.whisperJsonPath,
    configDirectory,
    'whisperJsonPath',
  );
  const annotationPath = resolveOptionalPath(
    value.annotationPath,
    configDirectory,
    'annotationPath',
  );
  const transcriptReferencePath = resolveOptionalPath(
    value.transcriptReferencePath,
    configDirectory,
    'transcriptReferencePath',
  );
  const outputDirectoryValue = value.outputDirectory;
  const outputDirectory = outputDirectoryValue === undefined
    ? path.join(repositoryRoot, '.sotto-speaker-eval', 'runs', name)
    : resolveOptionalPath(outputDirectoryValue, configDirectory, 'outputDirectory');
  if (!outputDirectory) return fail('outputDirectory cannot be null.');
  let configurations: SpeakerEvaluationConfiguration[] | null = null;
  if (value.configurations !== undefined) {
    if (!Array.isArray(value.configurations) || value.configurations.length === 0) {
      return fail('configurations must be a non-empty array when present.');
    }
    configurations = value.configurations.map(validateSpeakerEvaluationConfiguration);
    if (new Set(configurations.map((entry) => entry.name)).size !== configurations.length) {
      return fail('Configuration names must be unique.');
    }
  }
  return {
    name,
    mediaPath,
    normalizedWavPath,
    whisperJsonPath,
    annotationPath,
    transcriptReferencePath,
    outputDirectory,
    configurations,
  };
};

const hashFile = async (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });

const spawnCapture = async (
  executable: string,
  args: readonly string[],
  maximumStdoutBytes = MAX_CHILD_OUTPUT_BYTES,
): Promise<SpawnResult> => {
  const started = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killedForSize = false;
    child.stdout.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.byteLength;
      if (stdoutBytes > maximumStdoutBytes) {
        killedForSize = true;
        child.kill();
        return;
      }
      stdout.push(buffer);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      if (stderrBytes >= MAX_DIAGNOSTIC_BYTES) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const bounded = buffer.subarray(0, MAX_DIAGNOSTIC_BYTES - stderrBytes);
      stderrBytes += bounded.byteLength;
      stderr.push(bounded);
    });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => {
      if (killedForSize) {
        reject(new Error('A local experiment process exceeded its output limit.'));
        return;
      }
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout, stdoutBytes),
        stderr: Buffer.concat(stderr, stderrBytes).toString('utf8').trim(),
        wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      });
    });
  });
};

const runWhisper = async (
  runtime: EngineRuntime,
  wavPath: string,
  outputPrefix: string,
): Promise<number> => {
  const baseArgs = [
    '--model',
    runtime.modelPath,
    '--file',
    wavPath,
    '--language',
    'en',
    '--output-json-full',
    '--output-file',
    outputPrefix,
    '--no-prints',
  ];
  let result = await spawnCapture(runtime.whisperPath, baseArgs, 1_024 * 1_024);
  const metalFailure =
    result.exitCode === 139 ||
    result.signal === 'SIGSEGV' ||
    /ggml_metal|metal.*(?:failed|error)/iu.test(result.stderr);
  if (result.exitCode !== 0 && metalFailure) {
    result = await spawnCapture(
      runtime.whisperPath,
      [...baseArgs, '--no-gpu'],
      1_024 * 1_024,
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `Whisper failed during the local experiment${result.stderr ? `: ${result.stderr.slice(-500)}` : '.'}`,
    );
  }
  return result.wallTimeMs;
};

const readChildResources = (value: unknown): ChildResources => {
  if (!isRecord(value)) return fail('The experiment child omitted resource metrics.');
  const fields = [
    'wallTimeMs',
    'userCpuMs',
    'systemCpuMs',
    'peakRssBytes',
    'voluntaryContextSwitches',
    'involuntaryContextSwitches',
    'threadSetting',
  ] as const;
  for (const field of fields) {
    if (typeof value[field] !== 'number' || !Number.isFinite(value[field] as number)) {
      return fail(`The experiment child returned invalid ${field}.`);
    }
  }
  return Object.fromEntries(fields.map((field) => [field, value[field]])) as unknown as ChildResources;
};

const runDiarization = async (
  runtime: EngineRuntime,
  wavPath: string,
  configuration: SpeakerEvaluationConfiguration,
): Promise<DiarizationRun> => {
  const speaker = runtime.speakerDiarization;
  if (!speaker) throw new Error('The local speaker runtime is unavailable.');
  const childConfiguration = JSON.stringify({
    clusteringThreshold: configuration.clusteringThreshold,
    expectedSpeakerCount: configuration.expectedSpeakerCount,
    minDurationOff: configuration.minDurationOff,
    minDurationOn: configuration.minDurationOn,
  });
  const result = await spawnCapture(process.execPath, [
    EXPERIMENT_CHILD,
    speaker.modulePath,
    wavPath,
    speaker.segmentationModelPath,
    speaker.embeddingModelPath,
    childConfiguration,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Speaker configuration ${configuration.name} failed${result.stderr ? `: ${result.stderr}` : '.'}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.toString('utf8')) as unknown;
  } catch {
    return fail(`Speaker configuration ${configuration.name} returned invalid JSON.`);
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== CHILD_PROTOCOL_VERSION ||
    parsed.outcome !== 'completed'
  ) {
    return fail(`Speaker configuration ${configuration.name} returned an unsupported result.`);
  }
  return {
    segments: normalizeDiarizationSegments(parsed.segments),
    resources: readChildResources(parsed.resources),
    outputBytes: result.stdout.byteLength,
  };
};

const parseCachedDiarization = (value: unknown): DiarizationRun => {
  if (!isRecord(value) || !Array.isArray(value.segments)) {
    return fail('A cached diarization result was invalid.');
  }
  const segments = value.segments.map((candidate, index): SpeakerDiarizationSegment => {
    if (
      !isRecord(candidate) ||
      !Number.isSafeInteger(candidate.startMs) ||
      !Number.isSafeInteger(candidate.endMs) ||
      !Number.isSafeInteger(candidate.cluster) ||
      (candidate.startMs as number) < 0 ||
      (candidate.endMs as number) <= (candidate.startMs as number) ||
      (candidate.cluster as number) < 0
    ) {
      return fail(`Cached diarization segment ${index} was invalid.`);
    }
    return {
      startMs: candidate.startMs as number,
      endMs: candidate.endMs as number,
      cluster: candidate.cluster as number,
    };
  });
  if (!Number.isSafeInteger(value.outputBytes) || (value.outputBytes as number) < 0) {
    return fail('The cached diarization output size was invalid.');
  }
  return {
    segments,
    resources: readChildResources(value.resources),
    outputBytes: value.outputBytes as number,
  };
};

const readSimilarityNumber = (
  value: unknown,
  field: string,
  allowNull = false,
): number | null => {
  if (allowNull && value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail(`Cluster similarity returned invalid ${field}.`);
  }
  return value;
};

export const parseClusterSimilarityRun = (value: unknown): ClusterSimilarityRun => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.supportedSimilarities) ||
    !Array.isArray(value.matches) ||
    !Array.isArray(value.segmentConsistency) ||
    !Array.isArray(value.segmentAnchorMatches) ||
    value.supportedSimilarities.length > 66 ||
    value.matches.length > 2_000 ||
    value.segmentConsistency.length > 12 ||
    value.segmentAnchorMatches.length > 144
  ) {
    return fail('A cluster-similarity result was invalid.');
  }
  const supportedSimilarities = value.supportedSimilarities.map(
    (candidate, index): SupportedClusterSimilarity => {
      if (
        !isRecord(candidate) ||
        !Number.isSafeInteger(candidate.leftCluster) ||
        !Number.isSafeInteger(candidate.rightCluster) ||
        (candidate.leftCluster as number) < 0 ||
        (candidate.rightCluster as number) < 0
      ) {
        return fail(`Reliable-cluster similarity ${index} was invalid.`);
      }
      const similarity = readSimilarityNumber(
        candidate.similarity,
        `supportedSimilarities[${index}].similarity`,
      ) as number;
      if (similarity < -1 || similarity > 1) {
        return fail(`Reliable-cluster similarity ${index} was out of bounds.`);
      }
      return {
        leftCluster: candidate.leftCluster as number,
        rightCluster: candidate.rightCluster as number,
        similarity,
      };
    },
  );
  const matches = value.matches.map((candidate, index): SpeakerClusterSimilarityMatch => {
    if (
      !isRecord(candidate) ||
      !Number.isSafeInteger(candidate.cluster) ||
      (candidate.cluster as number) < 0 ||
      !Number.isSafeInteger(candidate.sampleDurationMs) ||
      (candidate.sampleDurationMs as number) < 0 ||
      typeof candidate.ready !== 'boolean'
    ) {
      return fail(`Filtered-cluster similarity ${index} was invalid.`);
    }
    const nearestSupportedCluster = candidate.nearestSupportedCluster;
    if (
      nearestSupportedCluster !== null &&
      (!Number.isSafeInteger(nearestSupportedCluster) ||
        (nearestSupportedCluster as number) < 0)
    ) {
      return fail(`Filtered-cluster similarity ${index} had an invalid match.`);
    }
    const similarity = readSimilarityNumber(
      candidate.similarity,
      `matches[${index}].similarity`,
      true,
    );
    const secondSimilarity = readSimilarityNumber(
      candidate.secondSimilarity,
      `matches[${index}].secondSimilarity`,
      true,
    );
    const margin = readSimilarityNumber(
      candidate.margin,
      `matches[${index}].margin`,
      true,
    );
    for (const score of [similarity, secondSimilarity]) {
      if (score !== null && (score < -1 || score > 1)) {
        return fail(`Filtered-cluster similarity ${index} was out of bounds.`);
      }
    }
    return {
      cluster: candidate.cluster as number,
      sampleDurationMs: candidate.sampleDurationMs as number,
      ready: candidate.ready,
      nearestSupportedCluster: nearestSupportedCluster as number | null,
      similarity,
      secondSimilarity,
      margin,
    };
  });
  const segmentConsistency = value.segmentConsistency.map(
    (candidate, index): SupportedClusterSegmentConsistency => {
      if (
        !isRecord(candidate) ||
        !Number.isSafeInteger(candidate.cluster) ||
        (candidate.cluster as number) < 0
      ) {
        return fail(`Segment consistency ${index} was invalid.`);
      }
      const countFields = [
        'totalSegmentCount',
        'selectedSegmentCount',
        'readySegmentCount',
        'skippedSegmentCount',
        'pairCount',
      ] as const;
      for (const field of countFields) {
        if (!Number.isSafeInteger(candidate[field]) || (candidate[field] as number) < 0) {
          return fail(`Segment consistency ${index} had an invalid ${field}.`);
        }
      }
      const totalSegmentCount = candidate.totalSegmentCount as number;
      const selectedSegmentCount = candidate.selectedSegmentCount as number;
      const readySegmentCount = candidate.readySegmentCount as number;
      const skippedSegmentCount = candidate.skippedSegmentCount as number;
      const pairCount = candidate.pairCount as number;
      if (
        selectedSegmentCount > totalSegmentCount ||
        selectedSegmentCount !== readySegmentCount + skippedSegmentCount ||
        pairCount !== readySegmentCount * (readySegmentCount - 1) / 2
      ) {
        return fail(`Segment consistency ${index} had conflicting counts.`);
      }
      const minimumSimilarity = readSimilarityNumber(
        candidate.minimumSimilarity,
        `segmentConsistency[${index}].minimumSimilarity`,
        true,
      );
      const medianSimilarity = readSimilarityNumber(
        candidate.medianSimilarity,
        `segmentConsistency[${index}].medianSimilarity`,
        true,
      );
      const maximumSimilarity = readSimilarityNumber(
        candidate.maximumSimilarity,
        `segmentConsistency[${index}].maximumSimilarity`,
        true,
      );
      const similarities = [minimumSimilarity, medianSimilarity, maximumSimilarity];
      if (
        similarities.some((score) => score !== null && (score < -1 || score > 1)) ||
        (pairCount === 0 && similarities.some((score) => score !== null)) ||
        (pairCount > 0 && similarities.some((score) => score === null)) ||
        (minimumSimilarity !== null && medianSimilarity !== null &&
          maximumSimilarity !== null &&
          (minimumSimilarity > medianSimilarity || medianSimilarity > maximumSimilarity))
      ) {
        return fail(`Segment consistency ${index} had invalid similarities.`);
      }
      return {
        cluster: candidate.cluster as number,
        totalSegmentCount,
        selectedSegmentCount,
        readySegmentCount,
        skippedSegmentCount,
        pairCount,
        minimumSimilarity,
        medianSimilarity,
        maximumSimilarity,
      };
    },
  );
  if (new Set(segmentConsistency.map((entry) => entry.cluster)).size !==
    segmentConsistency.length) {
    return fail('Segment consistency repeated a cluster.');
  }
  const segmentAnchorMatches = value.segmentAnchorMatches.map(
    (candidate, index): SupportedClusterSegmentAnchorMatch => {
      if (
        !isRecord(candidate) ||
        !Number.isSafeInteger(candidate.cluster) ||
        (candidate.cluster as number) < 0 ||
        !Number.isSafeInteger(candidate.startMs) ||
        (candidate.startMs as number) < 0 ||
        !Number.isSafeInteger(candidate.endMs) ||
        (candidate.endMs as number) <= (candidate.startMs as number) ||
        !Number.isSafeInteger(candidate.sampleDurationMs) ||
        (candidate.sampleDurationMs as number) < 0 ||
        typeof candidate.ready !== 'boolean'
      ) {
        return fail(`Segment anchor match ${index} was invalid.`);
      }
      const nearestOtherSupportedCluster = candidate.nearestOtherSupportedCluster;
      if (
        nearestOtherSupportedCluster !== null &&
        (!Number.isSafeInteger(nearestOtherSupportedCluster) ||
          (nearestOtherSupportedCluster as number) < 0 ||
          (nearestOtherSupportedCluster as number) === (candidate.cluster as number))
      ) {
        return fail(`Segment anchor match ${index} had an invalid match.`);
      }
      const similarity = readSimilarityNumber(
        candidate.similarity,
        `segmentAnchorMatches[${index}].similarity`,
        true,
      );
      const secondSimilarity = readSimilarityNumber(
        candidate.secondSimilarity,
        `segmentAnchorMatches[${index}].secondSimilarity`,
        true,
      );
      const margin = readSimilarityNumber(
        candidate.margin,
        `segmentAnchorMatches[${index}].margin`,
        true,
      );
      if (
        [similarity, secondSimilarity].some(
          (score) => score !== null && (score < -1 || score > 1),
        ) ||
        (margin !== null && (margin < 0 || margin > 2)) ||
        (!candidate.ready &&
          (nearestOtherSupportedCluster !== null ||
            similarity !== null ||
            secondSimilarity !== null ||
            margin !== null)) ||
        (candidate.ready &&
          ((nearestOtherSupportedCluster === null) !== (similarity === null))) ||
        (secondSimilarity === null && margin !== null) ||
        (secondSimilarity !== null && margin === null) ||
        (similarity !== null && secondSimilarity !== null &&
          similarity < secondSimilarity) ||
        (similarity !== null && secondSimilarity !== null && margin !== null &&
          Math.abs(margin - (similarity - secondSimilarity)) > 0.000_001)
      ) {
        return fail(`Segment anchor match ${index} had invalid similarities.`);
      }
      return {
        cluster: candidate.cluster as number,
        startMs: candidate.startMs as number,
        endMs: candidate.endMs as number,
        sampleDurationMs: candidate.sampleDurationMs as number,
        ready: candidate.ready,
        nearestOtherSupportedCluster: nearestOtherSupportedCluster as number | null,
        similarity,
        secondSimilarity,
        margin,
      };
    },
  );
  const integerFields = [
    'embeddingDimension',
    'embeddedClusterCount',
    'skippedClusterCount',
    'maximumSegmentsPerCluster',
    'embeddedSegmentCount',
    'skippedSegmentEmbeddingCount',
    'outputBytes',
  ] as const;
  for (const field of integerFields) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) {
      return fail(`Cluster similarity returned invalid ${field}.`);
    }
  }
  const maximumSecondsPerCluster = readSimilarityNumber(
    value.maximumSecondsPerCluster,
    'maximumSecondsPerCluster',
  ) as number;
  if (maximumSecondsPerCluster < 1 || maximumSecondsPerCluster > 30) {
    return fail('Cluster similarity sample duration was out of bounds.');
  }
  const maximumSecondsPerSegment = readSimilarityNumber(
    value.maximumSecondsPerSegment,
    'maximumSecondsPerSegment',
  ) as number;
  if (maximumSecondsPerSegment < 1 || maximumSecondsPerSegment > 10) {
    return fail('Segment consistency sample duration was out of bounds.');
  }
  const maximumSegmentsPerCluster = value.maximumSegmentsPerCluster as number;
  if (maximumSegmentsPerCluster < 2 || maximumSegmentsPerCluster > 12) {
    return fail('Segment consistency sample count was out of bounds.');
  }
  return {
    supportedSimilarities,
    matches,
    segmentConsistency,
    segmentAnchorMatches,
    embeddingDimension: value.embeddingDimension as number,
    maximumSecondsPerCluster,
    maximumSegmentsPerCluster,
    maximumSecondsPerSegment,
    embeddedClusterCount: value.embeddedClusterCount as number,
    skippedClusterCount: value.skippedClusterCount as number,
    embeddedSegmentCount: value.embeddedSegmentCount as number,
    skippedSegmentEmbeddingCount: value.skippedSegmentEmbeddingCount as number,
    resources: readChildResources(value.resources),
    outputBytes: value.outputBytes as number,
  };
};

const runClusterSimilarity = async (
  runtime: EngineRuntime,
  wavPath: string,
  diarizationCachePath: string,
  supportedClusters: readonly number[],
): Promise<ClusterSimilarityRun> => {
  const speaker = runtime.speakerDiarization;
  if (!speaker) throw new Error('The local speaker runtime is unavailable.');
  const result = await spawnCapture(process.execPath, [
    CLUSTER_SIMILARITY_CHILD,
    speaker.modulePath,
    wavPath,
    speaker.embeddingModelPath,
    diarizationCachePath,
    JSON.stringify({
      supportedClusters,
      maximumSecondsPerCluster: 10,
      maximumSegmentsPerCluster: 6,
      maximumSecondsPerSegment: 4,
    }),
  ], 4 * 1_024 * 1_024);
  if (result.exitCode !== 0) {
    throw new Error(
      `Cluster-similarity experiment failed${result.stderr ? `: ${result.stderr}` : '.'}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.toString('utf8')) as unknown;
  } catch {
    return fail('Cluster-similarity experiment returned invalid JSON.');
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== CHILD_PROTOCOL_VERSION ||
    parsed.outcome !== 'completed'
  ) {
    return fail('Cluster-similarity experiment returned an unsupported result.');
  }
  return parseClusterSimilarityRun({
    ...parsed,
    outputBytes: result.stdout.byteLength,
  });
};

const diarizationCacheKey = (
  wavHash: string,
  configuration: SpeakerEvaluationConfiguration,
  modelFingerprint: string,
): string => createHash('sha256')
  .update(JSON.stringify({
    wavHash,
    modelFingerprint,
    clusteringThreshold: configuration.clusteringThreshold,
    expectedSpeakerCount: configuration.expectedSpeakerCount,
    minDurationOff: configuration.minDurationOff,
    minDurationOn: configuration.minDurationOn,
  }))
  .digest('hex');

const clusterSimilarityCacheKey = (
  diarizationCachePath: string,
  supportedClusters: readonly number[],
  modelFingerprint: string,
): string => createHash('sha256')
  .update(JSON.stringify({
    diarizationCachePath,
    supportedClusters,
    modelFingerprint,
    maximumSecondsPerCluster: 10,
    maximumSegmentsPerCluster: 6,
    maximumSecondsPerSegment: 4,
    segmentConsistencyVersion: 1,
    segmentAnchorSimilarityVersion: 1,
  }))
  .digest('hex');

const recursiveSize = async (targetPath: string): Promise<number> => {
  const stats = await stat(targetPath);
  if (stats.isFile()) return stats.size;
  if (!stats.isDirectory()) return 0;
  const entries = await readdir(targetPath, { withFileTypes: true });
  let total = 0;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) continue;
    total += await recursiveSize(path.join(targetPath, entry.name));
  }
  return total;
};

const annotationTemplate = (whisper: NormalizedWhisperOutput): string =>
  `${JSON.stringify({
    schemaVersion: 1,
    durationMs: whisper.durationMs,
    speakers: ['Speaker A', 'Speaker B'],
    ranges: [],
    words: [],
    wordTimingReference: whisper.words.map((word, wordIndex) => ({
      wordIndex,
      startMs: word.startMs,
      endMs: word.endMs,
    })),
    instructions: 'Set anonymous speakers, then annotate reliable ranges and/or word indexes. The empty template is intentionally not scoreable.',
  }, null, 2)}\n`;

const transcriptionReferenceTemplate = (): string =>
  `${JSON.stringify({
    schemaVersion: 1,
    text: '',
    instructions: 'Type or paste an independently checked reference transcript. Do not copy the Whisper output: that would make word-error scoring circular. Remove instructions before using this file as transcriptReferencePath.',
  }, null, 2)}\n`;

const countAlignedWords = (
  whisper: NormalizedWhisperOutput,
  segments: readonly { speakerId: string | null; words: readonly unknown[] }[],
): { labeled: number; unclear: number } => {
  const labeledKeys = new Map<string, number>();
  const unclearKeys = new Map<string, number>();
  segments.forEach((segment) => {
    segment.words.forEach((word) => {
      const key = JSON.stringify(word);
      const target = segment.speakerId ? labeledKeys : unclearKeys;
      target.set(key, (target.get(key) ?? 0) + 1);
    });
  });
  let labeled = 0;
  let unclear = 0;
  whisper.words.forEach((word) => {
    if (!/[\p{L}\p{N}]/u.test(word.text)) return;
    const key = JSON.stringify({ startMs: word.startMs, endMs: word.endMs, text: word.text });
    const labeledRemaining = labeledKeys.get(key) ?? 0;
    const unclearRemaining = unclearKeys.get(key) ?? 0;
    if (labeledRemaining > 0) {
      labeled += 1;
      labeledKeys.set(key, labeledRemaining - 1);
    } else if (unclearRemaining > 0) {
      unclear += 1;
      unclearKeys.set(key, unclearRemaining - 1);
    } else {
      unclear += 1;
    }
  });
  return { labeled, unclear };
};

const compareWithBaseline = (
  accuracy: SpeakerAccuracyMetrics | null,
  baseline: SpeakerAccuracyMetrics | null,
): ConfigurationResult['comparison'] => {
  if (!accuracy || !baseline) return 'inconclusive';
  return compareSpeakerAccuracyMetrics(accuracy, baseline);
};

const formatPercent = (value: number | null): string =>
  value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`;

const formatMarkdownReport = (report: ExperimentReport): string => {
  const rows = report.configurations.map((result) => {
    const accuracy = result.accuracy;
    const changedClusters =
      result.recovery.mergedReliableClusterCount +
      result.recovery.recoveredFilteredClusterCount +
      result.recovery.promotedNovelClusterCount +
      result.recovery.demotedClusterCount;
    const changedWords =
      result.recovery.recoveredWordCount +
      result.recovery.remappedWordCount +
      result.recovery.promotedNovelWordCount +
      result.recovery.demotedWordCount;
    const recoveryWallTimeMs =
      result.recovery.alignmentWallTimeMs + result.recovery.similarityWallTimeMs;
    return `| ${result.configuration.name} | ${result.configuration.recoveryMode} | ${changedClusters} | ${changedWords} | ${result.rawDiarization.rawClusterCount} | ${result.alignedSpeakerCount} | ${formatPercent(accuracy?.correctWordRate ?? null)} | ${formatPercent(accuracy?.wrongWordRate ?? null)} | ${formatPercent(accuracy?.unclearWordRate ?? null)} | ${formatPercent(accuracy?.weightedWordLoss ?? null)} | ${formatPercent(accuracy?.balancedWeightedWordLoss ?? null)} | ${formatPercent(accuracy?.minimumSpeakerCorrectWordRate ?? null)} | ${result.resources.wallTimeMs.toFixed(0)} | ${recoveryWallTimeMs.toFixed(0)} | ${result.resources.realTimeFactor?.toFixed(3) ?? 'n/a'} | ${(Math.max(result.resources.peakRssBytes, result.recovery.similarityPeakRssBytes) / 1_048_576).toFixed(1)} | ${result.comparison} |`;
  });
  const consistencyRows = report.configurations.flatMap((result) => {
    if (!result.segmentConsistency) return [];
    const medians = result.segmentConsistency.flatMap((entry) =>
      entry.medianSimilarity === null ? [] : [entry.medianSimilarity]);
    const pairCount = result.segmentConsistency.reduce(
      (total, entry) => total + entry.pairCount,
      0,
    );
    return [`| ${result.configuration.name} | ${result.segmentConsistency.length} | ${pairCount} | ${medians.length > 0 ? Math.min(...medians).toFixed(3) : 'n/a'} | ${medians.filter((value) => value < SEGMENT_GUARD_MINIMUM_MEDIAN_SIMILARITY).length} |`];
  });
  const consistencySection = consistencyRows.length > 0
    ? `
## Segment consistency

| Configuration | Evaluated clusters | Segment pairs | Lowest median | Below 0.40 guard |
| --- | ---: | ---: | ---: | ---: |
${consistencyRows.join('\n')}

Only aggregate segment counts and similarity statistics are retained; voice vectors are discarded inside the isolated child process.
`
    : '';
  const churnRows = report.configurations.map((result) => {
    const churn = result.churn;
    return `| ${result.configuration.name} | ${churn.segmentCount} | ${churn.clusterSwitchCount} | ${formatPercent(churn.clusterSwitchRate)} | ${churn.activeWindowCount}/${churn.totalWindowCount} | ${churn.windowsWithTwoOrMoreClusters} | ${churn.windowsWithThreeOrMoreClusters} | ${formatPercent(churn.windowsWithThreeOrMoreClusterRate)} | ${churn.maximumDistinctClustersPerWindow} | ${churn.meanDistinctClustersPerActiveWindow?.toFixed(2) ?? 'n/a'} |`;
  });
  const churnSection = `
## Raw diarization churn

| Configuration | Raw spans | Cluster switches | Switch rate | Active 10s windows | 2+ cluster windows | 3+ cluster windows | 3+ rate | Max clusters/window | Mean clusters/active window |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${churnRows.join('\n')}

These are raw cluster diagnostics, not speaker-accuracy scores. A cluster switch is a change between consecutive diarization spans. Window counts include a cluster when its span overlaps a fixed ten-second window.
`;
  const boundaryRows = report.configurations.flatMap((result) => {
    const boundary = result.accuracy?.boundaries;
    if (!boundary) return [];
    return [`| ${result.configuration.name} | ${boundary.matchingToleranceMs} | ${boundary.referenceCount} | ${boundary.systemCount} | ${boundary.matchedCount} | ${boundary.missedCount} | ${boundary.extraCount} | ${formatPercent(boundary.recall)} | ${formatPercent(boundary.precision)} | ${formatPercent(boundary.f1)} | ${boundary.meanAbsoluteErrorMs === null ? 'n/a' : boundary.meanAbsoluteErrorMs.toFixed(0)} |`];
  });
  const boundarySection = boundaryRows.length > 0
    ? `
## Speaker-change boundaries

| Configuration | Tolerance ms | Reference | System | Matched | Missed | Extra | Recall | Precision | F1 | Matched MAE ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${boundaryRows.join('\n')}

A match must be within the fixed tolerance. Error statistics describe only those matched boundaries; distant changes are counted as missed or extra.
`
    : '';
  const transcription = report.transcriptionAccuracy;
  const transcriptionSection = transcription
    ? `
## Transcription reference

| Reference words | Whisper words | Correct words | Substitutions | Deletions | Insertions | Word error rate | Word accuracy |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ${transcription.referenceWordCount} | ${transcription.hypothesisWordCount} | ${transcription.correctWordCount} | ${transcription.substitutionCount} | ${transcription.deletionCount} | ${transcription.insertionCount} | ${formatPercent(transcription.wordErrorRate)} | ${formatPercent(transcription.wordAccuracyRate)} |

The local reference and Whisper text are not included in this report.
`
    : '';
  return `# Speaker accuracy experiment: ${report.experiment}

Generated locally at ${report.generatedAt}. This report contains aggregate metrics only; it does not include transcript text or audio.

## Evidence boundary

- Input: ${report.inputs.mediaKind}; duration ${(report.inputs.durationMs / 1_000).toFixed(2)} seconds.
- Reused normalized WAV: ${report.inputs.normalizedWavReused ? 'yes' : 'no'}.
- Reused Whisper full JSON: ${report.inputs.whisperJsonReused ? 'yes' : 'no'}.
- Anonymous ground truth available: ${report.inputs.annotationAvailable ? 'yes' : 'no'}.
- Local transcription reference available: ${report.inputs.transcriptReferenceAvailable ? 'yes' : 'no'}.
- Word-timed diarization error is the documented local equivalent of DER: wrong-speaker duration plus Unclear duration, divided by annotated word duration. It does not score overlapping reference speech.
- Weighted loss counts a wrong speaker twice and Unclear once.

## Results

| Configuration | Recovery | Changed clusters | Changed words | Raw clusters | Supported labels | Correct words | Wrong words | Unclear words | Weighted loss | Balanced loss | Weakest speaker correct | Diarization ms | Recovery ms | RTF | Peak MiB | Comparison |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${rows.join('\n')}
${churnSection}
${transcriptionSection}
${boundarySection}
${consistencySection}

## Resource and artifact guardrails

- Speaker models and current-host runtime: ${(report.runtime.totalSpeakerArtifactBytes / 1_048_576).toFixed(1)} MiB.
- Artifact change between configurations: ${report.runtime.perConfigurationArtifactDeltaBytes} bytes.
- Native speaker runtime uses ${report.configurations[0]?.resources.threadSetting ?? 2} CPU threads.
- Alignment and recovery are measured separately in the recovery diagnostics; those fields contain aggregate counts only.

## Conclusion

- Measurable wins in this run: ${report.conclusion.wins.join(', ') || 'none'}.
- Regressions in this run: ${report.conclusion.regressions.join(', ') || 'none'}.
- Ties within the 1 percentage-point weighted-loss threshold: ${report.conclusion.ties.join(', ') || 'none'}.
- Inconclusive: ${report.conclusion.inconclusive.join(', ') || 'none'}.
- Production recommendation: ${report.conclusion.productionRecommendation}
`;
};

const selectConfiguration = (
  configurations: readonly SpeakerEvaluationConfiguration[],
  selectedName: string | null,
): SpeakerEvaluationConfiguration[] => {
  if (!selectedName) return [...configurations];
  const selected = configurations.find((entry) => entry.name === selectedName);
  if (!selected) throw new Error(`Unknown configuration: ${selectedName}`);
  return [selected];
};

const readCliArguments = (args: readonly string[]): {
  configPath: string;
  configurationName: string | null;
} => {
  let configPath: string | null = null;
  let configurationName: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--config') {
      configPath = args[++index] ?? null;
    } else if (argument === '--configuration') {
      configurationName = args[++index] ?? null;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!configPath) {
    throw new Error('Usage: node scripts/run-speaker-accuracy.cjs --config <local-config.json> [--configuration <name>]');
  }
  return { configPath: path.resolve(configPath), configurationName };
};

export const runSpeakerEvaluationCli = async (args: readonly string[]): Promise<void> => {
  const repositoryRoot = path.resolve(__dirname, '..', '..', '..');
  const { configPath, configurationName } = readCliArguments(args);
  const input = parseEvaluationInput(
    JSON.parse(await readFile(configPath, 'utf8')) as unknown,
    configPath,
    repositoryRoot,
  );
  const runtimeStatus = await resolveEngineRuntime({
    appPath: repositoryRoot,
    isPackaged: false,
  });
  if (!runtimeStatus.ready) {
    throw new Error('The checked-out local transcription and speaker runtime is unavailable.');
  }
  const runtime = runtimeStatus.runtime;
  const speakerRuntime = runtime.speakerDiarization;
  if (!speakerRuntime) {
    throw new Error('The checked-out local speaker runtime is unavailable.');
  }
  await mkdir(input.outputDirectory, { recursive: true, mode: 0o700 });
  const cacheDirectory = path.join(
    repositoryRoot,
    '.sotto-speaker-eval',
    'cache',
    input.name,
  );
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });

  let normalizationWallTimeMs = 0;
  let normalizedWavReused = true;
  let wavPath: string;
  if (input.normalizedWavPath) {
    wavPath = input.normalizedWavPath;
    await stat(wavPath);
  } else {
    const sourcePath = input.mediaPath as string;
    const sourceHash = await hashFile(sourcePath);
    wavPath = path.join(cacheDirectory, `${sourceHash}.normalized.wav`);
    try {
      await stat(wavPath);
    } catch {
      normalizedWavReused = false;
      const started = process.hrtime.bigint();
      await normalizeMediaToWav({
        ffmpegPath: runtime.ffmpegPath,
        inputPath: sourcePath,
        outputPath: wavPath,
        durationSeconds: null,
      });
      normalizationWallTimeMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    }
  }

  const wavHash = await hashFile(wavPath);
  let whisperJsonReused = true;
  let whisperWallTimeMs = 0;
  let whisperJsonPath: string;
  if (input.whisperJsonPath) {
    whisperJsonPath = input.whisperJsonPath;
  } else {
    const modelStats = await stat(runtime.modelPath);
    const cacheKey = createHash('sha256')
      .update(`${wavHash}:${modelStats.size}:${modelStats.mtimeMs}`)
      .digest('hex');
    const outputPrefix = path.join(cacheDirectory, `${cacheKey}.whisper`);
    whisperJsonPath = `${outputPrefix}.json`;
    try {
      await stat(whisperJsonPath);
    } catch {
      whisperJsonReused = false;
      whisperWallTimeMs = await runWhisper(runtime, wavPath, outputPrefix);
    }
  }
  const whisper = parseWhisperOutputJson(await readFile(whisperJsonPath, 'utf8'));
  const transcriptionReference = input.transcriptReferencePath
    ? parseTranscriptionReference(
      JSON.parse(await readFile(input.transcriptReferencePath, 'utf8')) as unknown,
    )
    : null;
  if (!transcriptionReference) {
    await writeFile(
      path.join(input.outputDirectory, 'transcript-reference-template.json'),
      transcriptionReferenceTemplate(),
      { encoding: 'utf8', mode: 0o600 },
    );
  }
  const transcriptionAccuracy = transcriptionReference
    ? scoreTranscriptionAccuracy(whisper, transcriptionReference)
    : null;
  let annotation: unknown = null;
  if (input.annotationPath) {
    annotation = JSON.parse(await readFile(input.annotationPath, 'utf8')) as unknown;
    parseSpeakerAnnotation(annotation, whisper.words.length);
  } else {
    await writeFile(
      path.join(input.outputDirectory, 'annotation-template.json'),
      annotationTemplate(whisper),
      { encoding: 'utf8', mode: 0o600 },
    );
  }
  const knownSpeakerCount = annotation
    ? parseSpeakerAnnotation(annotation, whisper.words.length).speakers.length
    : null;
  const configurations = selectConfiguration(
    input.configurations ?? buildFirstPackConfigurations(knownSpeakerCount),
    configurationName,
  );
  const durationMs = annotation
    ? parseSpeakerAnnotation(annotation, whisper.words.length).durationMs
    : whisper.durationMs;
  const configurationResults: ConfigurationResult[] = [];
  const segmentationStats = await stat(speakerRuntime.segmentationModelPath);
  const embeddingStats = await stat(speakerRuntime.embeddingModelPath);
  const moduleStats = await stat(speakerRuntime.modulePath);
  const diarizationModelFingerprint = [
    segmentationStats.size,
    segmentationStats.mtimeMs,
    embeddingStats.size,
    embeddingStats.mtimeMs,
    moduleStats.size,
    moduleStats.mtimeMs,
  ].join(':');
  const diarizationCacheDirectory = path.join(cacheDirectory, 'diarization');
  await mkdir(diarizationCacheDirectory, { recursive: true, mode: 0o700 });
  for (const configuration of configurations) {
    process.stdout.write(`[speaker-eval] ${configuration.name}\n`);
    const cachePath = path.join(
      diarizationCacheDirectory,
      `${diarizationCacheKey(
        wavHash,
        configuration,
        diarizationModelFingerprint,
      )}.json`,
    );
    let run: DiarizationRun;
    let diarizationCacheReused = true;
    try {
      run = parseCachedDiarization(
        JSON.parse(await readFile(cachePath, 'utf8')) as unknown,
      );
    } catch {
      diarizationCacheReused = false;
      run = await runDiarization(runtime, wavPath, configuration);
      await writeFile(cachePath, `${JSON.stringify(run)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }
    const shifted = shiftDiarizationSegments(
      run.segments,
      configuration.diarizationShiftMs,
    );
    const rawSummary = summarizeRawDiarization(run.segments, whisper.words);
    const shiftedSummary = summarizeRawDiarization(shifted, whisper.words);
    let alignmentInput = shifted;
    let embeddingRecovery: SpeakerRecoveryDiagnostics | null = null;
    let clusterSimilarity: ClusterSimilarityRun | null = null;
    let canonicalReliableClusters: number[] = [];
    let similarityCacheReused: boolean | null = null;
    let similarityWallTimeMs = 0;
    let similarityCpuTimeMs = 0;
    let similarityPeakRssBytes = 0;
    if (isClusterSimilarityRecoveryMode(configuration.recoveryMode)) {
      const supportedClusters = shiftedSummary.clusters
        .filter((cluster) => cluster.supported)
        .map((cluster) => cluster.cluster)
        .sort((left, right) => left - right);
      const similarityPath = path.join(
        diarizationCacheDirectory,
        `${clusterSimilarityCacheKey(
          cachePath,
          supportedClusters,
          diarizationModelFingerprint,
        )}.cluster-similarity.json`,
      );
      let similarity: ClusterSimilarityRun;
      similarityCacheReused = true;
      try {
        similarity = parseClusterSimilarityRun(
          JSON.parse(await readFile(similarityPath, 'utf8')) as unknown,
        );
      } catch {
        similarityCacheReused = false;
        similarity = await runClusterSimilarity(
          runtime,
          wavPath,
          cachePath,
          supportedClusters,
        );
        await writeFile(similarityPath, `${JSON.stringify(similarity)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
      }
      similarityWallTimeMs = similarity.resources.wallTimeMs;
      similarityCpuTimeMs =
        similarity.resources.userCpuMs + similarity.resources.systemCpuMs;
      similarityPeakRssBytes = similarity.resources.peakRssBytes;
      clusterSimilarity = similarity;
      const consolidationMode = isEmbeddingConsolidationRecoveryMode(
        configuration.recoveryMode,
      )
        ? configuration.recoveryMode
        : 'embedding-consolidation-exploratory';
      const consolidated = applyExperimentEmbeddingConsolidation(
        shifted,
        shiftedSummary,
        similarity,
        consolidationMode,
        configuration.recoveryMode === 'novel-speaker-balanced-segment-guard' ||
          isSegmentAnchorReassignmentRecoveryMode(configuration.recoveryMode)
          ? {
            minimumInternalMedianSimilarity:
              SEGMENT_GUARD_MINIMUM_MEDIAN_SIMILARITY,
          }
          : {},
      );
      alignmentInput = consolidated.segments;
      canonicalReliableClusters = consolidated.canonicalReliableClusters;
      embeddingRecovery = {
        ...consolidated.diagnostics,
        mode: configuration.recoveryMode,
      };
      if (isSegmentAnchorReassignmentRecoveryMode(configuration.recoveryMode)) {
        const reassigned = applyExperimentSegmentAnchorReassignment(
          alignmentInput,
          shiftedSummary,
          similarity,
          consolidated.clusterMapping,
          configuration.segmentAnchorOptions,
        );
        alignmentInput = reassigned.segments;
        embeddingRecovery = {
          ...embeddingRecovery,
          remappedSegmentCount:
            embeddingRecovery.remappedSegmentCount + reassigned.reassignedSegmentCount,
          remappedDurationMs:
            embeddingRecovery.remappedDurationMs + reassigned.reassignedDurationMs,
          demotedClusterCount:
            embeddingRecovery.demotedClusterCount +
            (reassigned.demotedSegmentCount > 0 ? 1 : 0),
        };
      }
    }
    let nextSpeakerId = 0;
    const alignmentStarted = process.hrtime.bigint();
    const aligned = alignTranscriptSpeakers(
      whisper.segments,
      whisper.words,
      alignmentInput,
      () => `experiment-speaker-${String(nextSpeakerId++).padStart(2, '0')}`,
    );
    const recovered = isNovelSpeakerRecoveryMode(configuration.recoveryMode)
      ? applyExperimentNovelSpeakerPreservation(
          whisper,
          alignmentInput,
          aligned.segments,
          shiftedSummary,
          clusterSimilarity as ClusterSimilarityRun,
          canonicalReliableClusters,
          embeddingRecovery as SpeakerRecoveryDiagnostics,
          configuration.recoveryMode,
        )
      : embeddingRecovery
        ? { segments: aligned.segments, diagnostics: embeddingRecovery }
        : applyExperimentFilteredFragmentRecovery(
          whisper,
          shifted,
          aligned.segments,
          configuration.recoveryMode,
        );
    const alignmentWallTimeMs =
      Number(process.hrtime.bigint() - alignmentStarted) / 1_000_000;
    const counts = countAlignedWords(whisper, recovered.segments);
    const cpuTimeMs = run.resources.userCpuMs + run.resources.systemCpuMs;
    configurationResults.push({
      configuration,
      rawDiarization: rawSummary,
      churn: summarizeDiarizationChurn(run.segments, durationMs),
      shiftedAlignmentInput: summarizeRawDiarization(alignmentInput, whisper.words),
      alignedSpeakerCount: new Set(
        recovered.segments.flatMap((segment) =>
          segment.speakerId ? [segment.speakerId] : []),
      ).size,
      labeledWordCount: counts.labeled,
      unclearWordCount: counts.unclear,
      segmentConsistency: clusterSimilarity?.segmentConsistency ?? null,
      recovery: {
        ...recovered.diagnostics,
        alignmentWallTimeMs,
        similarityCacheReused,
        similarityWallTimeMs,
        similarityCpuTimeMs,
        similarityPeakRssBytes,
      },
      resources: {
        ...run.resources,
        cpuTimeMs,
        observedCpuPercent: run.resources.wallTimeMs > 0
          ? (cpuTimeMs / run.resources.wallTimeMs) * 100
          : 0,
        realTimeFactor: durationMs > 0 ? run.resources.wallTimeMs / durationMs : null,
        rawOutputBytes: run.outputBytes,
        diarizationCacheReused,
      },
      accuracy: annotation
        ? scoreSpeakerAccuracy(whisper, recovered.segments, annotation)
        : null,
      comparison: configuration.name === 'baseline-production'
        ? 'baseline'
        : 'inconclusive',
    });
  }
  const baseline = configurationResults.find(
    (entry) => entry.configuration.name === 'baseline-production',
  )?.accuracy ?? null;
  configurationResults.forEach((entry) => {
    if (entry.comparison !== 'baseline') {
      entry.comparison = compareWithBaseline(entry.accuracy, baseline);
    }
  });
  const speakerRuntimeRoot = path.dirname(path.dirname(speakerRuntime.modulePath));
  const segmentationModelBytes = segmentationStats.size;
  const embeddingModelBytes = embeddingStats.size;
  const speakerRuntimeBytes = await recursiveSize(speakerRuntimeRoot);
  const report: ExperimentReport = {
    schemaVersion: 1,
    experiment: input.name,
    generatedAt: new Date().toISOString(),
    privacy: 'Local-only aggregate metrics; no transcript text or audio included.',
    inputs: {
      mediaKind: input.mediaPath ? 'local-media' : 'normalized-wav',
      normalizedWavReused,
      whisperJsonReused,
      annotationAvailable: annotation !== null,
      transcriptReferenceAvailable: transcriptionReference !== null,
      durationMs,
    },
    runtime: {
      engine: 'sherpa-onnx pyannote-segmentation-3.0 plus 3D-Speaker ERes2Net',
      segmentationModelBytes,
      embeddingModelBytes,
      speakerRuntimeBytes,
      totalSpeakerArtifactBytes:
        segmentationModelBytes + embeddingModelBytes + speakerRuntimeBytes,
      perConfigurationArtifactDeltaBytes: 0,
    },
    preprocessing: { normalizationWallTimeMs, whisperWallTimeMs },
    transcriptionAccuracy,
    configurations: configurationResults,
    conclusion: {
      wins: configurationResults
        .filter((entry) => entry.comparison === 'win')
        .map((entry) => entry.configuration.name),
      regressions: configurationResults
        .filter((entry) => entry.comparison === 'regression')
        .map((entry) => entry.configuration.name),
      ties: configurationResults
        .filter((entry) => entry.comparison === 'tie')
        .map((entry) => entry.configuration.name),
      inconclusive: configurationResults
        .filter((entry) => entry.comparison === 'inconclusive')
        .map((entry) => entry.configuration.name),
      productionRecommendation:
        'Leave production unchanged. A configuration requires repeated multi-speaker ground-truth wins within CPU, memory, and wall-time guardrails before promotion.',
    },
  };
  await writeFile(
    path.join(input.outputDirectory, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  await writeFile(
    path.join(input.outputDirectory, 'report.md'),
    formatMarkdownReport(report),
    { encoding: 'utf8', mode: 0o600 },
  );
  process.stdout.write(`[speaker-eval] report: ${path.join(input.outputDirectory, 'report.md')}\n`);
};
