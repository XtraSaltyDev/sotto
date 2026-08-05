import type { AppState } from '../shared/contracts';

/**
 * What the home screen will let the user start right now. These rules were
 * three near-identical inline conditions; stated once, the one real difference
 * between them — importing tolerates a running transcription, capture does not
 * — is visible rather than buried in repeated negations.
 */

export interface HomeBusyState {
  /** A transcription job is running. */
  running: boolean;
  isSelecting: boolean;
  isStartingRecording: boolean;
  isStoppingRecording: boolean;
}

export interface HomeCapabilities {
  canImport: boolean;
  canRecord: boolean;
  canDictate: boolean;
}

export const homeCapabilities = (
  appState: AppState | null,
  busy: HomeBusyState,
): HomeCapabilities => {
  const engineReady = appState?.engine.state === 'ready';
  // Any capture attempt is blocked while one is starting, stopping, running,
  // or while a native picker is open.
  const captureIdle =
    !appState?.recording.active &&
    !busy.isStartingRecording &&
    !busy.isStoppingRecording &&
    !busy.isSelecting;
  const capabilityState = appState?.recording.capability.state;
  return {
    // Importing stays available while a transcription runs: extra files join
    // the sequential import queue.
    canImport: engineReady && captureIdle,
    canRecord:
      engineReady &&
      (capabilityState === 'ready' || capabilityState === 'setup-required') &&
      !busy.running &&
      captureIdle,
    canDictate: engineReady && !busy.running && captureIdle,
  };
};
