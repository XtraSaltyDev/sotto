import { EventEmitter } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  LiveRecordingError,
  LiveRecordingService,
  MAX_LIVE_RECORDING_CHUNK_BYTES,
} from './live-recording-service';

const ABANDONED_ID = '00000000-0000-4000-8000-000000000000';
const RECOVERED_ID = '11111111-1111-4111-8111-111111111111';

const makeService = async (
  overrides: Partial<ConstructorParameters<typeof LiveRecordingService>[0]> = {},
) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sotto-live-recording-'));
  const changes: Array<string | null> = [];
  const service = new LiveRecordingService({
    recordingsRoot: root,
    onRecordingChanged: (recording) => changes.push(recording?.id ?? null),
    minimumFreeBytes: 0,
    getAvailableBytes: async () => null,
    ...overrides,
  });
  await service.initialize();
  return { changes, root, service };
};

const finalize = async (
  service: LiveRecordingService,
  contents = 'webm test bytes',
) => {
  const recording = await service.start();
  const payload = new TextEncoder().encode(contents);
  await expect(service.append(recording.id, payload)).resolves.toEqual({
    outcome: 'accepted',
    bytesWritten: payload.byteLength,
  });
  const media = await service.finish(recording.id);
  return { media, payload, recording };
};

class FakeRecordingStream extends EventEmitter {
  constructor(
    private readonly behavior: 'disk-full' | 'open-stall' | 'stall',
  ) {
    super();
    if (behavior !== 'open-stall') queueMicrotask(() => this.emit('open'));
  }

  write(
    chunk: Uint8Array,
    callback?: (error?: Error | null) => void,
  ): boolean {
    void chunk;
    void callback;
    if (this.behavior === 'disk-full') {
      const error = Object.assign(new Error('no space left'), { code: 'ENOSPC' });
      queueMicrotask(() => this.emit('error', error));
      return true;
    }
    return false;
  }

  end(callback?: () => void): this {
    callback?.();
    queueMicrotask(() => this.emit('close'));
    return this;
  }

  destroy(error?: Error): this {
    queueMicrotask(() => {
      if (error && this.listenerCount('error') > 0) this.emit('error', error);
      this.emit('close');
    });
    return this;
  }
}

describe('LiveRecordingService', () => {
  it('atomically finalizes a private durable WebM and retains it after restart', async () => {
    const { changes, root, service } = await makeService();
    const { media, payload, recording } = await finalize(service);

    expect(media).toMatchObject({
      name: recording.sourceName,
      recordingId: recording.id,
      sourceType: 'recording',
      cleanupAfterTranscription: false,
    });
    expect(path.basename(media.path)).toBe('recording.webm');
    expect(await readFile(media.path)).toEqual(Buffer.from(payload));
    expect(changes).toEqual([recording.id, recording.id, null]);

    if (process.platform !== 'win32') {
      expect((await stat(path.dirname(media.path))).mode & 0o777).toBe(0o700);
      expect((await stat(media.path)).mode & 0o777).toBe(0o600);
    }

    await service.markTranscriptionCompleted(
      recording.id,
      recording.id,
      recording.id,
    );
    if (process.platform !== 'win32') {
      await chmod(path.dirname(media.path), 0o755);
      await chmod(media.path, 0o644);
      await chmod(path.join(path.dirname(media.path), 'metadata.json'), 0o644);
    }
    const restarted = new LiveRecordingService({
      recordingsRoot: root,
      onRecordingChanged: () => undefined,
      minimumFreeBytes: 0,
    });
    await restarted.initialize();

    await expect(restarted.listSavedRecordings()).resolves.toEqual([
      expect.objectContaining({
        id: recording.id,
        transcriptionState: 'completed',
        transcriptId: recording.id,
      }),
    ]);
    await expect(readFile(media.path)).resolves.toEqual(Buffer.from(payload));
    if (process.platform !== 'win32') {
      expect((await stat(path.dirname(media.path))).mode & 0o777).toBe(0o700);
      expect((await stat(media.path)).mode & 0o777).toBe(0o600);
      expect(
        (await stat(path.join(path.dirname(media.path), 'metadata.json'))).mode &
          0o777,
      ).toBe(0o600);
    }
  });

  it('keeps failed and cancelled transcription recordings available for retry', async () => {
    const { service } = await makeService();
    const failed = await finalize(service, 'failed recording');
    await service.markTranscriptionFailed(
      failed.recording.id,
      failed.recording.id,
      'transcription-failed',
      'The local engine failed.',
    );

    const failedSummary = (await service.listSavedRecordings())[0];
    expect(failedSummary).toMatchObject({
      id: failed.recording.id,
      transcriptionState: 'failed',
      errorCode: 'transcription-failed',
    });
    await expect(readFile(failed.media.path)).resolves.toBeTruthy();
    await expect(
      service.getMediaForTranscription(failed.recording.id),
    ).resolves.toMatchObject({
      path: failed.media.path,
      recordingId: failed.recording.id,
    });

    await service.markTranscribing(failed.recording.id, failed.recording.id);
    await service.markTranscriptionCancelled(
      failed.recording.id,
      failed.recording.id,
    );
    expect((await service.listSavedRecordings())[0]).toMatchObject({
      transcriptionState: 'cancelled',
    });
    await expect(readFile(failed.media.path)).resolves.toBeTruthy();
  });

  it('recovers interrupted jobs and finalized files while cleaning abandoned partials', async () => {
    const { root, service } = await makeService();
    const interrupted = await finalize(service, 'interrupted job');
    await service.markTranscribing(
      interrupted.recording.id,
      interrupted.recording.id,
    );

    const abandonedDirectory = path.join(root, ABANDONED_ID);
    await mkdir(abandonedDirectory, { recursive: true });
    await writeFile(
      path.join(abandonedDirectory, 'recording.partial.webm'),
      'unfinished',
      { mode: 0o600 },
    );

    const recoveredDirectory = path.join(root, RECOVERED_ID);
    await mkdir(recoveredDirectory, { recursive: true });
    const recoveredPath = path.join(recoveredDirectory, 'recording.webm');
    await writeFile(recoveredPath, 'durable orphan', { mode: 0o600 });
    await writeFile(path.join(recoveredDirectory, 'metadata.json'), '{broken');

    const restarted = new LiveRecordingService({
      recordingsRoot: root,
      onRecordingChanged: () => undefined,
      minimumFreeBytes: 0,
    });
    await restarted.initialize();
    const summaries = await restarted.listSavedRecordings();

    expect(
      summaries.find((recording) => recording.id === interrupted.recording.id),
    ).toMatchObject({
      transcriptionState: 'failed',
      errorCode: 'transcription-failed',
    });
    expect(
      summaries.find((recording) => recording.id === RECOVERED_ID),
    ).toMatchObject({
      transcriptionState: 'ready',
    });
    await expect(stat(abandonedDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(recoveredPath, 'utf8')).resolves.toBe('durable orphan');
  });

  it('exports by descriptor and deletes only after an explicit delete call', async () => {
    const { service } = await makeService();
    const { media, recording } = await finalize(service, 'export me');

    await expect(
      service.getExportDescriptor(recording.id),
    ).resolves.toEqual({
      fileName: recording.sourceName,
      path: media.path,
    });
    await expect(readFile(media.path, 'utf8')).resolves.toBe('export me');

    await expect(service.delete(recording.id)).resolves.toBe(true);
    await expect(service.delete(recording.id)).resolves.toBe(false);
    await expect(stat(media.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes a cancelled in-progress partial and rejects oversized chunks', async () => {
    const { root, service } = await makeService();
    const recording = await service.start();
    const oversized = new Uint8Array(MAX_LIVE_RECORDING_CHUNK_BYTES + 1);

    await expect(service.append(recording.id, oversized)).resolves.toEqual({
      outcome: 'rejected',
      reason: 'The recording chunk was larger than the allowed limit.',
      code: 'recording-failed',
    });
    await expect(service.cancel(recording.id)).resolves.toBe(true);
    await expect(stat(path.join(root, recording.id))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a new recording when the free-space reserve is unavailable', async () => {
    const { service } = await makeService({
      minimumFreeBytes: 512,
      getAvailableBytes: async () => 511,
    });

    await expect(service.start()).rejects.toMatchObject({
      code: 'storage-full',
    });
  });

  it('maps asynchronous disk-full errors and clears the failed partial', async () => {
    const { root, service } = await makeService({
      createStream: () => new FakeRecordingStream('disk-full'),
      writeWaitMs: 50,
    });
    const recording = await service.start();

    await expect(
      service.append(recording.id, new Uint8Array([1])),
    ).rejects.toMatchObject({
      code: 'storage-full',
    });
    expect(service.getActive()).toBeNull();
    await expect(stat(path.join(root, recording.id))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('times out a stream that never opens and clears its partial directory', async () => {
    const { root, service } = await makeService({
      createStream: () => new FakeRecordingStream('open-stall'),
      writeWaitMs: 20,
    });

    await expect(service.start()).rejects.toMatchObject({
      code: 'recording-failed',
      message: 'Sotto timed out while opening the private recording file.',
    });
    expect(service.getActive()).toBeNull();
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it('times out a stalled backpressured write instead of hanging', async () => {
    const { service } = await makeService({
      createStream: () => new FakeRecordingStream('stall'),
      writeWaitMs: 20,
    });
    const recording = await service.start();

    await expect(
      service.append(recording.id, new Uint8Array([1])),
    ).rejects.toBeInstanceOf(LiveRecordingError);
    expect(service.getActive()).toBeNull();
  });
});
