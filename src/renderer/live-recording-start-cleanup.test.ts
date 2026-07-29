import { describe, expect, it, vi } from 'vitest';

import type { StartLiveRecordingResult } from '../shared/contracts';
import {
  releaseAbandonedLiveRecordingStart,
  type StoppableMediaStream,
} from './live-recording-start-cleanup';

const RECORDING_ID = '32ce6fee-8f3e-4f03-a266-46d6c00ef08c';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
};

const acceptedRecording = (): StartLiveRecordingResult => ({
  outcome: 'started',
  recording: {
    bytesWritten: 0,
    id: RECORDING_ID,
    sourceName: 'Live meeting.webm',
    startedAt: '2026-07-29T11:00:00.000Z',
  },
});

describe('releaseAbandonedLiveRecordingStart', () => {
  it('reclaims desktop and recording results that resolve after abandonment', async () => {
    const desktop = deferred<StoppableMediaStream>();
    const start = deferred<StartLiveRecordingResult>();
    const stop = vi.fn();
    const cancelRecording = vi.fn(async () => undefined);

    const cleanup = releaseAbandonedLiveRecordingStart({
      cancelRecording,
      desktopCapture: desktop.promise,
      desktopStreamClaimed: false,
      startRecording: start.promise,
      startResultHandled: false,
    });

    desktop.resolve({ getTracks: () => [{ stop }] });
    start.resolve(acceptedRecording());
    await cleanup;

    expect(stop).toHaveBeenCalledOnce();
    expect(cancelRecording).toHaveBeenCalledOnce();
    expect(cancelRecording).toHaveBeenCalledWith(RECORDING_ID);
  });

  it('does not clean resources already claimed by the normal start path', async () => {
    const stop = vi.fn();
    const cancelRecording = vi.fn(async () => undefined);

    await releaseAbandonedLiveRecordingStart({
      cancelRecording,
      desktopCapture: Promise.resolve({ getTracks: () => [{ stop }] }),
      desktopStreamClaimed: true,
      startRecording: Promise.resolve(acceptedRecording()),
      startResultHandled: true,
    });

    expect(stop).not.toHaveBeenCalled();
    expect(cancelRecording).not.toHaveBeenCalled();
  });

  it('stops an unclaimed desktop stream without recancelling a handled start', async () => {
    const stop = vi.fn();
    const cancelRecording = vi.fn(async () => undefined);

    await releaseAbandonedLiveRecordingStart({
      cancelRecording,
      desktopCapture: Promise.resolve({ getTracks: () => [{ stop }] }),
      desktopStreamClaimed: false,
      startRecording: Promise.resolve(acceptedRecording()),
      startResultHandled: true,
    });

    expect(stop).toHaveBeenCalledOnce();
    expect(cancelRecording).not.toHaveBeenCalled();
  });

  it('does not cancel a late start result that was rejected', async () => {
    const cancelRecording = vi.fn(async () => undefined);

    await releaseAbandonedLiveRecordingStart({
      cancelRecording,
      desktopCapture: null,
      desktopStreamClaimed: false,
      startRecording: Promise.resolve({
        code: 'recording-failed',
        outcome: 'rejected',
        reason: 'Synthetic rejection.',
      }),
      startResultHandled: false,
    });

    expect(cancelRecording).not.toHaveBeenCalled();
  });
});
