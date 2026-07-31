import { describe, expect, it } from 'vitest';

import { parseClusterSimilarityRun } from './speaker-evaluation-cli';

describe('cluster similarity experiment parsing', () => {
  it('accepts a ready segment when no other supported cluster exists', () => {
    const run = parseClusterSimilarityRun({
      schemaVersion: 1,
      outcome: 'completed',
      embeddingDimension: 512,
      maximumSecondsPerCluster: 10,
      maximumSegmentsPerCluster: 6,
      maximumSecondsPerSegment: 4,
      embeddedClusterCount: 1,
      skippedClusterCount: 0,
      embeddedSegmentCount: 1,
      skippedSegmentEmbeddingCount: 0,
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
        endMs: 300,
        sampleDurationMs: 300,
        ready: true,
        nearestOtherSupportedCluster: null,
        similarity: null,
        secondSimilarity: null,
        margin: null,
      }],
      resources: {
        wallTimeMs: 1,
        userCpuMs: 1,
        systemCpuMs: 0,
        peakRssBytes: 1,
        voluntaryContextSwitches: 0,
        involuntaryContextSwitches: 0,
        threadSetting: 2,
      },
      outputBytes: 1,
    });

    expect(run.segmentAnchorMatches).toEqual([{
      cluster: 0,
      startMs: 0,
      endMs: 300,
      sampleDurationMs: 300,
      ready: true,
      nearestOtherSupportedCluster: null,
      similarity: null,
      secondSimilarity: null,
      margin: null,
    }]);
  });
});
