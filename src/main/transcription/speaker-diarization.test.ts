import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_SPEAKER_DIARIZATION_JSON_BYTES,
  normalizeDiarizationSegments,
  parseDiarizationChildJson,
  runSpeakerDiarization,
  SpeakerDiarizationError,
  DEFAULT_SPEAKER_DIARIZATION_TIMEOUT_MS,
  speakerDiarizationTimeoutMs,
} from './speaker-diarization';

const temporaryRoots: string[] = [];
const childPath = path.resolve('scripts', 'speaker-diarization-child.cjs');

const makeChildOptions = async (moduleSource: string) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-speaker-child-'));
  temporaryRoots.push(root);
  const wavPath = path.join(root, 'normalized.wav');
  const segmentationModelPath = path.join(root, 'segmentation.onnx');
  const embeddingModelPath = path.join(root, 'embedding.onnx');
  const modulePath = path.join(root, 'fake-sherpa.cjs');
  await Promise.all([
    writeFile(wavPath, 'wav'),
    writeFile(segmentationModelPath, 'segmentation'),
    writeFile(embeddingModelPath, 'embedding'),
    writeFile(modulePath, moduleSource),
  ]);
  return {
    childPath,
    embeddingModelPath,
    modulePath,
    segmentationModelPath,
    wavPath,
  };
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('normalizeDiarizationSegments', () => {
  it('converts finite second offsets and sorts overlapping turns', () => {
    expect(
      normalizeDiarizationSegments([
        { start: 1.2344, end: 2.5, speaker: 1 },
        { start: 0, end: 1.8, speaker: 0 },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 1_800, cluster: 0 },
      { startMs: 1_234, endMs: 2_500, cluster: 1 },
    ]);
  });

  it.each([
    null,
    [{ start: -1, end: 1, speaker: 0 }],
    [{ start: 1, end: 0, speaker: 0 }],
    [{ start: 1, end: 1, speaker: 0 }],
    [{ start: 0, end: Number.NaN, speaker: 0 }],
    [{ start: 0, end: 1, speaker: -1 }],
    [{ start: 0, end: 1, speaker: 1.2 }],
  ])('rejects malformed native output %#', (value) => {
    expect(() => normalizeDiarizationSegments(value)).toThrow(
      SpeakerDiarizationError,
    );
  });
});

describe('speaker diarization child process', () => {
  it('parses only the bounded versioned child protocol', () => {
    expect(
      parseDiarizationChildJson(
        JSON.stringify({
          schemaVersion: 1,
          outcome: 'completed',
          segments: [{ start: 0, end: 1, speaker: 0 }],
        }),
      ),
    ).toEqual([{ startMs: 0, endMs: 1_000, cluster: 0 }]);
    expect(() => parseDiarizationChildJson('{"segments":[]}')).toThrow(
      SpeakerDiarizationError,
    );
    expect(() =>
      parseDiarizationChildJson(
        JSON.stringify({
          schemaVersion: 1,
          outcome: 'failed',
          message: 'native speaker failure',
        }),
      ),
    ).toThrow('native speaker failure');
    expect(() =>
      parseDiarizationChildJson(
        JSON.stringify({
          schemaVersion: 1,
          outcome: 'failed',
          message: 'x'.repeat(5_000),
        }),
      ),
    ).toThrow('invalid failure message');
  });

  it('runs a compatible speaker module outside the parent process', async () => {
    const options = await makeChildOptions(`
      exports.readWave = () => ({ sampleRate: 16000, samples: new Float32Array([0]) });
      exports.OfflineSpeakerDiarization = class {
        constructor(options) {
          if (options.clustering.numClusters !== -1) {
            throw new Error('automatic clustering was not preserved');
          }
          this.sampleRate = 16000;
        }
        process() { return [{ start: 1.25, end: 2.5, speaker: 3 }]; }
      };
    `);

    await expect(runSpeakerDiarization(options)).resolves.toEqual([
      { startMs: 1_250, endMs: 2_500, cluster: 3 },
    ]);
  });

  it('uses a fixed cluster count when the expected speakers are known', async () => {
    const options = await makeChildOptions(`
      exports.readWave = () => ({ sampleRate: 16000, samples: new Float32Array([0]) });
      exports.OfflineSpeakerDiarization = class {
        constructor(options) {
          if (options.clustering.numClusters !== 3) {
            throw new Error('fixed cluster count was not forwarded');
          }
          this.sampleRate = 16000;
        }
        process() { return []; }
      };
    `);

    await expect(
      runSpeakerDiarization({ ...options, expectedSpeakerCount: 3 }),
    ).resolves.toEqual([]);
  });

  it('contains a child crash and reports it as an unavailable speaker pass', async () => {
    const options = await makeChildOptions('process.exit(47);');

    await expect(runSpeakerDiarization(options)).rejects.toBeInstanceOf(
      SpeakerDiarizationError,
    );
  });

  it('kills the isolated speaker process when transcription is cancelled', async () => {
    const options = await makeChildOptions(`
      exports.readWave = () => ({ sampleRate: 16000, samples: new Float32Array([0]) });
      exports.OfflineSpeakerDiarization = class {
        constructor() { this.sampleRate = 16000; }
        process() { while (true) {} }
      };
    `);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    await expect(
      runSpeakerDiarization({ ...options, signal: controller.signal }),
    ).rejects.toThrow('cancelled');
  });

  it('times out and kills a speaker process that stops responding', async () => {
    const options = await makeChildOptions(`
      exports.readWave = () => ({ sampleRate: 16000, samples: new Float32Array([0]) });
      exports.OfflineSpeakerDiarization = class {
        constructor() { this.sampleRate = 16000; }
        process() { while (true) {} }
      };
    `);

    await expect(
      runSpeakerDiarization({ ...options, timeoutMs: 100 }),
    ).rejects.toThrow('timed out');
  });

  it('removes inherited loader variables from the isolated speaker process', async () => {
    vi.stubEnv('DYLD_SOTTO_TEST', '/tmp/untrusted.dylib');
    const options = await makeChildOptions(`
      if (process.env.DYLD_SOTTO_TEST) throw new Error('unsafe loader environment');
      exports.readWave = () => ({ sampleRate: 16000, samples: new Float32Array([0]) });
      exports.OfflineSpeakerDiarization = class {
        constructor() { this.sampleRate = 16000; }
        process() { return []; }
      };
    `);

    await expect(runSpeakerDiarization(options)).resolves.toEqual([]);
  });

  it('rejects invalid timeout values before launching a child', async () => {
    const options = await makeChildOptions('');

    await expect(
      runSpeakerDiarization({ ...options, timeoutMs: 0 }),
    ).rejects.toThrow('positive safe integer');
  });

  it('rejects an invalid expected speaker count before launching a child', async () => {
    const options = await makeChildOptions('');

    await expect(
      runSpeakerDiarization({ ...options, expectedSpeakerCount: 0 as never }),
    ).rejects.toThrow('integer from 1 to 12');
  });

  it('kills a child whose JSON output exceeds the protocol bound', async () => {
    const options = await makeChildOptions(`
      process.stdout.write('x'.repeat(${MAX_SPEAKER_DIARIZATION_JSON_BYTES + 1}));
      exports.readWave = () => ({ sampleRate: 16000, samples: new Float32Array([0]) });
      exports.OfflineSpeakerDiarization = class {
        constructor() { this.sampleRate = 16000; }
        process() { return []; }
      };
    `);

    await expect(runSpeakerDiarization(options)).rejects.toThrow('size limit');
  });
});

describe('speakerDiarizationTimeoutMs', () => {
  it('grows with audio duration and stays bounded', () => {
    expect(speakerDiarizationTimeoutMs(null)).toBe(
      DEFAULT_SPEAKER_DIARIZATION_TIMEOUT_MS,
    );
    expect(speakerDiarizationTimeoutMs(60)).toBe(
      DEFAULT_SPEAKER_DIARIZATION_TIMEOUT_MS + 30_000,
    );
    // Two hours of audio gets a full hour beyond the floor.
    expect(speakerDiarizationTimeoutMs(7_200)).toBe(
      DEFAULT_SPEAKER_DIARIZATION_TIMEOUT_MS + 3_600_000,
    );
    // The cap holds for absurd inputs.
    expect(speakerDiarizationTimeoutMs(1e9)).toBe(2 * 60 * 60 * 1_000);
    expect(speakerDiarizationTimeoutMs(-5)).toBe(
      DEFAULT_SPEAKER_DIARIZATION_TIMEOUT_MS,
    );
  });
});
