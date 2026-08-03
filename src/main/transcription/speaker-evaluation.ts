import type { TranscriptSegment } from './transcript-types';
import type { SpeakerDiarizationSegment } from './speaker-diarization';
import type {
  NormalizedWhisperOutput,
  WhisperWord,
} from './whisper-output';

export const SPEAKER_EVALUATION_SCHEMA_VERSION = 1;
export const SPEAKER_EVALUATION_BASELINE = {
  clusteringThreshold: 0.75,
  diarizationShiftMs: 0,
  expectedSpeakerCount: null,
  recoveryMode: 'production',
  minDurationOff: 0.5,
  minDurationOn: 0.2,
} as const;

const MAX_ANNOTATION_SPEAKERS = 12;
const MAX_ANNOTATION_LABEL_CHARACTERS = 64;
const MIN_CLUSTERING_THRESHOLD = 0.5;
const MAX_CLUSTERING_THRESHOLD = 1;
const MAX_DURATION_SETTING_SECONDS = 5;
const MAX_DIARIZATION_SHIFT_MS = 2_000;
const MAX_RELIABLE_AUTOMATIC_SPEAKERS = 12;
const MIN_RELIABLE_CLUSTER_SUPPORT_MS = 200;
const MAX_RELIABLE_CLUSTER_SUPPORT_MS = 5_000;
const RELIABLE_CLUSTER_SUPPORT_RATIO = 0.0025;

export type SpeakerEvaluationRecoveryMode =
  | 'production'
  | 'filtered-bridge-one-word'
  | 'filtered-bridge-two-words'
  | 'filtered-bridge-three-words'
  | 'embedding-consolidation-strict'
  | 'embedding-consolidation-balanced'
  | 'embedding-consolidation-exploratory'
  | 'novel-speaker-strict'
  | 'novel-speaker-balanced'
  | 'novel-speaker-balanced-segment-guard'
  | 'novel-speaker-balanced-segment-reassignment'
  | 'novel-speaker-exploratory';

type FilteredBridgeRecoveryMode = Extract<
  SpeakerEvaluationRecoveryMode,
  `filtered-bridge-${string}`
>;

export type EmbeddingConsolidationRecoveryMode = Extract<
  SpeakerEvaluationRecoveryMode,
  `embedding-consolidation-${string}`
>;

export type NovelSpeakerRecoveryMode = Extract<
  SpeakerEvaluationRecoveryMode,
  `novel-speaker-${string}`
>;

export type ClusterSimilarityRecoveryMode =
  | EmbeddingConsolidationRecoveryMode
  | NovelSpeakerRecoveryMode;

const SPEAKER_EVALUATION_RECOVERY_MODES = new Set<SpeakerEvaluationRecoveryMode>([
  'production',
  'filtered-bridge-one-word',
  'filtered-bridge-two-words',
  'filtered-bridge-three-words',
  'embedding-consolidation-strict',
  'embedding-consolidation-balanced',
  'embedding-consolidation-exploratory',
  'novel-speaker-strict',
  'novel-speaker-balanced',
  'novel-speaker-balanced-segment-guard',
  'novel-speaker-balanced-segment-reassignment',
  'novel-speaker-exploratory',
]);

export interface SpeakerEvaluationConfiguration {
  name: string;
  clusteringThreshold: number;
  diarizationShiftMs: number;
  expectedSpeakerCount: number | null;
  recoveryMode: SpeakerEvaluationRecoveryMode;
  minDurationOn: number;
  minDurationOff: number;
  segmentAnchorOptions: SegmentAnchorReassignmentOptions;
}

export interface SpeakerRecoveryDiagnostics {
  mode: SpeakerEvaluationRecoveryMode;
  eligibleRunCount: number;
  recoveredRunCount: number;
  recoveredSegmentCount: number;
  recoveredWordCount: number;
  rejectedByBoundsCount: number;
  rejectedByNeighborCount: number;
  rejectedBySourceBoundaryCount: number;
  mergedReliableClusterCount: number;
  recoveredFilteredClusterCount: number;
  remappedSegmentCount: number;
  remappedDurationMs: number;
  remappedWordCount: number;
  promotedNovelClusterCount: number;
  promotedNovelWordCount: number;
  demotedClusterCount: number;
  demotedWordCount: number;
  finalAllowedClusterCount: number;
  segmentGuardEvaluatedClusterCount: number;
  segmentGuardInconsistentClusterCount: number;
  segmentGuardRejectedReliableMergeCount: number;
  segmentGuardRejectedFilteredMatchCount: number;
}

export interface SpeakerRecoveryResult {
  segments: TranscriptSegment[];
  diagnostics: SpeakerRecoveryDiagnostics;
}

export interface SpeakerClusterSimilarityMatch {
  cluster: number;
  sampleDurationMs: number;
  ready: boolean;
  nearestSupportedCluster: number | null;
  similarity: number | null;
  secondSimilarity: number | null;
  margin: number | null;
}

export interface SupportedClusterSimilarity {
  leftCluster: number;
  rightCluster: number;
  similarity: number;
}

export interface SupportedClusterSegmentConsistency {
  cluster: number;
  totalSegmentCount: number;
  selectedSegmentCount: number;
  readySegmentCount: number;
  skippedSegmentCount: number;
  pairCount: number;
  minimumSimilarity: number | null;
  medianSimilarity: number | null;
  maximumSimilarity: number | null;
}

/**
 * A sampled raw segment compared with aggregate embeddings from the other
 * reliable clusters. This intentionally contains no voice vector or text.
 */
export interface SupportedClusterSegmentAnchorMatch {
  cluster: number;
  startMs: number;
  endMs: number;
  sampleDurationMs: number;
  ready: boolean;
  nearestOtherSupportedCluster: number | null;
  similarity: number | null;
  secondSimilarity: number | null;
  margin: number | null;
}

export interface SpeakerClusterSimilarityAnalysis {
  supportedSimilarities: SupportedClusterSimilarity[];
  matches: SpeakerClusterSimilarityMatch[];
  segmentConsistency?: SupportedClusterSegmentConsistency[];
  segmentAnchorMatches?: SupportedClusterSegmentAnchorMatch[];
}

export interface SpeakerAnnotationRange {
  startMs: number;
  endMs: number;
  speaker: string;
}

export interface SpeakerAnnotationWord {
  wordIndex: number;
  speaker: string;
}

export interface SpeakerAnnotation {
  schemaVersion: 1;
  durationMs: number;
  speakers: string[];
  ranges: SpeakerAnnotationRange[];
  words: SpeakerAnnotationWord[];
}

export interface RawClusterSupport {
  cluster: number;
  segmentCount: number;
  segmentDurationMs: number;
  wordCount: number;
  wordSupportMs: number;
  supported: boolean;
}

export interface RawDiarizationSummary {
  rawClusterCount: number;
  rawSegmentCount: number;
  supportedClusterCount: number;
  minimumReliableSupportMs: number;
  clusters: RawClusterSupport[];
}

export interface BoundaryMetrics {
  matchingToleranceMs: number;
  referenceCount: number;
  systemCount: number;
  matchedCount: number;
  missedCount: number;
  extraCount: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  meanAbsoluteErrorMs: number | null;
  medianAbsoluteErrorMs: number | null;
  maximumAbsoluteErrorMs: number | null;
}

const BOUNDARY_MATCH_TOLERANCE_MS = 1_000;

export interface SpeakerReferenceMetrics {
  speaker: string;
  annotatedWordCount: number;
  annotatedDurationMs: number;
  correctWordCount: number;
  correctDurationMs: number;
  wrongWordCount: number;
  wrongDurationMs: number;
  unclearWordCount: number;
  unclearDurationMs: number;
  correctWordRate: number | null;
  correctDurationRate: number | null;
  wrongWordRate: number | null;
  wrongDurationRate: number | null;
  unclearWordRate: number | null;
  unclearDurationRate: number | null;
  weightedWordLoss: number | null;
  weightedDurationLoss: number | null;
}

export interface SpeakerAccuracyMetrics {
  annotatedWordCount: number;
  annotatedDurationMs: number;
  correctWordCount: number;
  correctDurationMs: number;
  wrongWordCount: number;
  wrongDurationMs: number;
  unclearWordCount: number;
  unclearDurationMs: number;
  correctWordRate: number | null;
  correctDurationRate: number | null;
  wrongWordRate: number | null;
  wrongDurationRate: number | null;
  unclearWordRate: number | null;
  unclearDurationRate: number | null;
  labelWordCoverage: number | null;
  labelDurationCoverage: number | null;
  weightedWordLoss: number | null;
  weightedDurationLoss: number | null;
  balancedWeightedWordLoss: number | null;
  balancedWeightedDurationLoss: number | null;
  macroCorrectWordRate: number | null;
  macroCorrectDurationRate: number | null;
  minimumSpeakerCorrectWordRate: number | null;
  minimumSpeakerCorrectDurationRate: number | null;
  wordTimedDiarizationErrorRate: number | null;
  referenceSpeakerCount: number;
  systemSpeakerCount: number;
  signedSpeakerCountError: number;
  absoluteSpeakerCountError: number;
  fragmentationCount: number;
  mergingCount: number;
  speakerMapping: Record<string, string | null>;
  perSpeaker: SpeakerReferenceMetrics[];
  boundaries: BoundaryMetrics;
}

export type SpeakerAccuracyComparison =
  | 'win'
  | 'regression'
  | 'tie'
  | 'inconclusive';

type ComparableSpeakerAccuracy = Pick<
  SpeakerAccuracyMetrics,
  | 'weightedWordLoss'
  | 'weightedDurationLoss'
  | 'balancedWeightedWordLoss'
  | 'balancedWeightedDurationLoss'
>;

interface WordAssignment {
  index: number;
  referenceSpeaker: string;
  systemSpeaker: string | null;
  durationMs: number;
  startMs: number;
  endMs: number;
}

interface ClusterChoice {
  cluster: number | null;
  directSupportMs: number;
  competingSupportMs: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const fail = (message: string): never => {
  throw new TypeError(message);
};

const readFiniteNumber = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail(`${field} must be a finite number.`);
  }
  return value;
};

const readSafeInteger = (
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number => {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    return fail(`${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value as number;
};

const readSpeakerLabel = (value: unknown, field: string): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ANNOTATION_LABEL_CHARACTERS ||
    value.trim() !== value ||
    value.includes('\0')
  ) {
    return fail(`${field} must be a short, non-empty anonymous label.`);
  }
  return value;
};

const isLexicalWord = (word: WhisperWord): boolean =>
  /[\p{L}\p{N}]/u.test(word.text);

const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? numerator / denominator : null;

const average = (values: readonly (number | null)[]): number | null => {
  const available = values.filter((value): value is number => value !== null);
  return available.length > 0
    ? available.reduce((total, value) => total + value, 0) / available.length
    : null;
};

const minimum = (values: readonly (number | null)[]): number | null => {
  const available = values.filter((value): value is number => value !== null);
  return available.length > 0 ? Math.min(...available) : null;
};

/**
 * Requires a candidate to improve both population-weighted and equal-speaker
 * loss. Opposing changes are a tradeoff, not a win: this prevents dominant
 * speech from hiding errors on short interjections while still honoring the
 * recording-wide cost of wrong labels.
 */
export const compareSpeakerAccuracyMetrics = (
  current: ComparableSpeakerAccuracy,
  baseline: ComparableSpeakerAccuracy,
): SpeakerAccuracyComparison => {
  const currentGlobal = current.weightedDurationLoss ?? current.weightedWordLoss;
  const baselineGlobal = baseline.weightedDurationLoss ?? baseline.weightedWordLoss;
  const currentBalanced =
    current.balancedWeightedDurationLoss ?? current.balancedWeightedWordLoss;
  const baselineBalanced =
    baseline.balancedWeightedDurationLoss ?? baseline.balancedWeightedWordLoss;
  if (
    currentGlobal === null ||
    baselineGlobal === null ||
    currentBalanced === null ||
    baselineBalanced === null
  ) {
    return 'inconclusive';
  }
  const meaningfulChange = 0.01;
  const globalChange = currentGlobal - baselineGlobal;
  const balancedChange = currentBalanced - baselineBalanced;
  if (
    globalChange <= -meaningfulChange &&
    balancedChange <= 0 ||
    balancedChange <= -meaningfulChange &&
    globalChange <= 0
  ) {
    return 'win';
  }
  if (
    globalChange >= meaningfulChange &&
    balancedChange >= 0 ||
    balancedChange >= meaningfulChange &&
    globalChange >= 0
  ) {
    return 'regression';
  }
  if (
    Math.abs(globalChange) < meaningfulChange &&
    Math.abs(balancedChange) < meaningfulChange
  ) {
    return 'tie';
  }
  return 'inconclusive';
};

const overlapMs = (
  startMs: number,
  endMs: number,
  span: SpeakerDiarizationSegment,
): number => Math.max(0, Math.min(endMs, span.endMs) - Math.max(startMs, span.startMs));

const chooseRawCluster = (
  word: WhisperWord,
  diarization: readonly SpeakerDiarizationSegment[],
): ClusterChoice => {
  const scores = new Map<number, number>();
  if (word.startMs === word.endMs) {
    for (const span of diarization) {
      if (span.startMs <= word.startMs && word.startMs <= span.endMs) {
        scores.set(span.cluster, (scores.get(span.cluster) ?? 0) + 1);
      }
    }
  } else {
    for (const span of diarization) {
      const supportMs = overlapMs(word.startMs, word.endMs, span);
      if (supportMs > 0) {
        scores.set(span.cluster, (scores.get(span.cluster) ?? 0) + supportMs);
      }
    }
  }

  const ranked = [...scores.entries()].sort(
    (left, right) => right[1] - left[1] || left[0] - right[0],
  );
  const strongest = ranked[0];
  if (!strongest) {
    return { cluster: null, directSupportMs: 0, competingSupportMs: 0 };
  }
  const competing = ranked[1];
  if (
    competing &&
    (strongest[1] - competing[1] < 100 || strongest[1] / competing[1] < 1.5)
  ) {
    return {
      cluster: null,
      directSupportMs: strongest[1],
      competingSupportMs: competing[1],
    };
  }
  return {
    cluster: strongest[0],
    directSupportMs: strongest[1],
    competingSupportMs: competing?.[1] ?? 0,
  };
};

export const validateSpeakerEvaluationConfiguration = (
  value: unknown,
): SpeakerEvaluationConfiguration => {
  if (!isRecord(value)) return fail('Evaluation configuration must be an object.');
  const name = value.name;
  if (
    typeof name !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(name)
  ) {
    return fail('Configuration name must be a safe, short identifier.');
  }
  const clusteringThreshold = readFiniteNumber(
    value.clusteringThreshold,
    'clusteringThreshold',
  );
  if (
    clusteringThreshold < MIN_CLUSTERING_THRESHOLD ||
    clusteringThreshold > MAX_CLUSTERING_THRESHOLD
  ) {
    return fail('clusteringThreshold must be from 0.5 to 1.');
  }
  const diarizationShiftMs = readSafeInteger(
    value.diarizationShiftMs,
    'diarizationShiftMs',
    -MAX_DIARIZATION_SHIFT_MS,
    MAX_DIARIZATION_SHIFT_MS,
  );
  const minDurationOn = readFiniteNumber(value.minDurationOn, 'minDurationOn');
  const minDurationOff = readFiniteNumber(value.minDurationOff, 'minDurationOff');
  if (
    minDurationOn < 0 ||
    minDurationOn > MAX_DURATION_SETTING_SECONDS ||
    minDurationOff < 0 ||
    minDurationOff > MAX_DURATION_SETTING_SECONDS
  ) {
    return fail('Minimum duration settings must be from 0 to 5 seconds.');
  }
  const expectedSpeakerCount = value.expectedSpeakerCount;
  if (
    expectedSpeakerCount !== null &&
    (!Number.isSafeInteger(expectedSpeakerCount) ||
      (expectedSpeakerCount as number) < 1 ||
      (expectedSpeakerCount as number) > MAX_ANNOTATION_SPEAKERS)
  ) {
    return fail('expectedSpeakerCount must be null or an integer from 1 to 12.');
  }
  const recoveryMode = value.recoveryMode ?? 'production';
  if (
    typeof recoveryMode !== 'string' ||
    !SPEAKER_EVALUATION_RECOVERY_MODES.has(
      recoveryMode as SpeakerEvaluationRecoveryMode,
    )
  ) {
    return fail(
      'recoveryMode must be production or a supported local recovery experiment.',
    );
  }
  const segmentAnchorValue = value.segmentAnchorOptions;
  if (segmentAnchorValue !== undefined && !isRecord(segmentAnchorValue)) {
    return fail('segmentAnchorOptions must be an object when present.');
  }
  const segmentAnchorOptions: SegmentAnchorReassignmentOptions = {
    minimumInternalMedianSimilarity: readFiniteNumber(
      segmentAnchorValue?.minimumInternalMedianSimilarity ??
        DEFAULT_SEGMENT_ANCHOR_REASSIGNMENT_OPTIONS.minimumInternalMedianSimilarity,
      'segmentAnchorOptions.minimumInternalMedianSimilarity',
    ),
    minimumSimilarity: readFiniteNumber(
      segmentAnchorValue?.minimumSimilarity ??
        DEFAULT_SEGMENT_ANCHOR_REASSIGNMENT_OPTIONS.minimumSimilarity,
      'segmentAnchorOptions.minimumSimilarity',
    ),
    minimumMargin: readFiniteNumber(
      segmentAnchorValue?.minimumMargin ??
        DEFAULT_SEGMENT_ANCHOR_REASSIGNMENT_OPTIONS.minimumMargin,
      'segmentAnchorOptions.minimumMargin',
    ),
    minimumSampleDurationMs: readSafeInteger(
      segmentAnchorValue?.minimumSampleDurationMs ??
        DEFAULT_SEGMENT_ANCHOR_REASSIGNMENT_OPTIONS.minimumSampleDurationMs,
      'segmentAnchorOptions.minimumSampleDurationMs',
      1,
      10_000,
    ),
    maximumFlaggedSupportShare: readFiniteNumber(
      segmentAnchorValue?.maximumFlaggedSupportShare ??
        DEFAULT_SEGMENT_ANCHOR_REASSIGNMENT_OPTIONS.maximumFlaggedSupportShare,
      'segmentAnchorOptions.maximumFlaggedSupportShare',
    ),
  };
  if (
    segmentAnchorOptions.minimumInternalMedianSimilarity < -1 ||
    segmentAnchorOptions.minimumInternalMedianSimilarity > 1 ||
    segmentAnchorOptions.minimumSimilarity < -1 ||
    segmentAnchorOptions.minimumSimilarity > 1 ||
    segmentAnchorOptions.minimumMargin < 0 ||
    segmentAnchorOptions.minimumMargin > 2 ||
    segmentAnchorOptions.maximumFlaggedSupportShare <= 0 ||
    segmentAnchorOptions.maximumFlaggedSupportShare > 1
  ) {
    return fail('segmentAnchorOptions were out of bounds.');
  }
  return {
    name,
    clusteringThreshold,
    diarizationShiftMs,
    expectedSpeakerCount: expectedSpeakerCount as number | null,
    recoveryMode: recoveryMode as SpeakerEvaluationRecoveryMode,
    minDurationOn,
    minDurationOff,
    segmentAnchorOptions,
  };
};

export const buildFirstPackConfigurations = (
  knownSpeakerCount: number | null,
): SpeakerEvaluationConfiguration[] => {
  if (
    knownSpeakerCount !== null &&
    (!Number.isSafeInteger(knownSpeakerCount) ||
      knownSpeakerCount < 1 ||
      knownSpeakerCount > MAX_ANNOTATION_SPEAKERS)
  ) {
    throw new TypeError('Known speaker count must be null or an integer from 1 to 12.');
  }
  const baseline: SpeakerEvaluationConfiguration = {
    name: 'baseline-production',
    ...SPEAKER_EVALUATION_BASELINE,
    segmentAnchorOptions: { ...DEFAULT_SEGMENT_ANCHOR_REASSIGNMENT_OPTIONS },
  };
  const withChanges = (
    name: string,
    changes: Partial<SpeakerEvaluationConfiguration>,
  ): SpeakerEvaluationConfiguration =>
    validateSpeakerEvaluationConfiguration({ ...baseline, ...changes, name });

  const configurations = [
    baseline,
    withChanges('threshold-0.60', { clusteringThreshold: 0.6 }),
    withChanges('threshold-0.675', { clusteringThreshold: 0.675 }),
    withChanges('threshold-0.825', { clusteringThreshold: 0.825 }),
    withChanges('threshold-0.90', { clusteringThreshold: 0.9 }),
    withChanges('shift-minus-500ms', { diarizationShiftMs: -500 }),
    withChanges('shift-minus-250ms', { diarizationShiftMs: -250 }),
    withChanges('shift-plus-250ms', { diarizationShiftMs: 250 }),
    withChanges('duration-on-0.10-off-0.30', {
      minDurationOn: 0.1,
      minDurationOff: 0.3,
    }),
    withChanges('duration-on-0.20-off-0.30', { minDurationOff: 0.3 }),
    withChanges('duration-on-0.20-off-0.70', { minDurationOff: 0.7 }),
    withChanges('duration-on-0.30-off-0.50', { minDurationOn: 0.3 }),
  ];
  if (knownSpeakerCount !== null) {
    configurations.push(
      withChanges(`fixed-speakers-${knownSpeakerCount}`, {
        expectedSpeakerCount: knownSpeakerCount,
      }),
    );
  }
  return configurations;
};

export const parseSpeakerAnnotation = (
  value: unknown,
  whisperWordCount?: number,
): SpeakerAnnotation => {
  if (!isRecord(value) || value.schemaVersion !== SPEAKER_EVALUATION_SCHEMA_VERSION) {
    return fail('Annotation must use schemaVersion 1.');
  }
  const durationMs = readSafeInteger(
    value.durationMs,
    'durationMs',
    1,
    24 * 60 * 60 * 1_000,
  );
  if (
    !Array.isArray(value.speakers) ||
    value.speakers.length === 0 ||
    value.speakers.length > MAX_ANNOTATION_SPEAKERS
  ) {
    return fail('speakers must contain from 1 to 12 anonymous labels.');
  }
  const speakers = value.speakers.map((speaker, index) =>
    readSpeakerLabel(speaker, `speakers[${index}]`),
  );
  if (new Set(speakers).size !== speakers.length) {
    return fail('Speaker labels must be unique.');
  }
  const speakerSet = new Set(speakers);
  if (!Array.isArray(value.ranges) || !Array.isArray(value.words)) {
    return fail('ranges and words must both be arrays.');
  }
  const ranges = value.ranges.map((candidate, index): SpeakerAnnotationRange => {
    if (!isRecord(candidate)) return fail(`ranges[${index}] must be an object.`);
    const startMs = readSafeInteger(
      candidate.startMs,
      `ranges[${index}].startMs`,
      0,
      durationMs - 1,
    );
    const endMs = readSafeInteger(
      candidate.endMs,
      `ranges[${index}].endMs`,
      startMs + 1,
      durationMs,
    );
    const speaker = readSpeakerLabel(candidate.speaker, `ranges[${index}].speaker`);
    if (!speakerSet.has(speaker)) {
      return fail(`ranges[${index}].speaker is not listed in speakers.`);
    }
    return { startMs, endMs, speaker };
  }).sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].startMs < ranges[index - 1].endMs) {
      return fail('Annotation ranges cannot overlap.');
    }
  }
  const maximumWordIndex = whisperWordCount === undefined
    ? 999_999
    : Math.max(0, whisperWordCount - 1);
  const words = value.words.map((candidate, index): SpeakerAnnotationWord => {
    if (!isRecord(candidate)) return fail(`words[${index}] must be an object.`);
    const wordIndex = readSafeInteger(
      candidate.wordIndex,
      `words[${index}].wordIndex`,
      0,
      maximumWordIndex,
    );
    const speaker = readSpeakerLabel(candidate.speaker, `words[${index}].speaker`);
    if (!speakerSet.has(speaker)) {
      return fail(`words[${index}].speaker is not listed in speakers.`);
    }
    return { wordIndex, speaker };
  }).sort((left, right) => left.wordIndex - right.wordIndex);
  if (new Set(words.map((word) => word.wordIndex)).size !== words.length) {
    return fail('Annotation word indexes must be unique.');
  }
  if (ranges.length === 0 && words.length === 0) {
    return fail('Annotation must contain at least one time range or word assignment.');
  }
  return {
    schemaVersion: SPEAKER_EVALUATION_SCHEMA_VERSION,
    durationMs,
    speakers,
    ranges,
    words,
  };
};

export const shiftDiarizationSegments = (
  segments: readonly SpeakerDiarizationSegment[],
  shiftMs: number,
): SpeakerDiarizationSegment[] => {
  readSafeInteger(
    shiftMs,
    'shiftMs',
    -MAX_DIARIZATION_SHIFT_MS,
    MAX_DIARIZATION_SHIFT_MS,
  );
  return segments.flatMap((segment) => {
    const startMs = Math.max(0, segment.startMs + shiftMs);
    const endMs = segment.endMs + shiftMs;
    return endMs > startMs ? [{ ...segment, startMs, endMs }] : [];
  });
};

export const summarizeRawDiarization = (
  diarization: readonly SpeakerDiarizationSegment[],
  words: readonly WhisperWord[],
): RawDiarizationSummary => {
  const byCluster = new Map<number, Omit<RawClusterSupport, 'supported'>>();
  for (const segment of diarization) {
    const current = byCluster.get(segment.cluster) ?? {
      cluster: segment.cluster,
      segmentCount: 0,
      segmentDurationMs: 0,
      wordCount: 0,
      wordSupportMs: 0,
    };
    current.segmentCount += 1;
    current.segmentDurationMs += segment.endMs - segment.startMs;
    byCluster.set(segment.cluster, current);
  }
  let totalWordSupportMs = 0;
  for (const word of words) {
    if (!isLexicalWord(word)) continue;
    const choice = chooseRawCluster(word, diarization);
    if (choice.cluster === null || choice.directSupportMs <= 0) continue;
    const current = byCluster.get(choice.cluster);
    if (!current) continue;
    current.wordCount += 1;
    current.wordSupportMs += choice.directSupportMs;
    totalWordSupportMs += choice.directSupportMs;
  }
  const minimumReliableSupportMs = Math.max(
    MIN_RELIABLE_CLUSTER_SUPPORT_MS,
    Math.min(
      MAX_RELIABLE_CLUSTER_SUPPORT_MS,
      Math.round(totalWordSupportMs * RELIABLE_CLUSTER_SUPPORT_RATIO),
    ),
  );
  let supported = [...byCluster.values()]
    .filter((cluster) => cluster.wordSupportMs >= minimumReliableSupportMs)
    .sort(
      (left, right) =>
        right.wordSupportMs - left.wordSupportMs || left.cluster - right.cluster,
    )
    .slice(0, MAX_RELIABLE_AUTOMATIC_SPEAKERS);
  if (supported.length === 0 && byCluster.size > 0) {
    supported = [...byCluster.values()]
      .sort(
        (left, right) =>
          right.segmentDurationMs - left.segmentDurationMs ||
          left.cluster - right.cluster,
      )
      .slice(0, 1);
  }
  const supportedIds = new Set(supported.map((cluster) => cluster.cluster));
  const clusters = [...byCluster.values()]
    .map((cluster) => ({ ...cluster, supported: supportedIds.has(cluster.cluster) }))
    .sort(
      (left, right) =>
        right.wordSupportMs - left.wordSupportMs ||
        right.segmentDurationMs - left.segmentDurationMs ||
        left.cluster - right.cluster,
    );
  return {
    rawClusterCount: byCluster.size,
    rawSegmentCount: diarization.length,
    supportedClusterCount: supportedIds.size,
    minimumReliableSupportMs,
    clusters,
  };
};

interface EmbeddingConsolidationLimits {
  minimumReliablePairSimilarity: number;
  minimumFilteredSimilarity: number;
  minimumFilteredMargin: number;
  minimumFilteredSampleDurationMs: number;
}

const embeddingConsolidationLimits = (
  mode: EmbeddingConsolidationRecoveryMode,
): EmbeddingConsolidationLimits => {
  switch (mode) {
    case 'embedding-consolidation-strict':
      return {
        minimumReliablePairSimilarity: 0.75,
        minimumFilteredSimilarity: 0.7,
        minimumFilteredMargin: 0.02,
        minimumFilteredSampleDurationMs: 1_000,
      };
    case 'embedding-consolidation-balanced':
      return {
        minimumReliablePairSimilarity: 0.7,
        minimumFilteredSimilarity: 0.65,
        minimumFilteredMargin: 0.04,
        minimumFilteredSampleDurationMs: 750,
      };
    case 'embedding-consolidation-exploratory':
      return {
        minimumReliablePairSimilarity: 0.6,
        minimumFilteredSimilarity: 0.6,
        minimumFilteredMargin: 0.05,
        minimumFilteredSampleDurationMs: 500,
      };
  }
};

export const isEmbeddingConsolidationRecoveryMode = (
  mode: SpeakerEvaluationRecoveryMode,
): mode is EmbeddingConsolidationRecoveryMode =>
  mode.startsWith('embedding-consolidation-');

export const isNovelSpeakerRecoveryMode = (
  mode: SpeakerEvaluationRecoveryMode,
): mode is NovelSpeakerRecoveryMode => mode.startsWith('novel-speaker-');

export const isSegmentAnchorReassignmentRecoveryMode = (
  mode: SpeakerEvaluationRecoveryMode,
): mode is Extract<
  SpeakerEvaluationRecoveryMode,
  'novel-speaker-balanced-segment-reassignment'
> => mode === 'novel-speaker-balanced-segment-reassignment';

export const isClusterSimilarityRecoveryMode = (
  mode: SpeakerEvaluationRecoveryMode,
): mode is ClusterSimilarityRecoveryMode =>
  isEmbeddingConsolidationRecoveryMode(mode) || isNovelSpeakerRecoveryMode(mode);

export interface SpeakerDiarizationRecoveryResult {
  segments: SpeakerDiarizationSegment[];
  diagnostics: SpeakerRecoveryDiagnostics;
  canonicalReliableClusters: number[];
  clusterMapping: ReadonlyMap<number, number>;
}

export interface EmbeddingConsolidationOptions {
  minimumInternalMedianSimilarity?: number;
}

export interface SegmentAnchorReassignmentOptions {
  minimumInternalMedianSimilarity: number;
  minimumSimilarity: number;
  minimumMargin: number;
  minimumSampleDurationMs: number;
  /**
   * Blast-radius bound: reassignment only touches a flagged cluster whose
   * word support is at most this share of all supported word support.
   * Larger flagged clusters keep guard-only behavior — their segments stay
   * untouched — because demoting a primary speaker's unmatched segments
   * erases most of a transcript (measured in the synthetic ground-truth
   * report: 98.77% -> 45.06% correct).
   */
  maximumFlaggedSupportShare: number;
}

export const DEFAULT_SEGMENT_ANCHOR_REASSIGNMENT_OPTIONS: SegmentAnchorReassignmentOptions = {
  minimumInternalMedianSimilarity: 0.4,
  minimumSimilarity: 0.5,
  minimumMargin: 0.2,
  minimumSampleDurationMs: 500,
  maximumFlaggedSupportShare: 0.15,
};

export interface SegmentAnchorReassignmentResult {
  segments: SpeakerDiarizationSegment[];
  reassignedSegmentCount: number;
  reassignedDurationMs: number;
  demotedSegmentCount: number;
  demotedDurationMs: number;
}

/**
 * Re-clusters only through aggregate local voice similarities. Reliable
 * clusters can be consolidated into their strongest member, while a filtered
 * cluster needs both an absolute similarity and a nearest-neighbor margin.
 * No embeddings leave the child process or enter the report.
 */
export const applyExperimentEmbeddingConsolidation = (
  diarization: readonly SpeakerDiarizationSegment[],
  rawSummary: RawDiarizationSummary,
  analysis: SpeakerClusterSimilarityAnalysis,
  mode: EmbeddingConsolidationRecoveryMode,
  options: EmbeddingConsolidationOptions = {},
): SpeakerDiarizationRecoveryResult => {
  const limits = embeddingConsolidationLimits(mode);
  const clusterSupport = new Map(
    rawSummary.clusters.map((cluster) => [cluster.cluster, cluster]),
  );
  const supportedClusters = rawSummary.clusters
    .filter((cluster) => cluster.supported)
    .map((cluster) => cluster.cluster);
  const supportedSet = new Set(supportedClusters);
  const inconsistentClusters = new Set<number>();
  let segmentGuardEvaluatedClusterCount = 0;
  let segmentGuardRejectedReliableMergeCount = 0;
  let segmentGuardRejectedFilteredMatchCount = 0;
  if (options.minimumInternalMedianSimilarity !== undefined) {
    const threshold = options.minimumInternalMedianSimilarity;
    if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1) {
      return fail('Segment-consistency threshold was out of bounds.');
    }
    const seenConsistency = new Set<number>();
    for (const consistency of analysis.segmentConsistency ?? []) {
      if (
        !supportedSet.has(consistency.cluster) ||
        seenConsistency.has(consistency.cluster) ||
        !Number.isSafeInteger(consistency.readySegmentCount) ||
        consistency.readySegmentCount < 0 ||
        !Number.isSafeInteger(consistency.pairCount) ||
        consistency.pairCount !==
          consistency.readySegmentCount * (consistency.readySegmentCount - 1) / 2 ||
        (consistency.pairCount === 0 && consistency.medianSimilarity !== null) ||
        (consistency.pairCount > 0 &&
          (consistency.medianSimilarity === null ||
            !Number.isFinite(consistency.medianSimilarity) ||
            consistency.medianSimilarity < -1 ||
            consistency.medianSimilarity > 1))
      ) {
        return fail('Segment-consistency analysis was invalid.');
      }
      seenConsistency.add(consistency.cluster);
      if (consistency.pairCount > 0 && consistency.medianSimilarity !== null) {
        segmentGuardEvaluatedClusterCount += 1;
        if (consistency.medianSimilarity < threshold) {
          inconsistentClusters.add(consistency.cluster);
        }
      }
    }
    if (seenConsistency.size !== supportedSet.size) {
      return fail('Segment-consistency analysis was incomplete.');
    }
  }
  const parent = new Map(supportedClusters.map((cluster) => [cluster, cluster]));
  const find = (cluster: number): number => {
    const current = parent.get(cluster);
    if (current === undefined) return fail('Similarity analysis used an unknown cluster.');
    if (current === cluster) return cluster;
    const root = find(current);
    parent.set(cluster, root);
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    parent.set(Math.max(leftRoot, rightRoot), Math.min(leftRoot, rightRoot));
  };
  for (const pair of analysis.supportedSimilarities) {
    if (
      !supportedSet.has(pair.leftCluster) ||
      !supportedSet.has(pair.rightCluster) ||
      !Number.isFinite(pair.similarity) ||
      pair.similarity < -1 ||
      pair.similarity > 1
    ) {
      return fail('Similarity analysis contained an invalid reliable-cluster pair.');
    }
    if (
      pair.similarity >= limits.minimumReliablePairSimilarity &&
      (inconsistentClusters.has(pair.leftCluster) ||
        inconsistentClusters.has(pair.rightCluster))
    ) {
      segmentGuardRejectedReliableMergeCount += 1;
    } else if (pair.similarity >= limits.minimumReliablePairSimilarity) {
      union(pair.leftCluster, pair.rightCluster);
    }
  }
  const membersByRoot = new Map<number, number[]>();
  for (const cluster of supportedClusters) {
    const root = find(cluster);
    const members = membersByRoot.get(root);
    if (members) members.push(cluster);
    else membersByRoot.set(root, [cluster]);
  }
  const canonicalBySupportedCluster = new Map<number, number>();
  for (const members of membersByRoot.values()) {
    const canonical = [...members].sort((left, right) => {
      const leftSupport = clusterSupport.get(left)?.wordSupportMs ?? 0;
      const rightSupport = clusterSupport.get(right)?.wordSupportMs ?? 0;
      return rightSupport - leftSupport || left - right;
    })[0];
    members.forEach((cluster) => canonicalBySupportedCluster.set(cluster, canonical));
  }
  const remap = new Map<number, number>();
  for (const [cluster, canonical] of canonicalBySupportedCluster) {
    if (cluster !== canonical) remap.set(cluster, canonical);
  }
  const seenMatches = new Set<number>();
  let recoveredFilteredClusterCount = 0;
  for (const match of analysis.matches) {
    if (seenMatches.has(match.cluster)) {
      return fail('Similarity analysis repeated a filtered cluster.');
    }
    seenMatches.add(match.cluster);
    if (!clusterSupport.has(match.cluster) || supportedSet.has(match.cluster)) {
      return fail('Similarity analysis contained an invalid filtered cluster.');
    }
    if (
      !match.ready ||
      match.nearestSupportedCluster === null ||
      match.similarity === null ||
      match.margin === null ||
      !Number.isFinite(match.similarity) ||
      !Number.isFinite(match.margin) ||
      !supportedSet.has(match.nearestSupportedCluster) ||
      match.sampleDurationMs < limits.minimumFilteredSampleDurationMs ||
      match.similarity < limits.minimumFilteredSimilarity ||
      match.margin < limits.minimumFilteredMargin
    ) {
      continue;
    }
    if (inconsistentClusters.has(match.nearestSupportedCluster)) {
      segmentGuardRejectedFilteredMatchCount += 1;
      continue;
    }
    const canonical = canonicalBySupportedCluster.get(match.nearestSupportedCluster);
    if (canonical === undefined) {
      return fail('Similarity analysis could not resolve a reliable cluster.');
    }
    remap.set(match.cluster, canonical);
    recoveredFilteredClusterCount += 1;
  }
  let remappedSegmentCount = 0;
  let remappedDurationMs = 0;
  const segments = diarization.map((segment) => {
    const cluster = remap.get(segment.cluster);
    if (cluster === undefined) return { ...segment };
    remappedSegmentCount += 1;
    remappedDurationMs += segment.endMs - segment.startMs;
    return { ...segment, cluster };
  });
  const remappedWordCount = [...remap.keys()].reduce(
    (total, cluster) => total + (clusterSupport.get(cluster)?.wordCount ?? 0),
    0,
  );
  return {
    segments,
    canonicalReliableClusters: [...new Set(canonicalBySupportedCluster.values())]
      .sort((left, right) => left - right),
    clusterMapping: remap,
    diagnostics: {
      mode,
      eligibleRunCount: 0,
      recoveredRunCount: 0,
      recoveredSegmentCount: 0,
      recoveredWordCount: 0,
      rejectedByBoundsCount: 0,
      rejectedByNeighborCount: 0,
      rejectedBySourceBoundaryCount: 0,
      mergedReliableClusterCount: [...canonicalBySupportedCluster]
        .filter(([cluster, canonical]) => cluster !== canonical).length,
      recoveredFilteredClusterCount,
      remappedSegmentCount,
      remappedDurationMs,
      remappedWordCount,
      promotedNovelClusterCount: 0,
      promotedNovelWordCount: 0,
      demotedClusterCount: 0,
      demotedWordCount: 0,
      finalAllowedClusterCount: 0,
      segmentGuardEvaluatedClusterCount,
      segmentGuardInconsistentClusterCount: inconsistentClusters.size,
      segmentGuardRejectedReliableMergeCount,
      segmentGuardRejectedFilteredMatchCount,
    },
  };
};

/**
 * Splits only a supported cluster that has been measured as internally
 * inconsistent. A raw segment can move only when its own local sample has a
 * strong, clearly separated match to a different stable supported cluster.
 * Every unmeasured or weak segment from that mixed cluster is removed from
 * alignment input so it becomes Unclear rather than inheriting a forced label.
 */
export const applyExperimentSegmentAnchorReassignment = (
  diarization: readonly SpeakerDiarizationSegment[],
  rawSummary: RawDiarizationSummary,
  analysis: SpeakerClusterSimilarityAnalysis,
  clusterMapping: ReadonlyMap<number, number>,
  options: SegmentAnchorReassignmentOptions,
): SegmentAnchorReassignmentResult => {
  for (const [field, value] of Object.entries(options)) {
    if (!Number.isFinite(value)) {
      return fail(`Segment-anchor ${field} was not finite.`);
    }
  }
  if (
    options.minimumInternalMedianSimilarity < -1 ||
    options.minimumInternalMedianSimilarity > 1 ||
    options.minimumSimilarity < -1 ||
    options.minimumSimilarity > 1 ||
    options.minimumMargin < 0 ||
    options.minimumMargin > 2 ||
    !Number.isSafeInteger(options.minimumSampleDurationMs) ||
    options.minimumSampleDurationMs < 1 ||
    options.minimumSampleDurationMs > 10_000 ||
    options.maximumFlaggedSupportShare <= 0 ||
    options.maximumFlaggedSupportShare > 1
  ) {
    return fail('Segment-anchor reassignment settings were out of bounds.');
  }
  const supportedClusters = new Set(
    rawSummary.clusters.filter((cluster) => cluster.supported).map((cluster) => cluster.cluster),
  );
  const consistencyByCluster = new Map<number, SupportedClusterSegmentConsistency>();
  for (const consistency of analysis.segmentConsistency ?? []) {
    if (
      !supportedClusters.has(consistency.cluster) ||
      consistencyByCluster.has(consistency.cluster) ||
      consistency.readySegmentCount < 0 ||
      consistency.pairCount !==
        consistency.readySegmentCount * (consistency.readySegmentCount - 1) / 2 ||
      (consistency.pairCount === 0 && consistency.medianSimilarity !== null) ||
      (consistency.pairCount > 0 &&
        (consistency.medianSimilarity === null ||
          !Number.isFinite(consistency.medianSimilarity) ||
          consistency.medianSimilarity < -1 ||
          consistency.medianSimilarity > 1))
    ) {
      return fail('Segment-anchor consistency analysis was invalid.');
    }
    consistencyByCluster.set(consistency.cluster, consistency);
  }
  if (consistencyByCluster.size !== supportedClusters.size) {
    return fail('Segment-anchor consistency analysis was incomplete.');
  }
  const totalSupportedWordSupportMs = rawSummary.clusters
    .filter((cluster) => cluster.supported)
    .reduce((total, cluster) => total + cluster.wordSupportMs, 0);
  const wordSupportByCluster = new Map(
    rawSummary.clusters.map((cluster) => [cluster.cluster, cluster.wordSupportMs]),
  );
  const inconsistentClusters = new Set(
    [...consistencyByCluster.values()]
      .filter((entry) =>
        entry.pairCount > 0 &&
        entry.medianSimilarity !== null &&
        entry.medianSimilarity < options.minimumInternalMedianSimilarity)
      // Blast-radius bound: a flagged cluster carrying more than the
      // configured share of all supported word support keeps guard-only
      // behavior. Reassignment exists for small mixed clusters; demoting a
      // primary speaker's unmatched segments erases most of a transcript.
      .filter((entry) =>
        totalSupportedWordSupportMs > 0 &&
        (wordSupportByCluster.get(entry.cluster) ?? 0) <=
          totalSupportedWordSupportMs * options.maximumFlaggedSupportShare)
      .map((entry) => entry.cluster),
  );
  const anchorsBySegment = new Map<string, SupportedClusterSegmentAnchorMatch>();
  for (const anchor of analysis.segmentAnchorMatches ?? []) {
    const key = `${anchor.cluster}:${anchor.startMs}:${anchor.endMs}`;
    if (
      !supportedClusters.has(anchor.cluster) ||
      anchorsBySegment.has(key) ||
      !Number.isSafeInteger(anchor.startMs) ||
      !Number.isSafeInteger(anchor.endMs) ||
      anchor.startMs < 0 ||
      anchor.endMs <= anchor.startMs ||
      !Number.isSafeInteger(anchor.sampleDurationMs) ||
      anchor.sampleDurationMs < 0 ||
      (anchor.ready &&
        ((anchor.nearestOtherSupportedCluster === null) !== (anchor.similarity === null))) ||
      (!anchor.ready &&
        (anchor.nearestOtherSupportedCluster !== null ||
          anchor.similarity !== null ||
          anchor.secondSimilarity !== null ||
          anchor.margin !== null)) ||
      (anchor.nearestOtherSupportedCluster !== null &&
        (!supportedClusters.has(anchor.nearestOtherSupportedCluster) ||
          anchor.nearestOtherSupportedCluster === anchor.cluster)) ||
      (anchor.similarity !== null &&
        (!Number.isFinite(anchor.similarity) || anchor.similarity < -1 || anchor.similarity > 1)) ||
      (anchor.secondSimilarity !== null &&
        (!Number.isFinite(anchor.secondSimilarity) ||
          anchor.secondSimilarity < -1 ||
          anchor.secondSimilarity > 1)) ||
      (anchor.margin !== null &&
        (!Number.isFinite(anchor.margin) || anchor.margin < 0 || anchor.margin > 2))
    ) {
      return fail('Segment-anchor similarity analysis was invalid.');
    }
    anchorsBySegment.set(key, anchor);
  }
  let reassignedSegmentCount = 0;
  let reassignedDurationMs = 0;
  let demotedSegmentCount = 0;
  let demotedDurationMs = 0;
  const segments = diarization.flatMap((segment) => {
    if (!inconsistentClusters.has(segment.cluster)) return [{ ...segment }];
    const anchor = anchorsBySegment.get(
      `${segment.cluster}:${segment.startMs}:${segment.endMs}`,
    );
    const target = anchor?.nearestOtherSupportedCluster;
    const canonicalTarget = target === null || target === undefined
      ? undefined
      : clusterMapping.get(target) ?? target;
    if (
      !anchor ||
      !anchor.ready ||
      target === null ||
      target === undefined ||
      canonicalTarget === undefined ||
      inconsistentClusters.has(target) ||
      anchor.similarity === null ||
      anchor.margin === null ||
      anchor.sampleDurationMs < options.minimumSampleDurationMs ||
      anchor.similarity < options.minimumSimilarity ||
      anchor.margin < options.minimumMargin
    ) {
      demotedSegmentCount += 1;
      demotedDurationMs += segment.endMs - segment.startMs;
      return [];
    }
    reassignedSegmentCount += 1;
    reassignedDurationMs += segment.endMs - segment.startMs;
    return [{ ...segment, cluster: canonicalTarget }];
  });
  return {
    segments,
    reassignedSegmentCount,
    reassignedDurationMs,
    demotedSegmentCount,
    demotedDurationMs,
  };
};

const wordKey = (word: Pick<WhisperWord, 'startMs' | 'endMs' | 'text'>): string =>
  `${word.startMs}\u0001${word.endMs}\u0001${word.text}`;

const systemSpeakerByWord = (
  whisper: NormalizedWhisperOutput,
  alignedSegments: readonly TranscriptSegment[],
): Array<string | null> => {
  const indexesByKey = new Map<string, number[]>();
  whisper.words.forEach((word, index) => {
    const key = wordKey(word);
    const indexes = indexesByKey.get(key);
    if (indexes) indexes.push(index);
    else indexesByKey.set(key, [index]);
  });
  const result = Array.from<string | null>({ length: whisper.words.length }).fill(null);
  for (const segment of alignedSegments) {
    for (const word of segment.words) {
      const indexes = indexesByKey.get(wordKey(word));
      const index = indexes?.shift();
      if (index !== undefined) result[index] = segment.speakerId;
    }
  }
  return result;
};

interface RecoveryLimits {
  maximumLexicalWords: number;
  maximumRunDurationMs: number;
  maximumTextCharacters: number;
  maximumNeighborGapMs: number;
}

const recoveryLimits = (
  mode: FilteredBridgeRecoveryMode,
): RecoveryLimits => {
  switch (mode) {
    case 'filtered-bridge-one-word':
      return {
        maximumLexicalWords: 1,
        maximumRunDurationMs: 500,
        maximumTextCharacters: 40,
        maximumNeighborGapMs: 250,
      };
    case 'filtered-bridge-two-words':
      return {
        maximumLexicalWords: 2,
        maximumRunDurationMs: 900,
        maximumTextCharacters: 80,
        maximumNeighborGapMs: 300,
      };
    case 'filtered-bridge-three-words':
      return {
        maximumLexicalWords: 3,
        maximumRunDurationMs: 1_200,
        maximumTextCharacters: 120,
        maximumNeighborGapMs: 400,
      };
  }
};

interface RecoverySegmentEvidence {
  kind: 'filtered' | 'other' | 'supported';
  lexicalWordCount: number;
  sourceSegmentIndex: number | null;
  stable: boolean;
}

const alignedWordIndexesBySegment = (
  whisper: NormalizedWhisperOutput,
  segments: readonly TranscriptSegment[],
): number[][] => {
  const indexesByKey = new Map<string, number[]>();
  whisper.words.forEach((word, index) => {
    const key = wordKey(word);
    const indexes = indexesByKey.get(key);
    if (indexes) indexes.push(index);
    else indexesByKey.set(key, [index]);
  });
  return segments.map((segment) => segment.words.flatMap((word) => {
    const index = indexesByKey.get(wordKey(word))?.shift();
    return index === undefined ? [] : [index];
  }));
};

interface NovelSpeakerLimits {
  maximumNearestSimilarity: number;
  minimumWordSupportMs: number;
  minimumSampleDurationMs: number;
}

const novelSpeakerLimits = (
  mode: NovelSpeakerRecoveryMode,
): NovelSpeakerLimits => {
  switch (mode) {
    case 'novel-speaker-strict':
      return {
        maximumNearestSimilarity: 0.35,
        minimumWordSupportMs: 1_000,
        minimumSampleDurationMs: 1_000,
      };
    case 'novel-speaker-balanced':
    case 'novel-speaker-balanced-segment-guard':
    case 'novel-speaker-balanced-segment-reassignment':
      return {
        maximumNearestSimilarity: 0.4,
        minimumWordSupportMs: 750,
        minimumSampleDurationMs: 750,
      };
    case 'novel-speaker-exploratory':
      return {
        maximumNearestSimilarity: 0.5,
        minimumWordSupportMs: 500,
        minimumSampleDurationMs: 500,
      };
  }
};

interface DirectSegmentCluster {
  cluster: number;
  competingSupportMs: number;
  lexicalWordCount: number;
  wordDurationMs: number;
}

const directSegmentCluster = (
  whisper: NormalizedWhisperOutput,
  diarization: readonly SpeakerDiarizationSegment[],
  wordIndexes: readonly number[],
): DirectSegmentCluster | null => {
  const lexicalWords = wordIndexes
    .map((index) => whisper.words[index])
    .filter(isLexicalWord);
  if (lexicalWords.length === 0) return null;
  const choices = lexicalWords.map((word) => chooseRawCluster(word, diarization));
  if (choices.some((choice) => choice.cluster === null)) return null;
  const clusters = new Set(choices.map((choice) => choice.cluster as number));
  if (clusters.size !== 1) return null;
  return {
    cluster: choices[0].cluster as number,
    competingSupportMs: choices.reduce(
      (total, choice) => total + choice.competingSupportMs,
      0,
    ),
    lexicalWordCount: lexicalWords.length,
    wordDurationMs: lexicalWords.reduce(
      (total, word) => total + Math.max(1, word.endMs - word.startMs),
      0,
    ),
  };
};

/**
 * Keeps the canonical reliable voice groups, then reserves remaining slots for
 * directly timed clusters that are sufficiently unlike every reliable voice.
 * The final allowlist never exceeds the production 12-label ceiling. Clusters
 * outside the allowlist are demoted to Unclear; overlap never gets promoted.
 */
export const applyExperimentNovelSpeakerPreservation = (
  whisper: NormalizedWhisperOutput,
  diarization: readonly SpeakerDiarizationSegment[],
  alignedSegments: readonly TranscriptSegment[],
  rawSummary: RawDiarizationSummary,
  analysis: SpeakerClusterSimilarityAnalysis,
  canonicalReliableClusters: readonly number[],
  consolidationDiagnostics: SpeakerRecoveryDiagnostics,
  mode: NovelSpeakerRecoveryMode,
): SpeakerRecoveryResult => {
  const limits = novelSpeakerLimits(mode);
  const clusterSupport = new Map(
    rawSummary.clusters.map((cluster) => [cluster.cluster, cluster]),
  );
  const canonical = [...new Set(canonicalReliableClusters)]
    .sort((left, right) => left - right);
  if (canonical.length > MAX_RELIABLE_AUTOMATIC_SPEAKERS) {
    return fail('Novel-speaker recovery exceeded the reliable label ceiling.');
  }
  const remainingSlots = MAX_RELIABLE_AUTOMATIC_SPEAKERS - canonical.length;
  const candidates = analysis.matches
    .filter((match) => {
      const support = clusterSupport.get(match.cluster);
      return Boolean(
        support &&
        !support.supported &&
        match.ready &&
        match.similarity !== null &&
        match.similarity < limits.maximumNearestSimilarity &&
        match.sampleDurationMs >= limits.minimumSampleDurationMs &&
        support.wordSupportMs >= limits.minimumWordSupportMs,
      );
    })
    .sort((left, right) => {
      const leftSupport = clusterSupport.get(left.cluster)?.wordSupportMs ?? 0;
      const rightSupport = clusterSupport.get(right.cluster)?.wordSupportMs ?? 0;
      return rightSupport - leftSupport ||
        (left.similarity as number) - (right.similarity as number) ||
        left.cluster - right.cluster;
    })
    .slice(0, remainingSlots);
  const novelClusters = new Set(candidates.map((candidate) => candidate.cluster));
  const allowedClusters = new Set([...canonical, ...novelClusters]);
  const segments = alignedSegments.map((segment) => ({
    ...segment,
    words: segment.words.map((word) => ({ ...word })),
  }));
  const wordIndexes = alignedWordIndexesBySegment(whisper, segments);
  const directClusters = wordIndexes.map((indexes) =>
    directSegmentCluster(whisper, diarization, indexes));
  const scoresBySpeaker = new Map<string, Map<number, number>>();
  segments.forEach((segment, index) => {
    const direct = directClusters[index];
    if (!segment.speakerId || !direct) return;
    const scores = scoresBySpeaker.get(segment.speakerId) ?? new Map<number, number>();
    scores.set(
      direct.cluster,
      (scores.get(direct.cluster) ?? 0) + direct.wordDurationMs,
    );
    scoresBySpeaker.set(segment.speakerId, scores);
  });
  const clusterBySpeaker = new Map<string, number>();
  for (const [speakerId, scores] of scoresBySpeaker) {
    const selected = [...scores.entries()].sort(
      (left, right) => right[1] - left[1] || left[0] - right[0],
    )[0];
    if (selected) clusterBySpeaker.set(speakerId, selected[0]);
  }

  const demotedClusters = new Set<number>();
  let demotedWordCount = 0;
  let promotedNovelWordCount = 0;
  segments.forEach((segment, index) => {
    const direct = directClusters[index];
    if (segment.speakerId) {
      const cluster = clusterBySpeaker.get(segment.speakerId);
      if (cluster !== undefined && !allowedClusters.has(cluster)) {
        segment.speakerId = null;
        demotedClusters.add(cluster);
        demotedWordCount += direct?.lexicalWordCount ?? 0;
      }
      return;
    }
    if (
      direct &&
      direct.competingSupportMs === 0 &&
      novelClusters.has(direct.cluster)
    ) {
      segment.speakerId = `experiment-novel-cluster-${direct.cluster}`;
      promotedNovelWordCount += direct.lexicalWordCount;
    }
  });

  return {
    segments,
    diagnostics: {
      ...consolidationDiagnostics,
      mode,
      promotedNovelClusterCount: novelClusters.size,
      promotedNovelWordCount,
      demotedClusterCount: demotedClusters.size,
      demotedWordCount,
      finalAllowedClusterCount: allowedClusters.size,
    },
  };
};

const recoverySegmentEvidence = (
  whisper: NormalizedWhisperOutput,
  diarization: readonly SpeakerDiarizationSegment[],
  supportedClusters: ReadonlySet<number>,
  wordIndexes: readonly number[],
): RecoverySegmentEvidence => {
  const lexicalWords = wordIndexes
    .map((index) => whisper.words[index])
    .filter(isLexicalWord);
  if (lexicalWords.length === 0) {
    return {
      kind: 'other',
      lexicalWordCount: 0,
      sourceSegmentIndex: null,
      stable: false,
    };
  }
  const sourceSegmentIndexes = new Set(
    lexicalWords.map((word) => word.segmentIndex),
  );
  const choices = lexicalWords.map((word) => chooseRawCluster(word, diarization));
  if (choices.some((choice) => choice.cluster === null)) {
    return {
      kind: 'other',
      lexicalWordCount: lexicalWords.length,
      sourceSegmentIndex:
        sourceSegmentIndexes.size === 1 ? lexicalWords[0].segmentIndex : null,
      stable: false,
    };
  }
  const clusters = new Set(choices.map((choice) => choice.cluster as number));
  if (clusters.size !== 1) {
    return {
      kind: 'other',
      lexicalWordCount: lexicalWords.length,
      sourceSegmentIndex:
        sourceSegmentIndexes.size === 1 ? lexicalWords[0].segmentIndex : null,
      stable: false,
    };
  }
  const cluster = choices[0].cluster as number;
  const directSupportMs = choices.reduce(
    (total, choice) => total + choice.directSupportMs,
    0,
  );
  const competingSupportMs = choices.reduce(
    (total, choice) => total + choice.competingSupportMs,
    0,
  );
  const supported = supportedClusters.has(cluster);
  return {
    kind: supported && sourceSegmentIndexes.size === 1
      ? 'supported'
      : !supported &&
          sourceSegmentIndexes.size === 1 &&
          competingSupportMs === 0
        ? 'filtered'
        : 'other',
    lexicalWordCount: lexicalWords.length,
    sourceSegmentIndex:
      sourceSegmentIndexes.size === 1 ? lexicalWords[0].segmentIndex : null,
    stable:
      supported &&
      sourceSegmentIndexes.size === 1 &&
      directSupportMs >= 200 &&
      directSupportMs - competingSupportMs >= 100 &&
      (competingSupportMs === 0 || directSupportMs / competingSupportMs >= 1.5),
  };
};

/**
 * Applies an evaluation-only extension after the unchanged production
 * alignment. It can recover only directly timed words assigned to clusters
 * rejected by the reliability filter, and only when strong matching speakers
 * enclose the complete run inside one Whisper segment. Timing gaps, overlap,
 * missing timing, one-sided evidence, and conflicting speakers stay Unclear.
 */
export const applyExperimentFilteredFragmentRecovery = (
  whisper: NormalizedWhisperOutput,
  diarization: readonly SpeakerDiarizationSegment[],
  alignedSegments: readonly TranscriptSegment[],
  mode: SpeakerEvaluationRecoveryMode,
): SpeakerRecoveryResult => {
  if (!SPEAKER_EVALUATION_RECOVERY_MODES.has(mode)) {
    return fail('Unsupported filtered-fragment recovery mode.');
  }
  const segments = alignedSegments.map((segment) => ({
    ...segment,
    words: segment.words.map((word) => ({ ...word })),
  }));
  const diagnostics: SpeakerRecoveryDiagnostics = {
    mode,
    eligibleRunCount: 0,
    recoveredRunCount: 0,
    recoveredSegmentCount: 0,
    recoveredWordCount: 0,
    rejectedByBoundsCount: 0,
    rejectedByNeighborCount: 0,
    rejectedBySourceBoundaryCount: 0,
    mergedReliableClusterCount: 0,
    recoveredFilteredClusterCount: 0,
    remappedSegmentCount: 0,
    remappedDurationMs: 0,
    remappedWordCount: 0,
    promotedNovelClusterCount: 0,
    promotedNovelWordCount: 0,
    demotedClusterCount: 0,
    demotedWordCount: 0,
    finalAllowedClusterCount: 0,
    segmentGuardEvaluatedClusterCount: 0,
    segmentGuardInconsistentClusterCount: 0,
    segmentGuardRejectedReliableMergeCount: 0,
    segmentGuardRejectedFilteredMatchCount: 0,
  };
  if (
    mode === 'production' ||
    mode.startsWith('embedding-consolidation-') ||
    mode.startsWith('novel-speaker-')
  ) {
    return { segments, diagnostics };
  }

  const limits = recoveryLimits(mode as FilteredBridgeRecoveryMode);
  const rawSummary = summarizeRawDiarization(diarization, whisper.words);
  const supportedClusters = new Set(
    rawSummary.clusters
      .filter((cluster) => cluster.supported)
      .map((cluster) => cluster.cluster),
  );
  const wordIndexes = alignedWordIndexesBySegment(whisper, segments);
  const evidence = wordIndexes.map((indexes) => recoverySegmentEvidence(
    whisper,
    diarization,
    supportedClusters,
    indexes,
  ));

  for (let runStart = 0; runStart < segments.length;) {
    if (segments[runStart].speakerId !== null) {
      runStart += 1;
      continue;
    }
    let runEnd = runStart + 1;
    while (runEnd < segments.length && segments[runEnd].speakerId === null) {
      runEnd += 1;
    }
    const runEvidence = evidence.slice(runStart, runEnd);
    if (
      runEvidence.length === 0 ||
      runEvidence.some((entry) => entry.kind !== 'filtered')
    ) {
      runStart = runEnd;
      continue;
    }
    diagnostics.eligibleRunCount += 1;
    const lexicalWordCount = runEvidence.reduce(
      (total, entry) => total + entry.lexicalWordCount,
      0,
    );
    const runDurationMs =
      segments[runEnd - 1].endMs - segments[runStart].startMs;
    const textCharacters = segments
      .slice(runStart, runEnd)
      .reduce((total, segment) => total + segment.text.length, 0);
    if (
      lexicalWordCount > limits.maximumLexicalWords ||
      runDurationMs > limits.maximumRunDurationMs ||
      textCharacters > limits.maximumTextCharacters
    ) {
      diagnostics.rejectedByBoundsCount += 1;
      runStart = runEnd;
      continue;
    }

    const left = segments[runStart - 1];
    const right = segments[runEnd];
    const leftEvidence = evidence[runStart - 1];
    const rightEvidence = evidence[runEnd];
    const leftGapMs = left
      ? Math.max(0, segments[runStart].startMs - left.endMs)
      : Number.POSITIVE_INFINITY;
    const rightGapMs = right
      ? Math.max(0, right.startMs - segments[runEnd - 1].endMs)
      : Number.POSITIVE_INFINITY;
    if (
      !left?.speakerId ||
      !right?.speakerId ||
      left.speakerId !== right.speakerId ||
      !leftEvidence?.stable ||
      !rightEvidence?.stable ||
      leftGapMs > limits.maximumNeighborGapMs ||
      rightGapMs > limits.maximumNeighborGapMs
    ) {
      diagnostics.rejectedByNeighborCount += 1;
      runStart = runEnd;
      continue;
    }
    const sourceSegmentIndexes = new Set([
      leftEvidence.sourceSegmentIndex,
      ...runEvidence.map((entry) => entry.sourceSegmentIndex),
      rightEvidence.sourceSegmentIndex,
    ]);
    if (sourceSegmentIndexes.size !== 1 || sourceSegmentIndexes.has(null)) {
      diagnostics.rejectedBySourceBoundaryCount += 1;
      runStart = runEnd;
      continue;
    }

    for (let index = runStart; index < runEnd; index += 1) {
      segments[index].speakerId = left.speakerId;
    }
    diagnostics.recoveredRunCount += 1;
    diagnostics.recoveredSegmentCount += runEnd - runStart;
    diagnostics.recoveredWordCount += lexicalWordCount;
    runStart = runEnd;
  }
  return { segments, diagnostics };
};

const referenceSpeakerForWord = (
  word: WhisperWord,
  wordIndex: number,
  annotation: SpeakerAnnotation,
  explicitWords: ReadonlyMap<number, string>,
): string | null => {
  const explicit = explicitWords.get(wordIndex);
  if (explicit) return explicit;
  const scores = annotation.ranges.flatMap((range) => {
    const supportMs = Math.max(
      0,
      Math.min(word.endMs, range.endMs) - Math.max(word.startMs, range.startMs),
    );
    if (supportMs > 0) return [{ speaker: range.speaker, supportMs }];
    if (
      word.startMs === word.endMs &&
      range.startMs <= word.startMs &&
      word.startMs <= range.endMs
    ) {
      return [{ speaker: range.speaker, supportMs: 1 }];
    }
    return [];
  }).sort(
    (left, right) =>
      right.supportMs - left.supportMs || left.speaker.localeCompare(right.speaker),
  );
  if (!scores[0] || (scores[1] && scores[0].supportMs === scores[1].supportMs)) {
    return null;
  }
  return scores[0].speaker;
};

interface MappingCandidate {
  score: number;
  mapping: Array<number | null>;
}

const betterMapping = (
  left: MappingCandidate | null,
  right: MappingCandidate,
): MappingCandidate => {
  if (!left || right.score > left.score) return right;
  if (right.score < left.score) return left;
  const leftKey = left.mapping.map((value) => value ?? 99).join(',');
  const rightKey = right.mapping.map((value) => value ?? 99).join(',');
  return rightKey < leftKey ? right : left;
};

const bestSpeakerMapping = (
  assignments: readonly WordAssignment[],
  systemSpeakers: readonly string[],
  referenceSpeakers: readonly string[],
): Record<string, string | null> => {
  const weights = systemSpeakers.map((systemSpeaker) =>
    referenceSpeakers.map((referenceSpeaker) =>
      assignments
        .filter(
          (assignment) =>
            assignment.systemSpeaker === systemSpeaker &&
            assignment.referenceSpeaker === referenceSpeaker,
        )
        .reduce(
          (total, assignment) => total + assignment.durationMs * 1_000 + 1,
          0,
        ),
    ),
  );
  const memo = new Map<string, MappingCandidate>();
  const search = (systemIndex: number, usedMask: number): MappingCandidate => {
    if (systemIndex === systemSpeakers.length) return { score: 0, mapping: [] };
    const key = `${systemIndex}:${usedMask}`;
    const cached = memo.get(key);
    if (cached) return cached;
    const unmatched = search(systemIndex + 1, usedMask);
    let best: MappingCandidate | null = {
      score: unmatched.score,
      mapping: [null, ...unmatched.mapping],
    };
    referenceSpeakers.forEach((_, referenceIndex) => {
      if ((usedMask & (1 << referenceIndex)) !== 0) return;
      const tail = search(systemIndex + 1, usedMask | (1 << referenceIndex));
      best = betterMapping(best, {
        score: weights[systemIndex][referenceIndex] + tail.score,
        mapping: [referenceIndex, ...tail.mapping],
      });
    });
    memo.set(key, best);
    return best;
  };
  const selected = search(0, 0).mapping;
  return Object.fromEntries(
    systemSpeakers.map((speaker, index) => [
      speaker,
      selected[index] === null ? null : referenceSpeakers[selected[index] as number],
    ]),
  );
};

const percentileMedian = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

const sequenceBoundaries = (
  assignments: readonly WordAssignment[],
  readSpeaker: (assignment: WordAssignment) => string | null,
): number[] => {
  const boundaries: number[] = [];
  for (let index = 1; index < assignments.length; index += 1) {
    const before = assignments[index - 1];
    const after = assignments[index];
    const beforeSpeaker = readSpeaker(before);
    const afterSpeaker = readSpeaker(after);
    if (beforeSpeaker && afterSpeaker && beforeSpeaker !== afterSpeaker) {
      boundaries.push(Math.round((before.endMs + after.startMs) / 2));
    }
  }
  return boundaries;
};

const scoreBoundaries = (
  assignments: readonly WordAssignment[],
  mapping: Readonly<Record<string, string | null>>,
): BoundaryMetrics => {
  const reference = sequenceBoundaries(
    assignments,
    (assignment) => assignment.referenceSpeaker,
  );
  const system = sequenceBoundaries(
    assignments,
    (assignment) =>
      assignment.systemSpeaker ? mapping[assignment.systemSpeaker] ?? null : null,
  );
  const remaining = new Set(system.map((_, index) => index));
  const errors: number[] = [];
  for (const boundary of reference) {
    const nearest = [...remaining]
      .map((index) => ({ index, error: Math.abs(system[index] - boundary) }))
      .sort((left, right) => left.error - right.error || left.index - right.index)[0];
    if (!nearest || nearest.error > BOUNDARY_MATCH_TOLERANCE_MS) continue;
    remaining.delete(nearest.index);
    errors.push(nearest.error);
  }
  return {
    matchingToleranceMs: BOUNDARY_MATCH_TOLERANCE_MS,
    referenceCount: reference.length,
    systemCount: system.length,
    matchedCount: errors.length,
    missedCount: reference.length - errors.length,
    extraCount: remaining.size,
    precision: system.length > 0 ? errors.length / system.length : null,
    recall: reference.length > 0 ? errors.length / reference.length : null,
    f1: reference.length > 0 && system.length > 0 && errors.length > 0
      ? (2 * errors.length) / (reference.length + system.length)
      : 0,
    meanAbsoluteErrorMs: errors.length > 0
      ? errors.reduce((total, value) => total + value, 0) / errors.length
      : null,
    medianAbsoluteErrorMs: percentileMedian(errors),
    maximumAbsoluteErrorMs: errors.length > 0 ? Math.max(...errors) : null,
  };
};

export const scoreSpeakerAccuracy = (
  whisper: NormalizedWhisperOutput,
  alignedSegments: readonly TranscriptSegment[],
  annotationValue: unknown,
): SpeakerAccuracyMetrics => {
  const annotation = parseSpeakerAnnotation(annotationValue, whisper.words.length);
  const explicitWords = new Map(
    annotation.words.map((word) => [word.wordIndex, word.speaker]),
  );
  const systemAssignments = systemSpeakerByWord(whisper, alignedSegments);
  const assignments = whisper.words.flatMap((word, index): WordAssignment[] => {
    if (!isLexicalWord(word)) return [];
    const referenceSpeaker = referenceSpeakerForWord(
      word,
      index,
      annotation,
      explicitWords,
    );
    return referenceSpeaker
      ? [{
          index,
          referenceSpeaker,
          systemSpeaker: systemAssignments[index],
          durationMs: Math.max(0, word.endMs - word.startMs),
          startMs: word.startMs,
          endMs: word.endMs,
        }]
      : [];
  });
  const systemSpeakers = [...new Set(
    systemAssignments.filter((speaker): speaker is string => speaker !== null),
  )];
  const mapping = bestSpeakerMapping(
    assignments,
    systemSpeakers,
    annotation.speakers,
  );
  let correctWordCount = 0;
  let correctDurationMs = 0;
  let wrongWordCount = 0;
  let wrongDurationMs = 0;
  let unclearWordCount = 0;
  let unclearDurationMs = 0;
  for (const assignment of assignments) {
    if (assignment.systemSpeaker === null) {
      unclearWordCount += 1;
      unclearDurationMs += assignment.durationMs;
    } else if (mapping[assignment.systemSpeaker] === assignment.referenceSpeaker) {
      correctWordCount += 1;
      correctDurationMs += assignment.durationMs;
    } else {
      wrongWordCount += 1;
      wrongDurationMs += assignment.durationMs;
    }
  }
  const annotatedWordCount = assignments.length;
  const annotatedDurationMs = assignments.reduce(
    (total, assignment) => total + assignment.durationMs,
    0,
  );
  const associationsByReference = new Map<string, Set<string>>();
  const associationsBySystem = new Map<string, Set<string>>();
  assignments.forEach((assignment) => {
    if (!assignment.systemSpeaker) return;
    const byReference = associationsByReference.get(assignment.referenceSpeaker) ?? new Set();
    byReference.add(assignment.systemSpeaker);
    associationsByReference.set(assignment.referenceSpeaker, byReference);
    const bySystem = associationsBySystem.get(assignment.systemSpeaker) ?? new Set();
    bySystem.add(assignment.referenceSpeaker);
    associationsBySystem.set(assignment.systemSpeaker, bySystem);
  });
  const fragmentationCount = [...associationsByReference.values()].reduce(
    (total, systems) => total + Math.max(0, systems.size - 1),
    0,
  );
  const mergingCount = [...associationsBySystem.values()].reduce(
    (total, references) => total + Math.max(0, references.size - 1),
    0,
  );
  const perSpeaker = annotation.speakers.map((speaker): SpeakerReferenceMetrics => {
    const speakerAssignments = assignments.filter(
      (assignment) => assignment.referenceSpeaker === speaker,
    );
    let speakerCorrectWordCount = 0;
    let speakerCorrectDurationMs = 0;
    let speakerWrongWordCount = 0;
    let speakerWrongDurationMs = 0;
    let speakerUnclearWordCount = 0;
    let speakerUnclearDurationMs = 0;
    for (const assignment of speakerAssignments) {
      if (assignment.systemSpeaker === null) {
        speakerUnclearWordCount += 1;
        speakerUnclearDurationMs += assignment.durationMs;
      } else if (mapping[assignment.systemSpeaker] === speaker) {
        speakerCorrectWordCount += 1;
        speakerCorrectDurationMs += assignment.durationMs;
      } else {
        speakerWrongWordCount += 1;
        speakerWrongDurationMs += assignment.durationMs;
      }
    }
    const speakerAnnotatedWordCount = speakerAssignments.length;
    const speakerAnnotatedDurationMs = speakerAssignments.reduce(
      (total, assignment) => total + assignment.durationMs,
      0,
    );
    return {
      speaker,
      annotatedWordCount: speakerAnnotatedWordCount,
      annotatedDurationMs: speakerAnnotatedDurationMs,
      correctWordCount: speakerCorrectWordCount,
      correctDurationMs: speakerCorrectDurationMs,
      wrongWordCount: speakerWrongWordCount,
      wrongDurationMs: speakerWrongDurationMs,
      unclearWordCount: speakerUnclearWordCount,
      unclearDurationMs: speakerUnclearDurationMs,
      correctWordRate: ratio(speakerCorrectWordCount, speakerAnnotatedWordCount),
      correctDurationRate: ratio(
        speakerCorrectDurationMs,
        speakerAnnotatedDurationMs,
      ),
      wrongWordRate: ratio(speakerWrongWordCount, speakerAnnotatedWordCount),
      wrongDurationRate: ratio(speakerWrongDurationMs, speakerAnnotatedDurationMs),
      unclearWordRate: ratio(speakerUnclearWordCount, speakerAnnotatedWordCount),
      unclearDurationRate: ratio(
        speakerUnclearDurationMs,
        speakerAnnotatedDurationMs,
      ),
      weightedWordLoss: ratio(
        speakerWrongWordCount * 2 + speakerUnclearWordCount,
        speakerAnnotatedWordCount,
      ),
      weightedDurationLoss: ratio(
        speakerWrongDurationMs * 2 + speakerUnclearDurationMs,
        speakerAnnotatedDurationMs,
      ),
    };
  });
  return {
    annotatedWordCount,
    annotatedDurationMs,
    correctWordCount,
    correctDurationMs,
    wrongWordCount,
    wrongDurationMs,
    unclearWordCount,
    unclearDurationMs,
    correctWordRate: ratio(correctWordCount, annotatedWordCount),
    correctDurationRate: ratio(correctDurationMs, annotatedDurationMs),
    wrongWordRate: ratio(wrongWordCount, annotatedWordCount),
    wrongDurationRate: ratio(wrongDurationMs, annotatedDurationMs),
    unclearWordRate: ratio(unclearWordCount, annotatedWordCount),
    unclearDurationRate: ratio(unclearDurationMs, annotatedDurationMs),
    labelWordCoverage: ratio(correctWordCount + wrongWordCount, annotatedWordCount),
    labelDurationCoverage: ratio(
      correctDurationMs + wrongDurationMs,
      annotatedDurationMs,
    ),
    weightedWordLoss: ratio(wrongWordCount * 2 + unclearWordCount, annotatedWordCount),
    weightedDurationLoss: ratio(
      wrongDurationMs * 2 + unclearDurationMs,
      annotatedDurationMs,
    ),
    balancedWeightedWordLoss: average(
      perSpeaker.map((speaker) => speaker.weightedWordLoss),
    ),
    balancedWeightedDurationLoss: average(
      perSpeaker.map((speaker) => speaker.weightedDurationLoss),
    ),
    macroCorrectWordRate: average(
      perSpeaker.map((speaker) => speaker.correctWordRate),
    ),
    macroCorrectDurationRate: average(
      perSpeaker.map((speaker) => speaker.correctDurationRate),
    ),
    minimumSpeakerCorrectWordRate: minimum(
      perSpeaker.map((speaker) => speaker.correctWordRate),
    ),
    minimumSpeakerCorrectDurationRate: minimum(
      perSpeaker.map((speaker) => speaker.correctDurationRate),
    ),
    wordTimedDiarizationErrorRate: ratio(
      wrongDurationMs + unclearDurationMs,
      annotatedDurationMs,
    ),
    referenceSpeakerCount: annotation.speakers.length,
    systemSpeakerCount: systemSpeakers.length,
    signedSpeakerCountError: systemSpeakers.length - annotation.speakers.length,
    absoluteSpeakerCountError: Math.abs(systemSpeakers.length - annotation.speakers.length),
    fragmentationCount,
    mergingCount,
    speakerMapping: mapping,
    perSpeaker,
    boundaries: scoreBoundaries(assignments, mapping),
  };
};
