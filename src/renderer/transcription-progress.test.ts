import { describe, expect, it } from 'vitest';

import type { TranscriptionJobSnapshot } from '../shared/contracts';
import { isIndeterminateTranscriptionProgress } from './transcription-progress';

const job = (
  stage: TranscriptionJobSnapshot['stage'],
  progress: number,
): TranscriptionJobSnapshot => ({
  id: '00000000-0000-4000-8000-000000000001',
  sourceName: 'Meeting.webm',
  stage,
  progress,
  startedAt: '2026-07-29T12:00:00.000Z',
  message: 'Working locally.',
});

describe('isIndeterminateTranscriptionProgress', () => {
  it.each([
    ['transcribing', 0.2, true],
    ['normalizing', 0.2, false],
    ['transcribing', 0.2001, false],
    ['saving', 0.96, false],
  ] as const)('%s at %s is indeterminate: %s', (stage, progress, expected) => {
    expect(isIndeterminateTranscriptionProgress(job(stage, progress))).toBe(
      expected,
    );
  });

  it('treats an absent job as determinate', () => {
    expect(isIndeterminateTranscriptionProgress(null)).toBe(false);
  });
});
