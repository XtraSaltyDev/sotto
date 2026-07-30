import { describe, expect, it } from 'vitest';

import type {
  SavedRecordingSummary,
  TranscriptSummary,
} from '../shared/contracts';
import { mergeMeetingLibraryItems } from './meeting-library';

const transcript = (
  id: string,
  createdAt: string,
): TranscriptSummary => ({
  id,
  title: `Transcript ${id}`,
  sourceName: `${id}.webm`,
  createdAt,
  durationMs: 60_000,
  language: 'en',
  preview: 'A transcript preview.',
  tags: [],
});

const recording = (
  id: string,
  completedAt: string,
  transcriptId?: string,
): SavedRecordingSummary => ({
  id,
  sourceName: `${id}.webm`,
  startedAt: completedAt,
  completedAt,
  sizeBytes: 1_024,
  transcriptionState: transcriptId ? 'completed' : 'ready',
  message: transcriptId ? 'Transcript ready.' : 'Ready to transcribe.',
  transcriptId,
});

describe('meeting library items', () => {
  it('combines a transcript and its retained recording into one meeting', () => {
    const linkedRecording = recording(
      'recording-1',
      '2026-07-30T14:00:00.000Z',
      'transcript-1',
    );

    expect(
      mergeMeetingLibraryItems(
        [transcript('transcript-1', '2026-07-30T14:01:00.000Z')],
        [linkedRecording],
      ),
    ).toEqual([
      expect.objectContaining({
        recording: linkedRecording,
        transcript: expect.objectContaining({ id: 'transcript-1' }),
      }),
    ]);
  });

  it('keeps recordings that do not currently have a transcript', () => {
    const savedRecording = recording(
      'recording-1',
      '2026-07-30T14:00:00.000Z',
    );

    expect(mergeMeetingLibraryItems([], [savedRecording])).toEqual([
      expect.objectContaining({
        recording: savedRecording,
        transcript: null,
      }),
    ]);
  });

  it('sorts transcript and recording-only meetings newest first', () => {
    const items = mergeMeetingLibraryItems(
      [transcript('older', '2026-07-29T12:00:00.000Z')],
      [recording('newer', '2026-07-30T12:00:00.000Z')],
    );

    expect(items.map((item) => item.key)).toEqual([
      'recording:newer',
      'transcript:older',
    ]);
  });
});
