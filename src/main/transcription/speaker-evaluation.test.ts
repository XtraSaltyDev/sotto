import { describe, expect, it } from 'vitest';

import type { TranscriptSegment } from './transcript-types';
import type { NormalizedWhisperOutput } from './whisper-output';
import {
  applyExperimentEmbeddingConsolidation,
  applyExperimentFilteredFragmentRecovery,
  applyExperimentNovelSpeakerPreservation,
  applyExperimentSegmentAnchorReassignment,
  buildFirstPackConfigurations,
  compareSpeakerAccuracyMetrics,
  parseSpeakerAnnotation,
  scoreSpeakerAccuracy,
  shiftDiarizationSegments,
  summarizeDiarizationChurn,
  summarizeRawDiarization,
  validateSpeakerEvaluationConfiguration,
} from './speaker-evaluation';

const whisper: NormalizedWhisperOutput = {
  durationMs: 4_000,
  language: 'en',
  text: 'alpha one bravo two',
  segments: [{ startMs: 0, endMs: 4_000, text: 'alpha one bravo two' }],
  words: [
    { startMs: 0, endMs: 800, text: 'alpha', segmentIndex: 0 },
    { startMs: 900, endMs: 1_700, text: ' one', segmentIndex: 0 },
    { startMs: 2_000, endMs: 2_800, text: ' bravo', segmentIndex: 0 },
    { startMs: 2_900, endMs: 3_700, text: ' two', segmentIndex: 0 },
  ],
};

const annotation = {
  schemaVersion: 1,
  durationMs: 4_000,
  speakers: ['Speaker A', 'Speaker B'],
  ranges: [
    { startMs: 0, endMs: 2_000, speaker: 'Speaker A' },
    { startMs: 2_000, endMs: 4_000, speaker: 'Speaker B' },
  ],
  words: [],
};

const aligned = (
  firstSpeaker: string | null,
  secondSpeaker: string | null,
): TranscriptSegment[] => [
  {
    startMs: 0,
    endMs: 1_700,
    text: 'alpha one',
    speakerId: firstSpeaker,
    words: whisper.words.slice(0, 2).map(({ startMs, endMs, text }) => ({
      startMs,
      endMs,
      text,
    })),
  },
  {
    startMs: 2_000,
    endMs: 3_700,
    text: 'bravo two',
    speakerId: secondSpeaker,
    words: whisper.words.slice(2).map(({ startMs, endMs, text }) => ({
      startMs,
      endMs,
      text,
    })),
  },
];

describe('speaker evaluation scoring', () => {
  it('matches anonymous speaker labels by the best permutation', () => {
    const metrics = scoreSpeakerAccuracy(
      whisper,
      aligned('system-two', 'system-one'),
      annotation,
    );

    expect(metrics.speakerMapping).toEqual({
      'system-two': 'Speaker A',
      'system-one': 'Speaker B',
    });
    expect(metrics.correctWordCount).toBe(4);
    expect(metrics.correctDurationRate).toBe(1);
    expect(metrics.wrongWordCount).toBe(0);
    expect(metrics.unclearWordCount).toBe(0);
    expect(metrics.balancedWeightedWordLoss).toBe(0);
    expect(metrics.minimumSpeakerCorrectWordRate).toBe(1);
    expect(metrics.perSpeaker.map((speaker) => speaker.correctWordRate)).toEqual([
      1,
      1,
    ]);
    expect(metrics.boundaries).toMatchObject({
      referenceCount: 1,
      systemCount: 1,
      precision: 1,
      recall: 1,
      f1: 1,
      meanAbsoluteErrorMs: 0,
    });
  });

  it('penalizes wrong labels twice as much as Unclear labels', () => {
    const wrong = scoreSpeakerAccuracy(
      whisper,
      aligned('same-system', 'same-system'),
      annotation,
    );
    const unclear = scoreSpeakerAccuracy(
      whisper,
      aligned('system-one', null),
      annotation,
    );

    expect(wrong.wrongWordCount).toBe(2);
    expect(wrong.weightedWordLoss).toBe(1);
    expect(wrong.balancedWeightedWordLoss).toBe(1);
    expect(wrong.minimumSpeakerCorrectWordRate).toBe(0);
    expect(wrong.perSpeaker.find((speaker) => speaker.speaker === 'Speaker B')).toMatchObject({
      correctWordCount: 0,
      wrongWordCount: 2,
      weightedWordLoss: 2,
    });
    expect(wrong.mergingCount).toBe(1);
    expect(unclear.unclearWordCount).toBe(2);
    expect(unclear.weightedWordLoss).toBe(0.5);
    expect(unclear.wordTimedDiarizationErrorRate).toBe(0.5);
  });

  it('does not count a distant speaker change as a boundary match', () => {
    const delayedBoundary = scoreSpeakerAccuracy(
      whisper,
      [
        {
          startMs: 0,
          endMs: 2_800,
          text: 'alpha one bravo',
          speakerId: 'system-one',
          words: whisper.words.slice(0, 3).map(({ startMs, endMs, text }) => ({
            startMs,
            endMs,
            text,
          })),
        },
        {
          startMs: 2_900,
          endMs: 3_700,
          text: 'two',
          speakerId: 'system-two',
          words: whisper.words.slice(3).map(({ startMs, endMs, text }) => ({
            startMs,
            endMs,
            text,
          })),
        },
      ],
      {
        ...annotation,
        ranges: [
          { startMs: 0, endMs: 900, speaker: 'Speaker A' },
          { startMs: 900, endMs: 4_000, speaker: 'Speaker B' },
        ],
      },
    );

    expect(delayedBoundary.boundaries).toMatchObject({
      matchingToleranceMs: 1_000,
      referenceCount: 1,
      systemCount: 1,
      matchedCount: 0,
      missedCount: 1,
      extraCount: 1,
      precision: 0,
      recall: 0,
      f1: 0,
      meanAbsoluteErrorMs: null,
    });
  });

  it('uses word assignments ahead of broader time ranges', () => {
    const metrics = scoreSpeakerAccuracy(
      whisper,
      aligned('system-one', 'system-two'),
      {
        ...annotation,
        words: [{ wordIndex: 0, speaker: 'Speaker B' }],
      },
    );

    expect(metrics.correctWordCount).toBe(3);
    expect(metrics.wrongWordCount).toBe(1);
  });

  it('returns byte-for-byte deterministic metrics', () => {
    const first = scoreSpeakerAccuracy(
      whisper,
      aligned('system-two', 'system-one'),
      annotation,
    );
    const second = scoreSpeakerAccuracy(
      whisper,
      aligned('system-two', 'system-one'),
      annotation,
    );

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe('speaker evaluation inputs and sweeps', () => {
  it('marks overall-versus-speaker-balanced tradeoffs as inconclusive', () => {
    const baseline = {
      weightedWordLoss: 0.3,
      weightedDurationLoss: 0.3,
      balancedWeightedWordLoss: 0.65,
      balancedWeightedDurationLoss: 0.65,
    };

    expect(compareSpeakerAccuracyMetrics({
      weightedWordLoss: 0.45,
      weightedDurationLoss: 0.45,
      balancedWeightedWordLoss: 0.6,
      balancedWeightedDurationLoss: 0.6,
    }, baseline)).toBe('inconclusive');
    expect(compareSpeakerAccuracyMetrics({
      weightedWordLoss: 0.2,
      weightedDurationLoss: 0.2,
      balancedWeightedWordLoss: 0.5,
      balancedWeightedDurationLoss: 0.5,
    }, baseline)).toBe('win');
    expect(compareSpeakerAccuracyMetrics({
      weightedWordLoss: 0.4,
      weightedDurationLoss: 0.4,
      balancedWeightedWordLoss: 0.7,
      balancedWeightedDurationLoss: 0.7,
    }, baseline)).toBe('regression');
  });

  it('builds the production baseline and one-factor experiment pack deterministically', () => {
    const first = buildFirstPackConfigurations(2);
    const second = buildFirstPackConfigurations(2);

    expect(first[0]).toEqual({
      name: 'baseline-production',
      clusteringThreshold: 0.75,
      diarizationShiftMs: 0,
      expectedSpeakerCount: null,
      recoveryMode: 'production',
      minDurationOn: 0.2,
      minDurationOff: 0.5,
      segmentAnchorOptions: {
        minimumInternalMedianSimilarity: 0.4,
        minimumSimilarity: 0.5,
        minimumMargin: 0.2,
        minimumSampleDurationMs: 500,
        maximumFlaggedSupportShare: 0.15,
      },
    });
    expect(first.map((entry) => entry.name)).toEqual([
      'baseline-production',
      'threshold-0.60',
      'threshold-0.675',
      'threshold-0.825',
      'threshold-0.90',
      'shift-minus-500ms',
      'shift-minus-250ms',
      'shift-plus-250ms',
      'duration-on-0.10-off-0.30',
      'duration-on-0.20-off-0.30',
      'duration-on-0.20-off-0.70',
      'duration-on-0.30-off-0.50',
      'fixed-speakers-2',
    ]);
    expect(first).toEqual(second);
  });

  it('rejects malformed annotations and out-of-bounds settings', () => {
    expect(() => parseSpeakerAnnotation({ schemaVersion: 2 })).toThrow(
      'schemaVersion 1',
    );
    expect(() => parseSpeakerAnnotation({
      ...annotation,
      ranges: [
        { startMs: 0, endMs: 2_500, speaker: 'Speaker A' },
        { startMs: 2_000, endMs: 4_000, speaker: 'Speaker B' },
      ],
    })).toThrow('cannot overlap');
    expect(() => validateSpeakerEvaluationConfiguration({
      name: 'bad-threshold',
      clusteringThreshold: 1.1,
      diarizationShiftMs: 0,
      expectedSpeakerCount: null,
      minDurationOn: 0.2,
      minDurationOff: 0.5,
    })).toThrow('0.5 to 1');
    expect(() => validateSpeakerEvaluationConfiguration({
      name: 'bad-recovery',
      clusteringThreshold: 0.75,
      diarizationShiftMs: 0,
      expectedSpeakerCount: null,
      recoveryMode: 'guess-everything',
      minDurationOn: 0.2,
      minDurationOff: 0.5,
    })).toThrow('supported local recovery');
    expect(validateSpeakerEvaluationConfiguration({
      name: 'guarded-recovery',
      clusteringThreshold: 0.75,
      diarizationShiftMs: 0,
      expectedSpeakerCount: null,
      recoveryMode: 'novel-speaker-balanced-segment-guard',
      minDurationOn: 0.2,
      minDurationOff: 0.5,
    }).recoveryMode).toBe('novel-speaker-balanced-segment-guard');
    expect(validateSpeakerEvaluationConfiguration({
      name: 'segment-reassignment',
      clusteringThreshold: 0.75,
      diarizationShiftMs: 0,
      expectedSpeakerCount: null,
      recoveryMode: 'novel-speaker-balanced-segment-reassignment',
      minDurationOn: 0.2,
      minDurationOff: 0.5,
    }).recoveryMode).toBe('novel-speaker-balanced-segment-reassignment');
    expect(validateSpeakerEvaluationConfiguration({
      name: 'relaxed-segment-reassignment',
      clusteringThreshold: 0.75,
      diarizationShiftMs: 0,
      expectedSpeakerCount: null,
      recoveryMode: 'novel-speaker-balanced-segment-reassignment',
      minDurationOn: 0.2,
      minDurationOff: 0.5,
      segmentAnchorOptions: {
        minimumSimilarity: 0.48,
        minimumSampleDurationMs: 250,
      },
    }).segmentAnchorOptions).toEqual({
      minimumInternalMedianSimilarity: 0.4,
      minimumSimilarity: 0.48,
      minimumMargin: 0.2,
      minimumSampleDurationMs: 250,
      maximumFlaggedSupportShare: 0.15,
    });
    expect(() => validateSpeakerEvaluationConfiguration({
      name: 'bad-support-share',
      clusteringThreshold: 0.75,
      diarizationShiftMs: 0,
      expectedSpeakerCount: null,
      recoveryMode: 'novel-speaker-balanced-segment-reassignment',
      minDurationOn: 0.2,
      minDurationOff: 0.5,
      segmentAnchorOptions: { maximumFlaggedSupportShare: 0 },
    })).toThrow('out of bounds');
    expect(() => validateSpeakerEvaluationConfiguration({
      name: 'bad-segment-reassignment',
      clusteringThreshold: 0.75,
      diarizationShiftMs: 0,
      expectedSpeakerCount: null,
      recoveryMode: 'novel-speaker-balanced-segment-reassignment',
      minDurationOn: 0.2,
      minDurationOff: 0.5,
      segmentAnchorOptions: { minimumSampleDurationMs: 0 },
    })).toThrow('minimumSampleDurationMs');
    expect(() => buildFirstPackConfigurations(13)).toThrow('1 to 12');
  });

  it('bounds time shifts and clips segments that move before zero', () => {
    expect(shiftDiarizationSegments(
      [{ startMs: 100, endMs: 400, cluster: 1 }],
      -250,
    )).toEqual([{ startMs: 0, endMs: 150, cluster: 1 }]);
    expect(shiftDiarizationSegments(
      [{ startMs: 100, endMs: 200, cluster: 1 }],
      -500,
    )).toEqual([]);
    expect(() => shiftDiarizationSegments([], 2_001)).toThrow('-2000 to 2000');
  });

  it('reports raw and supported cluster diagnostics before filtering', () => {
    const summary = summarizeRawDiarization(
      [
        { startMs: 0, endMs: 1_700, cluster: 7 },
        { startMs: 2_000, endMs: 3_700, cluster: 2 },
        { startMs: 1_800, endMs: 1_850, cluster: 99 },
      ],
      whisper.words,
    );

    expect(summary.rawClusterCount).toBe(3);
    expect(summary.supportedClusterCount).toBe(2);
    expect(summary.clusters.find((cluster) => cluster.cluster === 99)).toEqual({
      cluster: 99,
      segmentCount: 1,
      segmentDurationMs: 50,
      wordCount: 0,
      wordSupportMs: 0,
      supported: false,
    });
  });

  it('reports deterministic raw cluster switches and ten-second window churn', () => {
    const summary = summarizeDiarizationChurn([
      { startMs: 0, endMs: 1_000, cluster: 0 },
      { startMs: 1_000, endMs: 2_000, cluster: 1 },
      { startMs: 2_000, endMs: 3_000, cluster: 0 },
      { startMs: 9_000, endMs: 11_000, cluster: 2 },
      { startMs: 11_000, endMs: 12_000, cluster: 2 },
      { startMs: 20_000, endMs: 21_000, cluster: 3 },
      { startMs: 23_000, endMs: 24_000, cluster: 3 },
    ], 25_000);

    expect(summary).toEqual({
      windowSizeMs: 10_000,
      segmentCount: 7,
      clusterSwitchCount: 4,
      clusterSwitchRate: 4 / 6,
      totalWindowCount: 3,
      activeWindowCount: 3,
      windowsWithTwoOrMoreClusters: 1,
      windowsWithThreeOrMoreClusters: 1,
      windowsWithThreeOrMoreClusterRate: 1 / 3,
      maximumDistinctClustersPerWindow: 3,
      meanDistinctClustersPerActiveWindow: 5 / 3,
    });
  });

  it('returns empty churn metrics when no diarization spans are present', () => {
    expect(summarizeDiarizationChurn([], 0)).toEqual({
      windowSizeMs: 10_000,
      segmentCount: 0,
      clusterSwitchCount: 0,
      clusterSwitchRate: null,
      totalWindowCount: 0,
      activeWindowCount: 0,
      windowsWithTwoOrMoreClusters: 0,
      windowsWithThreeOrMoreClusters: 0,
      windowsWithThreeOrMoreClusterRate: null,
      maximumDistinctClustersPerWindow: 0,
      meanDistinctClustersPerActiveWindow: null,
    });
  });
});

const recoveryWhisper: NormalizedWhisperOutput = {
  durationMs: 1_000,
  language: 'en',
  text: 'before tiny one after',
  segments: [{ startMs: 0, endMs: 1_000, text: 'before tiny one after' }],
  words: [
    { startMs: 0, endMs: 400, text: 'before', segmentIndex: 0 },
    { startMs: 400, endMs: 500, text: ' tiny', segmentIndex: 0 },
    { startMs: 500, endMs: 600, text: ' one', segmentIndex: 0 },
    { startMs: 600, endMs: 1_000, text: ' after', segmentIndex: 0 },
  ],
};

const recoveryAligned = (
  rightSpeaker = 'speaker-a',
): TranscriptSegment[] => recoveryWhisper.words.map((word, index) => ({
  startMs: word.startMs,
  endMs: word.endMs,
  text: word.text.trim(),
  speakerId: index === 1 || index === 2
    ? null
    : index === 3
      ? rightSpeaker
      : 'speaker-a',
  words: [{ startMs: word.startMs, endMs: word.endMs, text: word.text }],
}));

const recoveryDiarization = [
  { startMs: 0, endMs: 400, cluster: 0 },
  { startMs: 400, endMs: 500, cluster: 98 },
  { startMs: 500, endMs: 600, cluster: 99 },
  { startMs: 600, endMs: 1_000, cluster: 0 },
];

describe('experiment-only filtered-fragment recovery', () => {
  it('recovers a bounded two-word filtered run only in the matching policy', () => {
    const production = applyExperimentFilteredFragmentRecovery(
      recoveryWhisper,
      recoveryDiarization,
      recoveryAligned(),
      'production',
    );
    const oneWord = applyExperimentFilteredFragmentRecovery(
      recoveryWhisper,
      recoveryDiarization,
      recoveryAligned(),
      'filtered-bridge-one-word',
    );
    const twoWords = applyExperimentFilteredFragmentRecovery(
      recoveryWhisper,
      recoveryDiarization,
      recoveryAligned(),
      'filtered-bridge-two-words',
    );

    expect(production.segments.map((segment) => segment.speakerId)).toEqual([
      'speaker-a', null, null, 'speaker-a',
    ]);
    expect(oneWord.diagnostics).toMatchObject({
      eligibleRunCount: 1,
      recoveredWordCount: 0,
      rejectedByBoundsCount: 1,
    });
    expect(twoWords.segments.every((segment) => segment.speakerId === 'speaker-a')).toBe(
      true,
    );
    expect(twoWords.diagnostics).toMatchObject({
      eligibleRunCount: 1,
      recoveredRunCount: 1,
      recoveredSegmentCount: 2,
      recoveredWordCount: 2,
    });
  });

  it('keeps conflicting, timing-gap, and overlapping evidence Unclear', () => {
    const conflicting = applyExperimentFilteredFragmentRecovery(
      recoveryWhisper,
      recoveryDiarization,
      recoveryAligned('speaker-b'),
      'filtered-bridge-three-words',
    );
    const timingGap = applyExperimentFilteredFragmentRecovery(
      recoveryWhisper,
      recoveryDiarization.filter((span) => span.cluster === 0),
      recoveryAligned(),
      'filtered-bridge-three-words',
    );
    const overlap = applyExperimentFilteredFragmentRecovery(
      recoveryWhisper,
      [
        ...recoveryDiarization,
        { startMs: 400, endMs: 600, cluster: 97 },
      ],
      recoveryAligned(),
      'filtered-bridge-three-words',
    );

    expect(conflicting.diagnostics).toMatchObject({
      recoveredWordCount: 0,
      rejectedByNeighborCount: 1,
    });
    expect(timingGap.diagnostics.recoveredWordCount).toBe(0);
    expect(overlap.diagnostics.recoveredWordCount).toBe(0);
    expect(conflicting.segments[1].speakerId).toBeNull();
    expect(timingGap.segments[1].speakerId).toBeNull();
    expect(overlap.segments[1].speakerId).toBeNull();
  });

  it('does not cross a Whisper source-segment boundary and is deterministic', () => {
    const splitWhisper: NormalizedWhisperOutput = {
      ...recoveryWhisper,
      segments: [
        { startMs: 0, endMs: 600, text: 'before tiny one' },
        { startMs: 600, endMs: 1_000, text: 'after' },
      ],
      words: recoveryWhisper.words.map((word, index) => ({
        ...word,
        segmentIndex: index === 3 ? 1 : 0,
      })),
    };
    const first = applyExperimentFilteredFragmentRecovery(
      splitWhisper,
      recoveryDiarization,
      recoveryAligned(),
      'filtered-bridge-two-words',
    );
    const second = applyExperimentFilteredFragmentRecovery(
      splitWhisper,
      recoveryDiarization,
      recoveryAligned(),
      'filtered-bridge-two-words',
    );

    expect(first.diagnostics).toMatchObject({
      recoveredWordCount: 0,
      rejectedBySourceBoundaryCount: 1,
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe('experiment-only embedding consolidation', () => {
  const rawSummary = {
    rawClusterCount: 3,
    rawSegmentCount: 3,
    supportedClusterCount: 2,
    minimumReliableSupportMs: 200,
    clusters: [
      {
        cluster: 0,
        segmentCount: 1,
        segmentDurationMs: 1_000,
        wordCount: 4,
        wordSupportMs: 900,
        supported: true,
      },
      {
        cluster: 1,
        segmentCount: 1,
        segmentDurationMs: 900,
        wordCount: 3,
        wordSupportMs: 700,
        supported: true,
      },
      {
        cluster: 2,
        segmentCount: 1,
        segmentDurationMs: 800,
        wordCount: 2,
        wordSupportMs: 500,
        supported: false,
      },
    ],
  };
  const analysis = {
    supportedSimilarities: [
      { leftCluster: 0, rightCluster: 1, similarity: 0.8 },
    ],
    matches: [
      {
        cluster: 2,
        sampleDurationMs: 1_000,
        ready: true,
        nearestSupportedCluster: 1,
        similarity: 0.75,
        secondSimilarity: 0.6,
        margin: 0.15,
      },
    ],
  };

  it('maps reliable duplicates and a confident filtered cluster to one canonical cluster', () => {
    const result = applyExperimentEmbeddingConsolidation(
      [
        { startMs: 0, endMs: 1_000, cluster: 0 },
        { startMs: 1_000, endMs: 1_900, cluster: 1 },
        { startMs: 1_900, endMs: 2_700, cluster: 2 },
      ],
      rawSummary,
      analysis,
      'embedding-consolidation-strict',
    );

    expect(result.segments.map((segment) => segment.cluster)).toEqual([0, 0, 0]);
    expect(result.diagnostics).toMatchObject({
      mergedReliableClusterCount: 1,
      recoveredFilteredClusterCount: 1,
      remappedSegmentCount: 2,
      remappedDurationMs: 1_700,
      remappedWordCount: 5,
    });
  });

  it('rejects weak or malformed similarity evidence deterministically', () => {
    const weak = applyExperimentEmbeddingConsolidation(
      [{ startMs: 0, endMs: 800, cluster: 2 }],
      rawSummary,
      {
        supportedSimilarities: [
          { leftCluster: 0, rightCluster: 1, similarity: 0.5 },
        ],
        matches: [{ ...analysis.matches[0], similarity: 0.55 }],
      },
      'embedding-consolidation-exploratory',
    );
    expect(weak.segments[0].cluster).toBe(2);
    expect(weak.diagnostics.recoveredFilteredClusterCount).toBe(0);
    expect(() => applyExperimentEmbeddingConsolidation(
      [],
      rawSummary,
      {
        ...analysis,
        supportedSimilarities: [
          { leftCluster: 0, rightCluster: 999, similarity: 0.9 },
        ],
      },
      'embedding-consolidation-strict',
    )).toThrow('invalid reliable-cluster pair');
  });

  it('blocks cluster-wide merges and filtered remaps for an inconsistent voice group', () => {
    const guardedAnalysis = {
      ...analysis,
      segmentConsistency: [
        {
          cluster: 0,
          totalSegmentCount: 2,
          selectedSegmentCount: 2,
          readySegmentCount: 2,
          skippedSegmentCount: 0,
          pairCount: 1,
          minimumSimilarity: 0.8,
          medianSimilarity: 0.8,
          maximumSimilarity: 0.8,
        },
        {
          cluster: 1,
          totalSegmentCount: 2,
          selectedSegmentCount: 2,
          readySegmentCount: 2,
          skippedSegmentCount: 0,
          pairCount: 1,
          minimumSimilarity: 0.2,
          medianSimilarity: 0.2,
          maximumSimilarity: 0.2,
        },
      ],
    };
    const diarization = [
      { startMs: 0, endMs: 1_000, cluster: 0 },
      { startMs: 1_000, endMs: 1_900, cluster: 1 },
      { startMs: 1_900, endMs: 2_700, cluster: 2 },
    ];
    const first = applyExperimentEmbeddingConsolidation(
      diarization,
      rawSummary,
      guardedAnalysis,
      'embedding-consolidation-strict',
      { minimumInternalMedianSimilarity: 0.4 },
    );
    const second = applyExperimentEmbeddingConsolidation(
      diarization,
      rawSummary,
      guardedAnalysis,
      'embedding-consolidation-strict',
      { minimumInternalMedianSimilarity: 0.4 },
    );

    expect(first.segments.map((segment) => segment.cluster)).toEqual([0, 1, 2]);
    expect(first.diagnostics).toMatchObject({
      mergedReliableClusterCount: 0,
      recoveredFilteredClusterCount: 0,
      segmentGuardEvaluatedClusterCount: 2,
      segmentGuardInconsistentClusterCount: 1,
      segmentGuardRejectedReliableMergeCount: 1,
      segmentGuardRejectedFilteredMatchCount: 1,
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('rejects incomplete segment consistency and out-of-bounds guard settings', () => {
    const partialConsistency = {
      cluster: 0,
      totalSegmentCount: 2,
      selectedSegmentCount: 2,
      readySegmentCount: 2,
      skippedSegmentCount: 0,
      pairCount: 1,
      minimumSimilarity: 0.8,
      medianSimilarity: 0.8,
      maximumSimilarity: 0.8,
    };

    expect(() => applyExperimentEmbeddingConsolidation(
      [],
      rawSummary,
      { ...analysis, segmentConsistency: [partialConsistency] },
      'embedding-consolidation-strict',
      { minimumInternalMedianSimilarity: 0.4 },
    )).toThrow('incomplete');
    expect(() => applyExperimentEmbeddingConsolidation(
      [],
      rawSummary,
      {
        ...analysis,
        segmentConsistency: [
          partialConsistency,
          { ...partialConsistency, cluster: 1 },
        ],
      },
      'embedding-consolidation-strict',
      { minimumInternalMedianSimilarity: 1.1 },
    )).toThrow('out of bounds');
  });

  it('reassigns only strong sampled segments from a mixed reliable cluster', () => {
    const segmentAnalysis = {
      ...analysis,
      segmentConsistency: [
        {
          cluster: 0,
          totalSegmentCount: 1,
          selectedSegmentCount: 1,
          readySegmentCount: 1,
          skippedSegmentCount: 0,
          pairCount: 0,
          minimumSimilarity: null,
          medianSimilarity: null,
          maximumSimilarity: null,
        },
        {
          cluster: 1,
          totalSegmentCount: 2,
          selectedSegmentCount: 2,
          readySegmentCount: 2,
          skippedSegmentCount: 0,
          pairCount: 1,
          minimumSimilarity: 0.2,
          medianSimilarity: 0.2,
          maximumSimilarity: 0.2,
        },
      ],
      segmentAnchorMatches: [
        {
          cluster: 1,
          startMs: 1_000,
          endMs: 1_900,
          sampleDurationMs: 900,
          ready: true,
          nearestOtherSupportedCluster: 0,
          similarity: 0.7,
          secondSimilarity: null,
          margin: null,
        },
        {
          cluster: 1,
          startMs: 1_900,
          endMs: 2_700,
          sampleDurationMs: 800,
          ready: true,
          nearestOtherSupportedCluster: 0,
          similarity: 0.65,
          secondSimilarity: 0.3,
          margin: 0.35,
        },
      ],
    };
    const diarization = [
      { startMs: 0, endMs: 1_000, cluster: 0 },
      { startMs: 1_000, endMs: 1_900, cluster: 1 },
      { startMs: 1_900, endMs: 2_700, cluster: 1 },
    ];
    const options = {
      minimumInternalMedianSimilarity: 0.4,
      minimumSimilarity: 0.6,
      minimumMargin: 0.2,
      minimumSampleDurationMs: 500,
      // The flagged fixture cluster carries 700 of 1600 supported ms; a
      // permissive cap keeps this test focused on the anchor gates.
      maximumFlaggedSupportShare: 0.5,
    };
    const first = applyExperimentSegmentAnchorReassignment(
      diarization,
      rawSummary,
      segmentAnalysis,
      new Map(),
      options,
    );
    const second = applyExperimentSegmentAnchorReassignment(
      diarization,
      rawSummary,
      segmentAnalysis,
      new Map(),
      options,
    );

    expect(first.segments).toEqual([
      { startMs: 0, endMs: 1_000, cluster: 0 },
      { startMs: 1_900, endMs: 2_700, cluster: 0 },
    ]);
    expect(first).toMatchObject({
      reassignedSegmentCount: 1,
      reassignedDurationMs: 800,
      demotedSegmentCount: 1,
      demotedDurationMs: 900,
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('leaves a flagged primary cluster untouched under the support-share cap', () => {
    const segmentAnalysis = {
      ...analysis,
      segmentConsistency: [
        {
          cluster: 0,
          totalSegmentCount: 1,
          selectedSegmentCount: 1,
          readySegmentCount: 1,
          skippedSegmentCount: 0,
          pairCount: 0,
          minimumSimilarity: null,
          medianSimilarity: null,
          maximumSimilarity: null,
        },
        {
          cluster: 1,
          totalSegmentCount: 2,
          selectedSegmentCount: 2,
          readySegmentCount: 2,
          skippedSegmentCount: 0,
          pairCount: 1,
          minimumSimilarity: 0.2,
          medianSimilarity: 0.2,
          maximumSimilarity: 0.2,
        },
      ],
      segmentAnchorMatches: [
        {
          cluster: 1,
          startMs: 1_000,
          endMs: 1_900,
          sampleDurationMs: 900,
          ready: true,
          nearestOtherSupportedCluster: 0,
          similarity: 0.7,
          secondSimilarity: 0.3,
          margin: 0.4,
        },
      ],
    };
    const diarization = [
      { startMs: 0, endMs: 1_000, cluster: 0 },
      { startMs: 1_000, endMs: 1_900, cluster: 1 },
    ];

    // Cluster 1 carries 700 of 1600 supported ms (~44%); the default cap
    // keeps every one of its segments in place, matching guard-only output.
    const result = applyExperimentSegmentAnchorReassignment(
      diarization,
      rawSummary,
      segmentAnalysis,
      new Map(),
      {
        minimumInternalMedianSimilarity: 0.4,
        minimumSimilarity: 0.5,
        minimumMargin: 0.2,
        minimumSampleDurationMs: 500,
        maximumFlaggedSupportShare: 0.15,
      },
    );

    expect(result.segments).toEqual(diarization);
    expect(result).toMatchObject({
      reassignedSegmentCount: 0,
      reassignedDurationMs: 0,
      demotedSegmentCount: 0,
      demotedDurationMs: 0,
    });
  });

  it('keeps a ready single-cluster segment when no other anchor exists', () => {
    const singleDiarization = [{ startMs: 0, endMs: 3_700, cluster: 0 }];
    const singleSummary = summarizeRawDiarization(singleDiarization, whisper.words);
    const result = applyExperimentSegmentAnchorReassignment(
      singleDiarization,
      singleSummary,
      {
        supportedSimilarities: [],
        matches: [],
        segmentConsistency: [{
          cluster: 0,
          totalSegmentCount: 1,
          selectedSegmentCount: 1,
          readySegmentCount: 1,
          skippedSegmentCount: 0,
          pairCount: 0,
          minimumSimilarity: null,
          medianSimilarity: null,
          maximumSimilarity: null,
        }],
        segmentAnchorMatches: [{
          cluster: 0,
          startMs: 0,
          endMs: 3_700,
          sampleDurationMs: 3_700,
          ready: true,
          nearestOtherSupportedCluster: null,
          similarity: null,
          secondSimilarity: null,
          margin: null,
        }],
      },
      new Map(),
      {
        minimumInternalMedianSimilarity: 0.4,
        minimumSimilarity: 0.5,
        minimumMargin: 0.2,
        minimumSampleDurationMs: 500,
        maximumFlaggedSupportShare: 0.15,
      },
    );

    expect(result).toMatchObject({
      segments: singleDiarization,
      reassignedSegmentCount: 0,
      demotedSegmentCount: 0,
    });
  });

  it('rejects incomplete or out-of-bounds segment-anchor evidence', () => {
    expect(() => applyExperimentSegmentAnchorReassignment(
      [],
      rawSummary,
      { ...analysis, segmentConsistency: [] },
      new Map(),
      {
        minimumInternalMedianSimilarity: 0.4,
        minimumSimilarity: 0.5,
        minimumMargin: 0.2,
        minimumSampleDurationMs: 500,
        maximumFlaggedSupportShare: 0.15,
      },
    )).toThrow('incomplete');
    expect(() => applyExperimentSegmentAnchorReassignment(
      [],
      rawSummary,
      { ...analysis, segmentConsistency: [] },
      new Map(),
      {
        minimumInternalMedianSimilarity: 0.4,
        minimumSimilarity: 1.1,
        minimumMargin: 0.2,
        minimumSampleDurationMs: 500,
        maximumFlaggedSupportShare: 0.15,
      },
    )).toThrow('out of bounds');
  });
});

describe('experiment-only novel-speaker preservation', () => {
  const emptyDiagnostics = {
    mode: 'embedding-consolidation-exploratory' as const,
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

  it('promotes direct novel evidence, demotes unreserved labels, and preserves overlap', () => {
    const localWhisper: NormalizedWhisperOutput = {
      durationMs: 1_600,
      language: 'en',
      text: 'anchor extra novel overlap',
      segments: [{ startMs: 0, endMs: 1_600, text: 'anchor extra novel overlap' }],
      words: [
        { startMs: 0, endMs: 400, text: 'anchor', segmentIndex: 0 },
        { startMs: 400, endMs: 800, text: ' extra', segmentIndex: 0 },
        { startMs: 800, endMs: 1_200, text: ' novel', segmentIndex: 0 },
        { startMs: 1_200, endMs: 1_600, text: ' overlap', segmentIndex: 0 },
      ],
    };
    const diarization = [
      { startMs: 0, endMs: 400, cluster: 0 },
      { startMs: 400, endMs: 800, cluster: 1 },
      { startMs: 800, endMs: 1_200, cluster: 2 },
      { startMs: 1_200, endMs: 1_600, cluster: 2 },
      { startMs: 1_200, endMs: 1_600, cluster: 3 },
    ];
    const alignedSegments = localWhisper.words.map((word, index) => ({
      startMs: word.startMs,
      endMs: word.endMs,
      text: word.text.trim(),
      speakerId: index === 0
        ? 'speaker-anchor'
        : index === 1
          ? 'speaker-unreserved'
          : null,
      words: [{ startMs: word.startMs, endMs: word.endMs, text: word.text }],
    }));
    const rawSummary = {
      rawClusterCount: 4,
      rawSegmentCount: 5,
      supportedClusterCount: 1,
      minimumReliableSupportMs: 200,
      clusters: [
        { cluster: 0, segmentCount: 1, segmentDurationMs: 400, wordCount: 1, wordSupportMs: 400, supported: true },
        { cluster: 1, segmentCount: 1, segmentDurationMs: 400, wordCount: 1, wordSupportMs: 1_200, supported: false },
        { cluster: 2, segmentCount: 2, segmentDurationMs: 800, wordCount: 1, wordSupportMs: 800, supported: false },
        { cluster: 3, segmentCount: 1, segmentDurationMs: 400, wordCount: 0, wordSupportMs: 0, supported: false },
      ],
    };
    const analysis = {
      supportedSimilarities: [],
      matches: [
        { cluster: 1, sampleDurationMs: 1_200, ready: true, nearestSupportedCluster: 0, similarity: 0.7, secondSimilarity: null, margin: null },
        { cluster: 2, sampleDurationMs: 800, ready: true, nearestSupportedCluster: 0, similarity: 0.3, secondSimilarity: null, margin: null },
        { cluster: 3, sampleDurationMs: 400, ready: true, nearestSupportedCluster: 0, similarity: 0.2, secondSimilarity: null, margin: null },
      ],
    };

    const result = applyExperimentNovelSpeakerPreservation(
      localWhisper,
      diarization,
      alignedSegments,
      rawSummary,
      analysis,
      [0],
      emptyDiagnostics,
      'novel-speaker-balanced',
    );

    expect(result.segments.map((segment) => segment.speakerId)).toEqual([
      'speaker-anchor',
      null,
      'experiment-novel-cluster-2',
      null,
    ]);
    expect(result.diagnostics).toMatchObject({
      promotedNovelClusterCount: 1,
      promotedNovelWordCount: 1,
      demotedClusterCount: 1,
      demotedWordCount: 1,
      finalAllowedClusterCount: 2,
    });
  });

  it('caps canonical and novel clusters at 12 labels deterministically', () => {
    const supported = [0, 1, 2, 3];
    const novel = Array.from({ length: 20 }, (_, index) => index + 4);
    const rawSummary = {
      rawClusterCount: 24,
      rawSegmentCount: 0,
      supportedClusterCount: 4,
      minimumReliableSupportMs: 200,
      clusters: [
        ...supported.map((cluster) => ({
          cluster,
          segmentCount: 1,
          segmentDurationMs: 1_000,
          wordCount: 10,
          wordSupportMs: 2_000,
          supported: true,
        })),
        ...novel.map((cluster) => ({
          cluster,
          segmentCount: 1,
          segmentDurationMs: 1_000,
          wordCount: 5,
          wordSupportMs: 1_000 + cluster,
          supported: false,
        })),
      ],
    };
    const analysis = {
      supportedSimilarities: [],
      matches: novel.map((cluster) => ({
        cluster,
        sampleDurationMs: 1_000,
        ready: true,
        nearestSupportedCluster: 0,
        similarity: 0.2,
        secondSimilarity: 0.1,
        margin: 0.1,
      })),
    };
    const first = applyExperimentNovelSpeakerPreservation(
      recoveryWhisper,
      [],
      [],
      rawSummary,
      analysis,
      supported,
      emptyDiagnostics,
      'novel-speaker-exploratory',
    );
    const second = applyExperimentNovelSpeakerPreservation(
      recoveryWhisper,
      [],
      [],
      rawSummary,
      analysis,
      supported,
      emptyDiagnostics,
      'novel-speaker-exploratory',
    );

    expect(first.diagnostics.promotedNovelClusterCount).toBe(8);
    expect(first.diagnostics.finalAllowedClusterCount).toBe(12);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
