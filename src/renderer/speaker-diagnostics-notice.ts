import type { TranscriptDetail } from '../shared/contracts';

export interface SpeakerDiagnosticsNotice {
  headline: string;
  detail: string;
  /** True when re-transcribing with an expected speaker count would help. */
  suggestsExpectedSpeakers: boolean;
}

/**
 * Explains why a transcript has no speaker labels, in the cases where Sotto
 * knows the answer. Silence would be worse than a plain explanation: a
 * transcript that simply lacks labels looks like one where nobody was
 * identified, not one where identification was attempted and rejected.
 */
export const speakerDiagnosticsNotice = (
  transcript: Pick<TranscriptDetail, 'speakerAnalysis' | 'speakerDiagnostics'>,
): SpeakerDiagnosticsNotice | null => {
  const diagnostics = transcript.speakerDiagnostics;
  // Labels present, or nothing recorded to explain: say nothing.
  if (!diagnostics || transcript.speakerAnalysis !== null) return null;

  if (diagnostics.outcome === 'over-fragmented') {
    return {
      headline: 'Speaker labels were not saved for this recording.',
      detail:
        `Sotto separated the audio into ${diagnostics.clusterCount.toLocaleString()} distinct voices, ` +
        'far more than a meeting has. That usually means one person came through ' +
        'at different volumes or over a varying connection, so the same voice was ' +
        'split several ways. Showing the loudest few would name fragments rather ' +
        'than people, so no labels were saved.',
      suggestsExpectedSpeakers: true,
    };
  }

  if (diagnostics.outcome === 'no-reliable-speakers') {
    return {
      headline: 'Speaker labels were not saved for this recording.',
      detail:
        'Sotto could not match any voice to enough of the transcript to label it ' +
        'confidently. The transcript text itself is unaffected.',
      suggestsExpectedSpeakers: true,
    };
  }

  return null;
};

export const SPEAKER_RETRY_HINT =
  'Set Expected speakers to the number of people in the meeting, then use Re-transcribe.';
