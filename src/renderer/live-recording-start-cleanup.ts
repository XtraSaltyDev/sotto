import type { StartLiveRecordingResult } from '../shared/contracts';

export interface StoppableMediaStream {
  getTracks(): ReadonlyArray<{ stop(): void }>;
}

export interface AbandonedLiveRecordingStart {
  cancelRecording: (recordingId: string) => Promise<unknown>;
  desktopCapture: Promise<StoppableMediaStream> | null;
  desktopStreamClaimed: boolean;
  startRecording: Promise<StartLiveRecordingResult> | null;
  startResultHandled: boolean;
}

/**
 * Reclaims results that arrive after the renderer has abandoned its start path.
 * Claimed results remain owned by the normal catch/stop cleanup path.
 */
export const releaseAbandonedLiveRecordingStart = async (
  options: AbandonedLiveRecordingStart,
): Promise<void> => {
  const cleanups: Promise<void>[] = [];

  if (options.desktopCapture && !options.desktopStreamClaimed) {
    cleanups.push(
      options.desktopCapture
        .then((stream) => {
          stream.getTracks().forEach((track) => track.stop());
        })
        .catch(() => undefined),
    );
  }

  if (options.startRecording && !options.startResultHandled) {
    cleanups.push(
      options.startRecording
        .then(async (result) => {
          if (result.outcome === 'started') {
            await options.cancelRecording(result.recording.id);
          }
        })
        .catch(() => undefined),
    );
  }

  await Promise.all(cleanups);
};
