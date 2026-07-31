'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROTOCOL_VERSION = 1;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_CLUSTERS = 2_000;
const MAX_SECONDS_PER_CLUSTER = 30;
const MAX_SEGMENTS_PER_CLUSTER = 12;
const MAX_SECONDS_PER_SEGMENT = 10;

const fail = (message) => {
  const safe = typeof message === 'string' && message
    ? message.replaceAll('\0', '').slice(0, 1_000)
    : 'Unknown speaker-similarity experiment error';
  process.stderr.write(`${safe}\n`, () => process.exit(1));
};

const readJsonFile = (filePath) => {
  const stats = fs.statSync(filePath);
  if (!stats.isFile() || stats.size > MAX_INPUT_BYTES) {
    throw new Error('The diarization cache file is missing or too large.');
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
};

const parseConfiguration = (json) => {
  const value = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The similarity configuration must be an object.');
  }
  if (
    !Array.isArray(value.supportedClusters) ||
    value.supportedClusters.length === 0 ||
    value.supportedClusters.length > 12 ||
    value.supportedClusters.some((cluster) =>
      !Number.isSafeInteger(cluster) || cluster < 0 || cluster >= MAX_CLUSTERS)
  ) {
    throw new Error('Supported clusters must contain from 1 to 12 cluster IDs.');
  }
  const maximumSecondsPerCluster = value.maximumSecondsPerCluster ?? 10;
  if (
    typeof maximumSecondsPerCluster !== 'number' ||
    !Number.isFinite(maximumSecondsPerCluster) ||
    maximumSecondsPerCluster < 1 ||
    maximumSecondsPerCluster > MAX_SECONDS_PER_CLUSTER
  ) {
    throw new Error('maximumSecondsPerCluster must be from 1 to 30.');
  }
  const maximumSegmentsPerCluster = value.maximumSegmentsPerCluster ?? 6;
  if (
    !Number.isSafeInteger(maximumSegmentsPerCluster) ||
    maximumSegmentsPerCluster < 2 ||
    maximumSegmentsPerCluster > MAX_SEGMENTS_PER_CLUSTER
  ) {
    throw new Error('maximumSegmentsPerCluster must be from 2 to 12.');
  }
  const maximumSecondsPerSegment = value.maximumSecondsPerSegment ?? 4;
  if (
    typeof maximumSecondsPerSegment !== 'number' ||
    !Number.isFinite(maximumSecondsPerSegment) ||
    maximumSecondsPerSegment < 1 ||
    maximumSecondsPerSegment > MAX_SECONDS_PER_SEGMENT
  ) {
    throw new Error('maximumSecondsPerSegment must be from 1 to 10.');
  }
  return {
    maximumSecondsPerCluster,
    maximumSegmentsPerCluster,
    maximumSecondsPerSegment,
    supportedClusters: [...new Set(value.supportedClusters)],
  };
};

const parseSegments = (value, durationMs) => {
  if (!value || typeof value !== 'object' || !Array.isArray(value.segments)) {
    throw new Error('The diarization cache did not contain segments.');
  }
  return value.segments.map((segment, index) => {
    if (
      !segment ||
      typeof segment !== 'object' ||
      !Number.isSafeInteger(segment.startMs) ||
      !Number.isSafeInteger(segment.endMs) ||
      !Number.isSafeInteger(segment.cluster) ||
      segment.startMs < 0 ||
      segment.endMs <= segment.startMs ||
      segment.endMs > durationMs + 1_000 ||
      segment.cluster < 0 ||
      segment.cluster >= MAX_CLUSTERS
    ) {
      throw new Error(`Diarization segment ${index} was invalid.`);
    }
    return segment;
  });
};

const samplesForCluster = (wave, spans, maximumSeconds) => {
  const maximumSamples = Math.floor(wave.sampleRate * maximumSeconds);
  const chunks = [];
  let sampleCount = 0;
  for (const span of spans) {
    if (sampleCount >= maximumSamples) break;
    const start = Math.max(0, Math.floor(span.startMs * wave.sampleRate / 1_000));
    const end = Math.min(
      wave.samples.length,
      Math.ceil(span.endMs * wave.sampleRate / 1_000),
    );
    const take = Math.min(end - start, maximumSamples - sampleCount);
    if (take <= 0) continue;
    chunks.push(wave.samples.subarray(start, start + take));
    sampleCount += take;
  }
  const samples = new Float32Array(sampleCount);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  return samples;
};

const samplesForSpan = (wave, span, maximumSeconds) => {
  const maximumSamples = Math.floor(wave.sampleRate * maximumSeconds);
  const start = Math.max(0, Math.floor(span.startMs * wave.sampleRate / 1_000));
  const end = Math.min(
    wave.samples.length,
    Math.ceil(span.endMs * wave.sampleRate / 1_000),
    start + maximumSamples,
  );
  return wave.samples.slice(start, Math.max(start, end));
};

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

try {
  const [
    modulePath,
    wavPath,
    embeddingModelPath,
    diarizationCachePath,
    configJson,
  ] = process.argv.slice(2);
  const paths = [modulePath, wavPath, embeddingModelPath, diarizationCachePath];
  if (paths.some((value) => typeof value !== 'string' || !path.isAbsolute(value))) {
    throw new Error('The similarity experiment requires four absolute input paths.');
  }
  if (typeof configJson !== 'string') {
    throw new Error('The similarity experiment configuration is required.');
  }
  const config = parseConfiguration(configJson);
  const sherpa = require(modulePath);
  const wave = sherpa.readWave(wavPath, false);
  if (!wave || !(wave.samples instanceof Float32Array) || wave.sampleRate <= 0) {
    throw new Error('The normalized WAV could not be read.');
  }
  const segments = parseSegments(
    readJsonFile(diarizationCachePath),
    Math.ceil(wave.samples.length / wave.sampleRate * 1_000),
  );
  const byCluster = new Map();
  for (const segment of segments) {
    const spans = byCluster.get(segment.cluster);
    if (spans) spans.push(segment);
    else byCluster.set(segment.cluster, [segment]);
  }
  if (byCluster.size > MAX_CLUSTERS) {
    throw new Error('The similarity experiment exceeded its cluster limit.');
  }
  for (const cluster of config.supportedClusters) {
    if (!byCluster.has(cluster)) {
      throw new Error('A supported cluster was absent from the diarization cache.');
    }
  }

  const started = process.hrtime.bigint();
  const extractor = new sherpa.SpeakerEmbeddingExtractor({
    model: embeddingModelPath,
    numThreads: 2,
    debug: 0,
    provider: 'cpu',
  });
  const embeddings = new Map();
  const sampleDurationMs = new Map();
  for (const [cluster, spans] of [...byCluster.entries()].sort((a, b) => a[0] - b[0])) {
    const samples = samplesForCluster(
      wave,
      spans.sort((left, right) => left.startMs - right.startMs),
      config.maximumSecondsPerCluster,
    );
    sampleDurationMs.set(cluster, Math.round(samples.length / wave.sampleRate * 1_000));
    const stream = extractor.createStream();
    stream.acceptWaveform({ sampleRate: wave.sampleRate, samples });
    stream.inputFinished();
    if (extractor.isReady(stream)) {
      embeddings.set(cluster, extractor.compute(stream));
    }
  }
  const supported = config.supportedClusters.flatMap((cluster) => {
    const embedding = embeddings.get(cluster);
    return embedding ? [{ cluster, embedding }] : [];
  });
  if (supported.length !== config.supportedClusters.length) {
    throw new Error('At least one reliable cluster was too short for an embedding.');
  }
  const supportedSet = new Set(config.supportedClusters);
  const supportedSimilarities = supported.flatMap((left, leftIndex) =>
    supported.slice(leftIndex + 1).map((right) => ({
      leftCluster: left.cluster,
      rightCluster: right.cluster,
      similarity: cosineSimilarity(left.embedding, right.embedding),
    }))).sort((left, right) =>
    right.similarity - left.similarity ||
    left.leftCluster - right.leftCluster ||
    left.rightCluster - right.rightCluster);
  const matches = [...byCluster.keys()]
    .filter((cluster) => !supportedSet.has(cluster))
    .sort((left, right) => left - right)
    .map((cluster) => {
      const embedding = embeddings.get(cluster);
      if (!embedding) {
        return {
          cluster,
          sampleDurationMs: sampleDurationMs.get(cluster) ?? 0,
          ready: false,
          nearestSupportedCluster: null,
          similarity: null,
          secondSimilarity: null,
          margin: null,
        };
      }
      const ranked = supported
        .map((entry) => ({
          cluster: entry.cluster,
          similarity: cosineSimilarity(embedding, entry.embedding),
        }))
        .sort((left, right) =>
          right.similarity - left.similarity || left.cluster - right.cluster);
      return {
        cluster,
        sampleDurationMs: sampleDurationMs.get(cluster) ?? 0,
        ready: true,
        nearestSupportedCluster: ranked[0].cluster,
        similarity: ranked[0].similarity,
        secondSimilarity: ranked[1]?.similarity ?? null,
        margin: ranked[1] ? ranked[0].similarity - ranked[1].similarity : null,
      };
    });
  let embeddedSegmentCount = 0;
  let skippedSegmentEmbeddingCount = 0;
  const segmentAnchorMatches = [];
  const segmentConsistency = [...config.supportedClusters]
    .sort((left, right) => left - right)
    .map((cluster) => {
      const spans = [...byCluster.get(cluster)]
        .sort((left, right) =>
          (right.endMs - right.startMs) - (left.endMs - left.startMs) ||
          left.startMs - right.startMs)
        .slice(0, config.maximumSegmentsPerCluster);
      const segmentEmbeddings = [];
      for (const span of spans) {
        const samples = samplesForSpan(
          wave,
          span,
          config.maximumSecondsPerSegment,
        );
        const stream = extractor.createStream();
        stream.acceptWaveform({ sampleRate: wave.sampleRate, samples });
        stream.inputFinished();
        if (extractor.isReady(stream)) {
          const embedding = extractor.compute(stream);
          segmentEmbeddings.push({ span, samples, embedding });
          const ranked = supported
            .filter((entry) => entry.cluster !== cluster)
            .map((entry) => ({
              cluster: entry.cluster,
              similarity: cosineSimilarity(embedding, entry.embedding),
            }))
            .sort((left, right) =>
              right.similarity - left.similarity || left.cluster - right.cluster);
          segmentAnchorMatches.push({
            cluster,
            startMs: span.startMs,
            endMs: span.endMs,
            sampleDurationMs: Math.round(samples.length / wave.sampleRate * 1_000),
            ready: true,
            nearestOtherSupportedCluster: ranked[0]?.cluster ?? null,
            similarity: ranked[0]?.similarity ?? null,
            secondSimilarity: ranked[1]?.similarity ?? null,
            margin: ranked.length > 1
              ? ranked[0].similarity - ranked[1].similarity
              : null,
          });
          embeddedSegmentCount += 1;
        } else {
          skippedSegmentEmbeddingCount += 1;
          segmentAnchorMatches.push({
            cluster,
            startMs: span.startMs,
            endMs: span.endMs,
            sampleDurationMs: Math.round(samples.length / wave.sampleRate * 1_000),
            ready: false,
            nearestOtherSupportedCluster: null,
            similarity: null,
            secondSimilarity: null,
            margin: null,
          });
        }
      }
      const similarities = segmentEmbeddings.flatMap((left, leftIndex) =>
        segmentEmbeddings.slice(leftIndex + 1).map((right) =>
          cosineSimilarity(left.embedding, right.embedding)));
      return {
        cluster,
        totalSegmentCount: byCluster.get(cluster).length,
        selectedSegmentCount: spans.length,
        readySegmentCount: segmentEmbeddings.length,
        skippedSegmentCount: spans.length - segmentEmbeddings.length,
        pairCount: similarities.length,
        minimumSimilarity: similarities.length > 0 ? Math.min(...similarities) : null,
        medianSimilarity: median(similarities),
        maximumSimilarity: similarities.length > 0 ? Math.max(...similarities) : null,
      };
    });
  const usage = process.resourceUsage();
  const output = JSON.stringify({
    schemaVersion: PROTOCOL_VERSION,
    outcome: 'completed',
    embeddingDimension: extractor.dim,
    maximumSecondsPerCluster: config.maximumSecondsPerCluster,
    maximumSegmentsPerCluster: config.maximumSegmentsPerCluster,
    maximumSecondsPerSegment: config.maximumSecondsPerSegment,
    embeddedClusterCount: embeddings.size,
    skippedClusterCount: byCluster.size - embeddings.size,
    embeddedSegmentCount,
    skippedSegmentEmbeddingCount,
    supportedSimilarities,
    matches,
    segmentConsistency,
    segmentAnchorMatches,
    resources: {
      wallTimeMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      userCpuMs: usage.userCPUTime / 1_000,
      systemCpuMs: usage.systemCPUTime / 1_000,
      peakRssBytes: usage.maxRSS * 1_024,
      voluntaryContextSwitches: usage.voluntaryContextSwitches,
      involuntaryContextSwitches: usage.involuntaryContextSwitches,
      threadSetting: 2,
    },
  });
  if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) {
    throw new Error('The similarity experiment output exceeded its size limit.');
  }
  process.stdout.write(output, () => process.exit(0));
} catch (error) {
  fail(error && typeof error.message === 'string' ? error.message : undefined);
}
