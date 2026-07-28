import { lstat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import type { TranscriptionJobSnapshot } from '../../shared/contracts';
import { validateSelectedMedia } from '../media/media-import';
import { resolveEngineRuntime } from '../runtime/engine-runtime';
import { TranscriptRepository } from '../storage/transcript-repository';
import { LocalTranscriptionService } from './transcription-service';

const runRuntimeTest = process.env.SOTTO_RUNTIME_INTEGRATION === '1' ? it : it.skip;

runRuntimeTest(
  'transcribes and persists speech from an AAC-in-MP4 meeting fixture',
  async () => {
    const appPath = process.cwd();
    const fixturePath = path.join(appPath, 'test', 'fixtures', 'meeting-sample.mp4');
    const fixtureStats = await lstat(fixturePath);
    const validation = validateSelectedMedia(fixturePath, fixtureStats.size);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;

    const runtime = await resolveEngineRuntime({
      appPath,
      isPackaged: false,
      platform: 'darwin',
      arch: 'arm64',
      environment: {},
    });
    expect(runtime.ready).toBe(true);
    if (!runtime.ready) return;

    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'sotto-runtime-e2e-'));
    const repository = new TranscriptRepository(path.join(temporaryRoot, 'transcripts'));
    let resolveTerminal: (job: TranscriptionJobSnapshot) => void = () => undefined;
    const terminal = new Promise<TranscriptionJobSnapshot>((resolve) => {
      resolveTerminal = resolve;
    });
    const service = new LocalTranscriptionService({
      runtime: runtime.runtime,
      jobsRoot: path.join(temporaryRoot, 'jobs'),
      repository,
      onJobChanged: (job) => {
        if (['completed', 'failed', 'cancelled'].includes(job.stage)) resolveTerminal(job);
      },
    });

    try {
      await service.initialize();
      await service.start(validation.media);
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('Timed out waiting for real transcription.')),
          90_000,
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
      expect(records[0].text).toMatch(/ask not what your country can do for you/i);
      expect(records[0].segments[0]).toMatchObject({ startMs: 0, endMs: 11_000 });
    } finally {
      await service.dispose();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  },
  120_000,
);
