'use strict';

const path = require('node:path');

const PROTOCOL_VERSION = 1;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
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
  const [modulePath, wavPath, segmentationModelPath, embeddingModelPath] =
    process.argv.slice(2);
  const paths = [modulePath, wavPath, segmentationModelPath, embeddingModelPath];
  if (paths.some((value) => typeof value !== 'string' || !path.isAbsolute(value))) {
    throw new Error('Speaker separation requires four absolute input paths.');
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
    clustering: { numClusters: -1, threshold: 0.5 },
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

  const json = JSON.stringify({
    schemaVersion: PROTOCOL_VERSION,
    outcome: 'completed',
    segments: diarizer.process(wave.samples),
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
