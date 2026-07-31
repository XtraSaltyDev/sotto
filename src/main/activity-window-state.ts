import type { ActivityMode, AppState } from '../shared/contracts';

const RUNNING_TRANSCRIPTION_STAGES = new Set([
  'preparing',
  'normalizing',
  'transcribing',
  'saving',
]);

export const isRunningActivityJob = (state: AppState): boolean =>
  state.activeJob !== null &&
  RUNNING_TRANSCRIPTION_STAGES.has(state.activeJob.stage);

/**
 * The main window can return as soon as a meeting recording stops. Dictation
 * stays collapsed through cursor insertion so the target app keeps focus.
 */
export const shouldRestoreActivityWindow = (
  mode: ActivityMode,
  state: AppState,
): boolean => {
  if (mode === 'meeting-recording') {
    return state.recording.active === null;
  }

  if (mode === 'transcribing') {
    return !isRunningActivityJob(state);
  }

  if (
    state.recording.active !== null ||
    isRunningActivityJob(state) ||
    state.activeJob === null ||
    state.activeJob.stage === 'completed'
  ) {
    return false;
  }

  // A completed dictation is held until the renderer finishes inserting it.
  // Failed/cancelled work has no target text to protect, so it can return.
  return state.activeJob.stage === 'failed' || state.activeJob.stage === 'cancelled';
};
