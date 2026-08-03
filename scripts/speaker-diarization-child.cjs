'use strict';

const path = require('node:path');

const PROTOCOL_VERSION = 1;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MIN_EXPECTED_SPEAKERS = 1;
const MAX_EXPECTED_SPEAKERS = 12;
const MAX_CONSISTENCY_CLUSTERS = 24;
const MAX_CONSISTENCY_SEGMENTS_PER_CLUSTER = 6;
const MAX_CONSISTENCY_SECONDS_PER_SEGMENT = 4;

const cosineSimilarity = (left, right) => {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return leftNorm > 0 && rightNorm > 0
    ? dot / Math.sqrt(leftNorm * rightNorm)
    : Number.NEGATIVE_INFINITY;
};

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

// Aggregate per-cluster internal-consistency statistics: the longest
// segments of each cluster (bounded per segment and per cluster) compared
// pairwise by cosine similarity of their voice embeddings. Only these
// aggregate numbers ever leave this process — the embeddings themselves
// are discarded here. Diagnostic-only by design: callers treat a missing
// field as "not measured", so any failure is swallowed by the caller.
const computeSegmentConsistency = (sherpa, wave, segments, embeddingModelPath) => {
  const byCluster = new Map();
  for (const segment of segments) {
    const spans = byCluster.get(segment.speaker);
    if (spans) spans.push(segment);
    else byCluster.set(segment.speaker, [segment]);
  }
  if (byCluster.size < 2 || byCluster.size > MAX_CONSISTENCY_CLUSTERS) {
    return undefined;
  }
  const extractor = new sherpa.SpeakerEmbeddingExtractor({
    model: embeddingModelPath,
    numThreads: 2,
    debug: 0,
    provider: 'cpu',
  });
  const results = [];
  for (const [cluster, spans] of [...byCluster.entries()].sort((a, b) => a[0] - b[0])) {
    const selected = [...spans]
      .sort((left, right) =>
        (right.end - right.start) - (left.end - left.start) ||
        left.start - right.start)
      .slice(0, MAX_CONSISTENCY_SEGMENTS_PER_CLUSTER);
    const embeddings = [];
    let skipped = 0;
    for (const span of selected) {
      const startSample = Math.max(0, Math.floor(span.start * wave.sampleRate));
      const endSample = Math.min(
        wave.samples.length,
        Math.ceil(span.end * wave.sampleRate),
        startSample +
          Math.floor(wave.sampleRate * MAX_CONSISTENCY_SECONDS_PER_SEGMENT),
      );
      const samples = wave.samples.slice(startSample, Math.max(startSample, endSample));
      const stream = extractor.createStream();
      stream.acceptWaveform({ sampleRate: wave.sampleRate, samples });
      stream.inputFinished();
      if (extractor.isReady(stream)) {
        embeddings.push(extractor.compute(stream));
        // The embedding itself is intentionally short-lived; only the
        // pairwise similarity numbers below are retained.
      } else {
        skipped += 1;
      }
    }
    const similarities = [];
    for (let left = 0; left < embeddings.length; left += 1) {
      for (let right = left + 1; right < embeddings.length; right += 1) {
        similarities.push(cosineSimilarity(embeddings[left], embeddings[right]));
      }
    }
    results.push({
      cluster,
      totalSegmentCount: spans.length,
      selectedSegmentCount: selected.length,
      readySegmentCount: embeddings.length,
      skippedSegmentCount: skipped,
      pairCount: similarities.length,
      minimumSimilarity: similarities.length ? Math.min(...similarities) : null,
      medianSimilarity: median(similarities),
      maximumSimilarity: similarities.length ? Math.max(...similarities) : null,
    });
  }
  return results;
};
const utilityParentPort = process.parentPort;
const isUtilityProcess =
  utilityParentPort && typeof utilityParentPort.postMessage === 'function';

const fail = (message) => {
  const bounded =
    typeof message === 'string' && message
      ? message.replaceAll('\0', '').slice(0, 1_000)
      : 'Unknown error';
  const safeMessage = bounded || 'Unknown error';
  if (isUtilityProcess) {
    utilityParentPort.postMessage(
      JSON.stringify({
        schemaVersion: PROTOCOL_VERSION,
        outcome: 'failed',
        message: safeMessage,
      }),
    );
    return;
  }

  // An ordinary spawned Node process uses stderr and an explicit exit. The
  // Electron utility branch is instead killed by its parent after the message.
  process.stderr.write(`${safeMessage}\n`, () => process.exit(1));
};

try {
  const [
    modulePath,
    wavPath,
    segmentationModelPath,
    embeddingModelPath,
    expectedSpeakerCountArgument,
  ] =
    process.argv.slice(2);
  const paths = [modulePath, wavPath, segmentationModelPath, embeddingModelPath];
  if (paths.some((value) => typeof value !== 'string' || !path.isAbsolute(value))) {
    throw new Error('Speaker separation requires four absolute input paths.');
  }
  const expectedSpeakerCount =
    expectedSpeakerCountArgument === undefined
      ? -1
      : Number(expectedSpeakerCountArgument);
  if (
    expectedSpeakerCount !== -1 &&
    (!Number.isSafeInteger(expectedSpeakerCount) ||
      expectedSpeakerCount < MIN_EXPECTED_SPEAKERS ||
      expectedSpeakerCount > MAX_EXPECTED_SPEAKERS ||
      String(expectedSpeakerCount) !== expectedSpeakerCountArgument)
  ) {
    throw new Error('Expected speaker count must be an integer from 1 to 12.');
  }

  const sherpa = require(modulePath);
  const wave = sherpa.readWave(wavPath, false);
  const diarizer = new sherpa.OfflineSpeakerDiarization({
    segmentation: {
      pyannote: { model: segmentationModelPath },
      numThreads: 2,
      debug: 0,
      provider: 'cpu',
    },
    embedding: {
      model: embeddingModelPath,
      numThreads: 2,
      debug: 0,
      provider: 'cpu',
    },
    // A higher distance threshold merges more same-voice embeddings. The old
    // 0.5 default fragmented noisy meeting audio into dozens of tiny clusters.
    clustering: { numClusters: expectedSpeakerCount, threshold: 0.75 },
    minDurationOn: 0.2,
    minDurationOff: 0.5,
  });

  if (
    !wave ||
    wave.sampleRate !== diarizer.sampleRate ||
    !(wave.samples instanceof Float32Array)
  ) {
    throw new Error('The normalized WAV did not match the speaker model sample rate.');
  }

  const segments = diarizer.process(wave.samples);
  let segmentConsistency;
  try {
    segmentConsistency = computeSegmentConsistency(
      sherpa,
      wave,
      segments,
      embeddingModelPath,
    );
  } catch {
    // Consistency measurement is diagnostic only and must never cost a
    // transcript its speaker labels.
    segmentConsistency = undefined;
  }
  const json = JSON.stringify({
    schemaVersion: PROTOCOL_VERSION,
    outcome: 'completed',
    segments,
    ...(segmentConsistency ? { segmentConsistency } : {}),
  });
  if (Buffer.byteLength(json, 'utf8') > MAX_JSON_BYTES) {
    fail('The speaker engine output exceeded its size limit.');
  } else if (isUtilityProcess) {
    utilityParentPort.postMessage(json);
  } else {
    // Preserve explicit exits for the ordinary Node child used by tests.
    process.stdout.write(json, () => process.exit(0));
  }
} catch (error) {
  fail(error && typeof error.message === 'string' ? error.message : undefined);
}
