import { lstat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import type { TranscriptionJobSnapshot } from '../../shared/contracts';
import { validateSelectedMedia } from '../media/media-import';
import { resolveEngineRuntime } from '../runtime/engine-runtime';
import { TranscriptRepository } from '../storage/transcript-repository';
import {
  resolveRuntimeIntegrationTarget,
  SUPPORTED_RUNTIME_INTEGRATION_TARGETS,
  type RuntimeIntegrationTarget,
} from './runtime-integration-target';
import { LocalTranscriptionService } from './transcription-service';

const transcribeFixture = async (
  target: RuntimeIntegrationTarget,
  processingTimeoutMs: number,
): Promise<void> => {
  const appPath = process.cwd();
  const fixturePath = path.join(
    appPath,
    'test',
    'fixtures',
    'meeting-sample.mp4',
  );
  const fixtureStats = await lstat(fixturePath);
  const validation = validateSelectedMedia(fixturePath, fixtureStats.size);
  expect(validation.ok).toBe(true);
  if (!validation.ok) return;

  const runtime = await resolveEngineRuntime({
    appPath,
    isPackaged: false,
    platform: target.platform,
    arch: target.arch,
    environment: {},
  });
  if (!runtime.ready) {
    const unavailableComponents = Object.entries(runtime.components)
      .filter(([, component]) => component.state !== 'ready')
      .map(
        ([name, component]) =>
          `${name}=${component.state}${component.path === null ? '' : ` (${component.path})`}`,
      )
      .join(', ');
    throw new Error(
      `Native runtime ${target.id} is not ready: ${unavailableComponents}. Run npm run ${target.setupScript}.`,
    );
  }
  if (runtime.runtime.speakerDiarization === null) {
    const unavailableSpeakerComponents = Object.entries(runtime.components)
      .filter(
        ([name, component]) =>
          name.startsWith('speaker') && component.state !== 'ready',
      )
      .map(
        ([name, component]) =>
          `${name}=${component.state}${component.path === null ? '' : ` (${component.path})`}`,
      )
      .join(', ');
    throw new Error(
      `Sherpa runtime ${target.id} is not ready: ${unavailableSpeakerComponents}. Run npm run ${target.setupScript}.`,
    );
  }

  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), 'sotto-runtime-e2e-'),
  );
  const repository = new TranscriptRepository(
    path.join(temporaryRoot, 'transcripts'),
  );
  let resolveTerminal: (job: TranscriptionJobSnapshot) => void = () =>
    undefined;
  const terminal = new Promise<TranscriptionJobSnapshot>((resolve) => {
    resolveTerminal = resolve;
  });
  const service = new LocalTranscriptionService({
    runtime: runtime.runtime,
    jobsRoot: path.join(temporaryRoot, 'jobs'),
    repository,
    onJobChanged: (job) => {
      if (['completed', 'failed', 'cancelled'].includes(job.stage)) {
        resolveTerminal(job);
      }
    },
  });

  try {
    await service.initialize();
    await service.start(validation.media);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error('Timed out waiting for real transcription.')),
        processingTimeoutMs,
      );
    });
    const finalJob = await Promise.race([terminal, timeout]);
    clearTimeout(timeoutHandle);
    if (finalJob.stage !== 'completed') {
      throw new Error(
        `Real transcription ended as ${finalJob.stage} (${finalJob.errorCode ?? 'no-code'}): ${finalJob.message}`,
      );
    }
    expect(finalJob).toMatchObject({ stage: 'completed', progress: 1 });

    const records = await repository.list();
    expect(records).toHaveLength(1);
    expect(records[0].source).toMatchObject({
      name: 'meeting-sample.mp4',
      mediaKind: 'video',
    });
    expect(records[0].text).toMatch(
      /ask not what your country can do for you/i,
    );
    expect(
      records[0].segments.map((segment) => segment.text).join(' '),
    ).toMatch(/ask not what your country can do for you/i);
    expect(records[0].segments[0].startMs).toBeGreaterThanOrEqual(0);
    expect(records[0].segments.at(-1)?.endMs).toBeLessThanOrEqual(
      records[0].durationMs,
    );
    expect(records[0].speakerAnalysis?.speakers).toHaveLength(1);
    expect(
      records[0].segments.every((segment) => segment.speakerId !== null),
    ).toBe(true);
  } finally {
    await service.dispose();
    await rm(temporaryRoot, { force: true, recursive: true });
  }
};

const target = resolveRuntimeIntegrationTarget();
const currentHost = `${process.platform}-${process.arch}`;

if (target === null) {
  const supportedHosts = SUPPORTED_RUNTIME_INTEGRATION_TARGETS.map(
    (supportedTarget) => supportedTarget.id,
  ).join(', ');
  const unsupportedReason = `native runtime integration is unsupported on ${currentHost}; supported hosts: ${supportedHosts}`;

  it.skip(unsupportedReason, () => undefined);
} else {
  const processingTimeoutMs = target.platform === 'win32' ? 180_000 : 90_000;

  it(
    `transcribes and persists speech through FFmpeg, Whisper, and sherpa on ${target.id}`,
    () => transcribeFixture(target, processingTimeoutMs),
    processingTimeoutMs + 30_000,
  );
}
