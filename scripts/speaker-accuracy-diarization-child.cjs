'use strict';

const path = require('node:path');

const PROTOCOL_VERSION = 1;
const MAX_JSON_BYTES = 32 * 1024 * 1024;

const fail = (message) => {
  const safe = typeof message === 'string' && message
    ? message.replaceAll('\0', '').slice(0, 1_000)
    : 'Unknown speaker experiment error';
  process.stderr.write(`${safe}\n`, () => process.exit(1));
};

const readConfiguration = (json) => {
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('The experiment configuration was not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The experiment configuration must be an object.');
  }
  const {
    clusteringThreshold,
    expectedSpeakerCount,
    minDurationOff,
    minDurationOn,
  } = value;
  if (
    typeof clusteringThreshold !== 'number' ||
    !Number.isFinite(clusteringThreshold) ||
    clusteringThreshold < 0.5 ||
    clusteringThreshold > 1
  ) {
    throw new Error('The clustering threshold must be from 0.5 to 1.');
  }
  if (
    expectedSpeakerCount !== null &&
    (!Number.isSafeInteger(expectedSpeakerCount) ||
      expectedSpeakerCount < 1 ||
      expectedSpeakerCount > 12)
  ) {
    throw new Error('Expected speakers must be Auto or an integer from 1 to 12.');
  }
  for (const [name, setting] of [
    ['minDurationOn', minDurationOn],
    ['minDurationOff', minDurationOff],
  ]) {
    if (
      typeof setting !== 'number' ||
      !Number.isFinite(setting) ||
      setting < 0 ||
      setting > 5
    ) {
      throw new Error(`${name} must be from 0 to 5 seconds.`);
    }
  }
  return {
    clusteringThreshold,
    expectedSpeakerCount,
    minDurationOff,
    minDurationOn,
  };
};

try {
  const [modulePath, wavPath, segmentationModelPath, embeddingModelPath, configJson] =
    process.argv.slice(2);
  const paths = [modulePath, wavPath, segmentationModelPath, embeddingModelPath];
  if (paths.some((value) => typeof value !== 'string' || !path.isAbsolute(value))) {
    throw new Error('The speaker experiment requires four absolute input paths.');
  }
  if (typeof configJson !== 'string') {
    throw new Error('The speaker experiment configuration is required.');
  }
  const config = readConfiguration(configJson);
  const started = process.hrtime.bigint();
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
    clustering: {
      numClusters: config.expectedSpeakerCount ?? -1,
      threshold: config.clusteringThreshold,
    },
    minDurationOn: config.minDurationOn,
    minDurationOff: config.minDurationOff,
  });
  if (
    !wave ||
    wave.sampleRate !== diarizer.sampleRate ||
    !(wave.samples instanceof Float32Array)
  ) {
    throw new Error('The normalized WAV did not match the speaker model sample rate.');
  }
  const segments = diarizer.process(wave.samples);
  const wallTimeMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const usage = process.resourceUsage();
  const json = JSON.stringify({
    schemaVersion: PROTOCOL_VERSION,
    outcome: 'completed',
    segments,
    resources: {
      wallTimeMs,
      userCpuMs: usage.userCPUTime / 1_000,
      systemCpuMs: usage.systemCPUTime / 1_000,
      peakRssBytes: usage.maxRSS * 1_024,
      voluntaryContextSwitches: usage.voluntaryContextSwitches,
      involuntaryContextSwitches: usage.involuntaryContextSwitches,
      threadSetting: 2,
    },
  });
  if (Buffer.byteLength(json, 'utf8') > MAX_JSON_BYTES) {
    throw new Error('The speaker experiment output exceeded its size limit.');
  }
  process.stdout.write(json, () => process.exit(0));
} catch (error) {
  fail(error && typeof error.message === 'string' ? error.message : undefined);
}
