import type { TranscriptionJobSnapshot } from '../shared/contracts';

/**
 * Whisper may not report measurable progress for a short, single-window clip.
 * Treat its initial handoff as indeterminate instead of presenting 20% as a
 * moving estimate.
 */
export const isIndeterminateTranscriptionProgress = (
  job: TranscriptionJobSnapshot | null,
): boolean =>
  job?.stage === 'transcribing' && job.progress <= 0.2;
